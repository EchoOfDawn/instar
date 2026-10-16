/**
 * threadline-mcp's StandalonePairing (packages/threadline-mcp/src/pairing.ts): the rules that make a
 * channel safe for secrets without Instar (spec threadline-standalone-pairing D6, D7).
 * Two standalone agents joined by an in-memory wire.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StandalonePairing } from '../../../packages/threadline-mcp/src/pairing.js';
import { generateIdentityKeyPair } from 'threadline-core';

type Env = Record<string, unknown> & { from: string; to: string };

function agent(name: string, wire: { out: Env[] }, opts: { fetchImpl?: typeof fetch; relayHttpBase?: string | null } = {}) {
  const k = generateIdentityKeyPair();
  const fp = k.publicKey.subarray(0, 16).toString('hex');
  const p = new StandalonePairing({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), `sa-${name}-`)),
    identity: { fp, publicKey: k.publicKey, privateKey: k.privateKey },
    ownName: () => ({ owner: `${name}-owner`, agent: name }),
    sendEnvelope: (e) => wire.out.push(e as Env),
    relayHttpBase: opts.relayHttpBase ?? null,
    fetchImpl: opts.fetchImpl,
  });
  return { name, fp, p, key: k.publicKey };
}

/** The engine sends Finish on a timer (delay 0, then bounded retries): let it fire. */
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Deliver everything queued to whichever agent it is addressed to. */
async function pump(wire: { out: Env[] }, agents: Array<ReturnType<typeof agent>>, results: unknown[] = []) {
  while (wire.out.length) {
    const e = wire.out.shift()!;
    const to = agents.find((a) => a.fp === e.to);
    if (to) results.push(await to.p.receive(e as never));
  }
  return results;
}

async function pair(wire: { out: Env[] }, A: ReturnType<typeof agent>, B: ReturnType<typeof agent>) {
  const inv = A.p.flow.createInvite() as { ok: true; iid: string; message: string };
  const r = await B.p.flow.receiveInvite(inv.message) as { iid: string };
  B.p.flow.approveAccept(r.iid);
  await pump(wire, [A, B]);
  expect(A.p.waitingToFinish().map((i) => i.iid)).toEqual([inv.iid]);
  A.p.flow.approveFinish(inv.iid);
  await tick();
  await pump(wire, [A, B]);
}

describe('StandalonePairing', () => {
  it('two agents without Instar pair by invite; pairing ops are never surfaced as messages', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const inv = A.p.flow.createInvite() as { ok: true; iid: string; message: string };
    const r = await B.p.flow.receiveInvite(inv.message) as { iid: string };
    B.p.flow.approveAccept(r.iid);
    const seen = await pump(wire, [A, B]);
    A.p.flow.approveFinish(inv.iid);
    await tick();
    seen.push(...await pump(wire, [A, B]));
    expect(seen.every((x) => (x as { kind: string }).kind === 'control')).toBe(true);
    expect(A.p.keys.isCredentialShareAllowedByFingerprint(B.fp)).toBe(true);
    expect(B.p.keys.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
    expect(A.p.recentEvents().some((e) => e.event.kind === 'paired' && e.event.role === 'inviter')).toBe(true);
    expect(B.p.recentEvents().some((e) => e.event.kind === 'paired' && e.event.role === 'recipient')).toBe(true);
  });

  it('a pinned peer is ALWAYS sent encrypted; an unknown one gets plaintext', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire), C = agent('c', wire);
    await pair(wire, A, B);
    expect(A.p.send(B.fp, 'hi')).toMatchObject({ sent: true, encrypted: true });
    expect(wire.out.at(-1)).toHaveProperty('signature');
    const got = await pump(wire, [A, B]);
    expect(got[0]).toMatchObject({ kind: 'message', text: 'hi', encrypted: true, credential: false });
    expect(A.p.send(C.fp, 'hello stranger')).toMatchObject({ sent: true, encrypted: false });
    expect(wire.out.at(-1)).not.toHaveProperty('signature');
  });

  it('credentials: refused to an unpaired or paused peer; delivered and marked when paired', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    expect(A.p.send(B.fp, 'secret', { credential: true })).toEqual({ sent: false, reason: 'peer-not-mutually-verified' });
    expect(wire.out).toHaveLength(0);
    await pair(wire, A, B);
    expect(A.p.send(B.fp, 'secret', { credential: true })).toMatchObject({ sent: true, encrypted: true });
    expect(await pump(wire, [A, B])).toEqual([expect.objectContaining({ kind: 'message', text: 'secret', credential: true })]);
    A.p.keys.demoteInvitePairing(B.fp, 'leak');
    expect(A.p.send(B.fp, 'secret', { credential: true })).toEqual({ sent: false, reason: 'peer-not-mutually-verified' });
  });

  it('an inbound credential from a peer that is only invite-accepted is refused', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    // B accepted A's invite (A pinned on B as invite-accepted), but A never finished.
    const inv = A.p.flow.createInvite() as { ok: true; message: string };
    const r = await B.p.flow.receiveInvite(inv.message) as { iid: string };
    B.p.flow.approveAccept(r.iid);
    await pump(wire, [A, B]);
    // A (not finished) pins B only when it finishes, so make A's side verified by hand to send:
    A.p.keys.markInviteVerified(B.fp, { peerIdentityPub: B.key.toString('hex'), via: 'test', ownIdentityPub: A.key.toString('hex') });
    A.p.send(B.fp, 'sneaky', { credential: true });
    expect(await pump(wire, [A, B])).toEqual([{ kind: 'refused', reason: 'credential from a peer that is not mutual-verified' }]);
  });

  it('encrypted messages decrypt ONLY with a pinned key; a stranger or a tampered envelope is refused', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire), M = agent('m', wire);
    await pair(wire, A, B);
    // M pins B by hand (B never pinned M) and sends it an encrypted message.
    M.p.keys.markInviteVerified(B.fp, { peerIdentityPub: B.key.toString('hex'), via: 'test' });
    M.p.send(B.fp, 'trust me');
    expect(await pump(wire, [A, B, M])).toEqual([{ kind: 'refused', reason: 'encrypted message from a sender with no pinned key' }]);
    A.p.send(B.fp, 'real');
    const e = wire.out.shift()!;
    const tampered = { ...e, payload: Buffer.from('x').toString('base64') };
    expect(await B.p.receive(tampered as never)).toEqual({ kind: 'refused', reason: 'could not verify or decrypt with the pinned key' });
  });

  it('while waiting for the inviter to finish, the acceptor sends as before pairing, so nothing is lost; a paused pin stays encrypted', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const inv = A.p.flow.createInvite() as { ok: true; iid: string; message: string };
    const r = await B.p.flow.receiveInvite(inv.message) as { iid: string };
    B.p.flow.approveAccept(r.iid);
    await pump(wire, [A, B]); // A now waits for its person; it holds no pin for B
    expect(B.p.send(A.fp, 'are you there?')).toMatchObject({ sent: true, encrypted: false });
    expect(await pump(wire, [A, B])).toEqual([expect.objectContaining({ kind: 'message', text: 'are you there?' })]);
    A.p.flow.approveFinish(inv.iid);
    await tick();
    await pump(wire, [A, B]);
    expect(B.p.send(A.fp, 'now paired')).toMatchObject({ encrypted: true });
    expect(await pump(wire, [A, B])).toEqual([expect.objectContaining({ kind: 'message', encrypted: true })]);
    B.p.keys.demoteInvitePairing(A.fp, 'second accept');
    expect(B.p.send(A.fp, 'still private')).toMatchObject({ encrypted: true });
    expect(await pump(wire, [A, B])).toEqual([expect.objectContaining({ kind: 'message', text: 'still private', encrypted: true })]);
  });

  it('a captured encrypted envelope is accepted once; a replay of it is refused, and a forgery cannot burn its id', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    await pair(wire, A, B);
    A.p.send(B.fp, 'pay invoice 7');
    const e = wire.out.shift()!;
    // a forgery reusing the real messageId arrives FIRST; it fails verification and must not mark the id as seen
    expect(await B.p.receive({ ...e, payload: Buffer.from('x').toString('base64') } as never)).toMatchObject({ kind: 'refused' });
    expect(await B.p.receive(e as never)).toMatchObject({ kind: 'message', text: 'pay invoice 7', encrypted: true });
    expect(await B.p.receive(e as never)).toEqual({ kind: 'refused', reason: 'replayed message (already received)' });
    // a new message from the same sender still goes through
    A.p.send(B.fp, 'second');
    expect(await B.p.receive(wire.out.shift()! as never)).toMatchObject({ kind: 'message', text: 'second' });
  });

  it('pairing ops other than the accept are ignored in plaintext; an invite sent as a message is refused', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const fakeFinish = { from: A.fp, to: B.fp, payload: Buffer.from(JSON.stringify({ type: 'pair-invite-finish', text: '{}' })).toString('base64') };
    expect(await B.p.receive(fakeFinish as never)).toEqual({ kind: 'control' });
    expect(B.p.keys.list()).toEqual([]);
    const inv = A.p.flow.createInvite() as { message: string };
    const relayed = { from: A.fp, to: B.fp, payload: Buffer.from(JSON.stringify({ type: 'chat', text: inv.message })).toString('base64') };
    expect(await B.p.receive(relayed as never)).toMatchObject({ kind: 'refused' });
  });

  it('plaintext from a PAIRED peer is delivered but marked unencrypted, and never as a credential', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    await pair(wire, A, B);
    const pt = { from: A.fp, to: B.fp, payload: Buffer.from(JSON.stringify({ type: 'chat', text: 'old instar sends this way' })).toString('base64') };
    expect(await B.p.receive(pt as never)).toEqual({ kind: 'message', text: 'old instar sends this way', type: 'chat', encrypted: false, credential: false, fromPairedPeer: true });
  });

  it('the audit log records pairing, credential sends and refusals, privately, with no message content', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire), C = agent('c', wire);
    expect(A.p.send(C.fp, 'secret-to-stranger', { credential: true })).toMatchObject({ sent: false });
    await pair(wire, A, B);
    A.p.send(B.fp, 'the vault password', { credential: true });
    await pump(wire, [A, B]);
    A.p.send(B.fp, 'hello');
    const env = wire.out.shift()!;
    await B.p.receive(env as never); await B.p.receive(env as never); // the second is a replay
    const read = (x: ReturnType<typeof agent>) => fs.readFileSync(x.p.auditPath, 'utf8');
    const a = read(A).trim().split('\n').map((l) => JSON.parse(l)), b = read(B).trim().split('\n').map((l) => JSON.parse(l));
    expect(a.map((x) => x.kind)).toEqual(expect.arrayContaining(['credential-refused', 'finish-prompt', 'paired', 'credential-sent']));
    expect(a.find((x) => x.kind === 'credential-refused')).toMatchObject({ to: C.fp, reason: 'peer-not-mutually-verified' });
    expect(b.map((x) => x.kind)).toEqual(expect.arrayContaining(['accept-prompt', 'paired', 'credential-received', 'refused']));
    expect(b.find((x) => x.kind === 'refused')).toMatchObject({ from: A.fp, reason: 'replayed message (already received)' });
    expect(read(A) + read(B)).not.toMatch(/vault password|secret-to-stranger|hello|tlinv1:/);
    expect(fs.statSync(A.p.auditPath).mode & 0o077).toBe(0);
  });

  it('the audit log rotates past its size limit, and an unwritable state dir never breaks messaging', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    fs.mkdirSync(path.dirname(A.p.auditPath), { recursive: true });
    fs.writeFileSync(A.p.auditPath, 'x'.repeat(StandalonePairing.AUDIT_MAX_BYTES + 1));
    A.p.send(B.fp, 'x', { credential: true });
    expect(fs.existsSync(A.p.auditPath + '.1')).toBe(true);
    expect(fs.readFileSync(A.p.auditPath, 'utf8').trim().split('\n')).toHaveLength(1);
    fs.renameSync(path.dirname(A.p.auditPath), path.dirname(A.p.auditPath) + '.moved');
    fs.writeFileSync(path.dirname(A.p.auditPath), 'not a directory');
    expect(A.p.send(B.fp, 'x', { credential: true })).toMatchObject({ sent: false }); // no throw
  });

  it('relay-card key check: a matching key is returned, a mismatch or failure is null', async () => {
    const wire = { out: [] as Env[] };
    const target = generateIdentityKeyPair();
    const fp = target.publicKey.subarray(0, 16).toString('hex');
    const card = (key: Buffer) => (async () => ({ ok: true, json: async () => ({ 'x-threadline': { publicKey: key.toString('base64') } }) })) as unknown as typeof fetch;
    expect(await agent('a', wire, { relayHttpBase: 'http://r', fetchImpl: card(target.publicKey) }).p.relayKeyFor(fp)).toBe(target.publicKey.toString('hex'));
    expect(await agent('b', wire, { relayHttpBase: 'http://r', fetchImpl: card(generateIdentityKeyPair().publicKey) }).p.relayKeyFor(fp)).toBeNull();
    const failing = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await agent('c', wire, { relayHttpBase: 'http://r', fetchImpl: failing }).p.relayKeyFor(fp)).toBeNull();
    expect(await agent('d', wire, { relayHttpBase: null }).p.relayKeyFor(fp)).toBeNull();
  });
});
