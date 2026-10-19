/**
 * Attempt directory removal (docs/specs/feedback-triage-and-execution.md §4 step 3: "Both clones
 * are removed by the executor through SafeFsExecutor when the attempt ends").
 *
 * Attempt clones are copies of the instar source, which SourceTreeGuard protects. The executor
 * therefore first MOVES the tree into its own trash directory under the agent's runtime state
 * (`.instar/state/...`, the guard's documented runtime-state carve-out) and only then deletes it
 * through SafeFsExecutor — so the guard is never weakened and the delete stays audited.
 */
import fs from 'node:fs';
import path from 'node:path';
import { shortTmpDir } from './ConfinedRunner.js';
import { createHash, randomUUID } from 'node:crypto';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';

/** Remove `target` (a directory or file the executor created). Missing targets are a no-op. */
export function removeAttemptTree(target: string, trashRoot: string, operation: string): void {
  let exists = false;
  try { fs.lstatSync(target); exists = true; } catch { exists = false; } // @silent-fallback-ok: an already-absent tree needs no removal
  if (!exists) return;
  fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
  const parked = path.join(trashRoot, `${path.basename(target)}-${randomUUID()}`);
  try {
    fs.renameSync(target, parked);
  } catch (error) {
    // The attempt's temp directory lives under the system temp root (see shortAttemptTmpDir), which
    // on Linux is often a separate tmpfs: a rename across devices fails EXDEV. Remove in place then.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    SafeFsExecutor.safeRmSync(target, { recursive: true, force: true, operation });
    return;
  }
  SafeFsExecutor.safeRmSync(parked, { recursive: true, force: true, operation });
}

/** Basename shape of an attempt's short temp directory (see shortAttemptTmpDir). */
export const SHORT_ATTEMPT_TMP_RE = /^fb-[0-9a-f]{10}$/;

/**
 * The attempt's temp directory: a SHORT, REAL path under the system temp root, never under the
 * agent home. Both properties are load-bearing, measured live on the Mac Studio 2026-10-19
 * (Claude Code 2.1.303):
 *  - Claude Code honours CLAUDE_CODE_TMPDIR for its sandbox temp dir (shell bookkeeping, the
 *    per-call `cwd-<id>` file, unix sockets) only while the override is short (its own warning
 *    says ≤ ~30 bytes, an AF_UNIX path limit); a longer override silently falls back to
 *    `/tmp/claude-<uid>`, which the confinement policy does not allow, so EVERY Bash call in a
 *    confined session exited 1 (an 83-byte `.worktrees/<attempt>-tmp` path).
 *  - The sandbox runtime matches real paths: `/tmp/<dir>` in the allow list did not admit the
 *    directory on macOS (where /tmp is a link to /private/tmp); `/private/tmp/<dir>` did.
 * Measured with the 22-byte `/private/tmp/fb-probe02`: git and echo exit 0, writes land inside
 * the directory, and a write to `/tmp/feedback-canary-*` is still refused. The name is derived
 * from the attempt, so every path reader recomputes the same directory.
 */
export function shortAttemptTmpDir(initiativeId: string, attempt: number, root: string = shortTmpRealRoot()): string {
  const digest = createHash('sha256').update(`${initiativeId}-a${attempt}`).digest('hex').slice(0, 10);
  return path.join(root, `fb-${digest}`);
}

/** The real path of the short system temp root (`/private/tmp` on macOS, `/tmp` elsewhere). */
export function shortTmpRealRoot(): string {
  const candidate = shortTmpDir();
  try { return fs.realpathSync(candidate); } catch { return candidate; } // @silent-fallback-ok: an unresolvable root is still the shortest available
}

/** Empty the trash directory (leftovers from a crash between move and delete). Bounded. */
export function sweepTrash(trashRoot: string, operation: string, limit = 20): number {
  let names: string[] = [];
  try { names = fs.readdirSync(trashRoot); } catch { return 0; } // @silent-fallback-ok: no trash directory yet
  let removed = 0;
  for (const name of names.slice(0, limit)) {
    try { SafeFsExecutor.safeRmSync(path.join(trashRoot, name), { recursive: true, force: true, operation }); removed++; } catch { /* @silent-fallback-ok: retried on the next sweep */ }
  }
  return removed;
}
