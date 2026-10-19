/**
 * One threadline-mcp per state directory owns pairing (Echo's review of #2192, SEC-5).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireStateLock, parseLock } from '../../../packages/threadline-mcp/src/stateLock.js';
import { notOwnerRefusal } from '../../../packages/threadline-mcp/src/pairTools.js';
import { StandalonePairing } from '../../../packages/threadline-mcp/src/pairing.js';
import { generateIdentityKeyPair } from '@sagemindai/threadline-core';

describe('state lock', () => {
  it('the first instance owns it; a second live one does not; a dead holder is taken over; release only removes our own', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-lock-'));
    const a = acquireStateLock(dir, process.pid);
    expect(a.held).toBe(true);
    const b = acquireStateLock(dir, process.ppid); // a different, live process
    expect(b).toMatchObject({ held: false, holderPid: process.pid });
    b.release();
    expect(fs.readFileSync(path.join(dir, 'threadline', 'owner.lock'), 'utf8')).toBe(String(process.pid));
    a.release();
    expect(fs.existsSync(path.join(dir, 'threadline', 'owner.lock'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'threadline', 'owner.lock'), '2147483646'); // no such process
    expect(acquireStateLock(dir, process.pid).held).toBe(true);
    expect(fs.statSync(path.join(dir, 'threadline', 'owner.lock')).mode & 0o077).toBe(0);
  });

  it('the owner records its app name; a non-owner reads it fresh; a pid-only lock (0.5.x) is still read (R2-2)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-lock-app-'));
    const file = path.join(dir, 'threadline', 'owner.lock');
    const a = acquireStateLock(dir, process.pid);
    const b = acquireStateLock(dir, process.ppid);
    expect(b.held).toBe(false);
    expect(b.holderApp()).toBeNull(); // nothing recorded yet
    a.setApp('Claude\nDesktop\u0007');
    expect(b.holderApp()).toBe('Claude Desktop');
    expect(fs.readFileSync(file, 'utf8')).toBe(`${process.pid}\nClaude Desktop`);
    expect(Number.parseInt(fs.readFileSync(file, 'utf8'), 10)).toBe(process.pid); // what a 0.5.x reader does
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    b.setApp('impostor'); // a non-owner cannot rename the owner
    expect(b.holderApp()).toBe('Claude Desktop');
    // A third instance still sees the live owner through the two-line format.
    expect(acquireStateLock(dir, process.ppid)).toMatchObject({ held: false, holderPid: process.pid });
    a.release();
    expect(fs.existsSync(file)).toBe(false);
    // An old pid-only lock held by a live process is respected, with no app name.
    fs.writeFileSync(file, String(process.ppid));
    const c = acquireStateLock(dir, process.pid);
    expect(c).toMatchObject({ held: false, holderPid: process.ppid });
    expect(c.holderApp()).toBeNull();
    expect(parseLock('123')).toEqual({ pid: 123, app: null });
    expect(parseLock('123\nCursor')).toEqual({ pid: 123, app: 'Cursor' });
    expect(parseLock('garbage')).toEqual({ pid: null, app: null });
  });

  it('the non-owner refusal names the app in plain words, never a pid or a setting', () => {
    expect(notOwnerRefusal('Claude Desktop')).toBe('Tell your person this, in these words: "Pairing is open in Claude Desktop. Finish it there, or close that app and try again."');
    expect(notOwnerRefusal(null)).toContain('Pairing is open in another app.');
    for (const t of [notOwnerRefusal('x'), notOwnerRefusal(null)]) for (const banned of ['pid', 'terminal', 'npx', 'THREADLINE_', 'command']) expect(t).not.toContain(banned);
  });
});

type Env = Record<string, unknown> & { to: string };
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('a threadline-mcp that does not own pairing', () => {
  function mk(name: string, wire: { out: Env[] }, opts: { dir?: string; kp?: { publicKey: Buffer; privateKey: Buffer }; owns?: boolean } = {}) {
    const k = opts.kp ?? generateIdentityKeyPair();
    const fp = k.publicKey.subarray(0, 16).toString('hex');
    const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `tl-own-${name}-`));
    const p = new StandalonePairing({ stateDir: dir, identity: { fp, publicKey: k.publicKey, privateKey: k.privateKey }, ownName: () => ({ owner: 'o', agent: name }), sendEnvelope: (e) => wire.out.push(e as Env), relayHttpBase: null, ownsPairing: opts.owns });
    return { fp, p, dir, k };
  }
  async function pump(wire: { out: Env[] }, agents: Array<ReturnType<typeof mk>>) {
    while (wire.out.length) { const e = wire.out.shift()!; const to = agents.find((a) => a.fp === e.to); if (to) await to.p.receive(e as never); }
  }

  it('refuses credentials and pairing messages, and sees pins the owner made after it started', async () => {
    const wire = { out: [] as Env[] };
    const A = mk('a', wire), B = mk('b', wire);
    const Bsecond = mk('b', wire, { dir: B.dir, kp: B.k, owns: false }); // a second process on B's state dir
    const inv = A.p.flow.createInvite() as { ok: true; iid: string; message: string };
    const r = await B.p.flow.receiveInvite(inv.message) as { iid: string };
    B.p.flow.approveAccept(r.iid);
    await pump(wire, [A, B]);
    A.p.flow.approveFinish(inv.iid);
    await tick();
    await pump(wire, [A, B]);
    // the pin was written by the owner after Bsecond started; Bsecond still encrypts to A
    expect(Bsecond.p.send(A.fp, 'hello')).toMatchObject({ sent: true, encrypted: true });
    expect(Bsecond.p.send(A.fp, 'secret', { credential: true })).toEqual({ sent: false, reason: 'not-pairing-owner' });
    // a pairing op that reaches the non-owner is refused, not applied
    wire.out.length = 0;
    A.p.send(B.fp, 'ordinary');
    expect(await Bsecond.p.receive(wire.out.shift()! as never)).toMatchObject({ kind: 'message', encrypted: true });
    expect(Bsecond.p.encryptedChatSeen(A.fp)).toBe(false); // only the owner writes the mark
  });
});
