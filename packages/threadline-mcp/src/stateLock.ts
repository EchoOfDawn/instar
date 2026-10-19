/**
 * One threadline-mcp per state directory owns pairing (Echo's review of #2192, SEC-5).
 *
 * Claude Desktop and every Claude Code session each start their own threadline-mcp, all on one
 * state directory and one identity. Without coordination they race on the pairing stores and the
 * relay. The owner holds `<stateDir>/threadline/owner.lock` (its pid, created exclusively); a lock
 * whose pid is no longer running is stale and is taken over. Only the owner pairs and writes
 * pairing state; the others refuse pairing and credentials and re-read
 * pins from disk for every message.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface StateLock {
  held: boolean;
  holderPid: number | null;
  release(): void;
  /** The owner records the app it serves (the MCP client's name), so a refusal can name the app, never a pid. */
  setApp(name: string): void;
  /** The app named by the current owner, read fresh from the lock, or null. */
  holderApp(): string | null;
}

/**
 * Lock file format: the pid on the first line, optionally the app's name on the second. A lock that holds
 * only a pid (threadline-mcp 0.5.x) is still read, and a 0.5.x reader's parseInt still finds the pid.
 */
export function parseLock(text: string): { pid: number | null; app: string | null } {
  const [first, ...rest] = text.split('\n');
  const pid = Number.parseInt(first.trim(), 10);
  const app = rest.join(' ').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100);
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, app: app || null };
}
const clean = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100);

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export function acquireStateLock(stateDir: string, pid = process.pid): StateLock {
  const file = path.join(stateDir, 'threadline', 'owner.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx', mode: 0o600 });
      const ours = () => { try { return parseLock(fs.readFileSync(file, 'utf8')).pid === pid; } catch { return false; } };
      return {
        held: true, holderPid: pid,
        release: () => { try { if (ours()) fs.unlinkSync(file); } catch { /* gone */ } },
        setApp: (name: string) => {
          const n = clean(name);
          if (!n || !ours()) return;
          const tmp = `${file}.${pid}.tmp`;
          try { fs.writeFileSync(tmp, `${pid}\n${n}`, { mode: 0o600 }); fs.renameSync(tmp, file); } catch { try { fs.unlinkSync(tmp); } catch { /* none */ } }
        },
        holderApp: () => { try { return parseLock(fs.readFileSync(file, 'utf8')).app; } catch { return null; } },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = parseLock(fs.readFileSync(file, 'utf8')).pid;
      if (holder !== null && holder !== pid && alive(holder)) return notHeld(file, holder);
      // Stale (dead holder or unreadable): remove and try once more. A racing starter that wins
      // the exclusive create in between is respected.
      try { fs.unlinkSync(file); } catch { /* someone else removed it */ }
    }
  }
  let holder: number | null = null;
  try { holder = parseLock(fs.readFileSync(file, 'utf8')).pid; } catch { /* gone */ }
  return notHeld(file, holder);
}

function notHeld(file: string, holderPid: number | null): StateLock {
  return {
    held: false, holderPid, release: () => {}, setApp: () => {},
    holderApp: () => { try { return parseLock(fs.readFileSync(file, 'utf8')).app; } catch { return null; } },
  };
}
