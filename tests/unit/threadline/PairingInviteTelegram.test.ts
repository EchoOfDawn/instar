/**
 * Telegram surface for invite pairing (docs/specs/a2a-pairing-invite-link.md §6.1):
 * who may open a prompt, who may tap, one decision per prompt, and the operator notices.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PairingInviteTelegram, CALLBACK_PREFIX, resolveApprovalOwner, NO_OWNER_REFUSAL, NOT_OWNER_REFUSAL,
} from '../../../src/threadline/PairingInviteTelegram.js';
import { TopicOperatorStore } from '../../../src/users/TopicOperatorStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { createInvite, inviteMessage, findInviteToken, decodeInvite } from '../../../src/threadline/PairingInvite.js';

const OWNER = 4242;
const INVITE = inviteMessage(createInvite({ identityPubHex: crypto.randomBytes(32).toString('hex'), owner: 'Justin', agent: 'Scout' }));
const IID = 'ab'.repeat(16);

function setup(opts: { enforcing?: boolean; operatorTopic?: number | undefined; now?: () => number; owner?: () => number | undefined } = {}) {
  const calls: string[] = [];
  const sent: Array<{ topicId: number; text: string; buttons?: Array<{ text: string; data: string }> }> = [];
  const answers: string[] = [];
  const events = new EventEmitter();
  let enforcing = opts.enforcing ?? true;
  const ok = (name: string) => (iid: string) => { calls.push(`${name}:${iid}`); return { ok: true as const }; };
  const tg = new PairingInviteTelegram({
    flow: {
      receiveInvite: async (text: string) => { calls.push('receive'); return decodeInvite(findInviteToken(text) ?? '').ok ? { ok: true, iid: IID, claimedAgent: 'Scout', claimedOwner: 'Justin', checkCode: 'K7Q2' } : { ok: false, reason: 'bad' }; },
      approveAccept: ok('approve'), declineAccept: ok('decline'), approveFinish: ok('finish'), rejectFinish: ok('not-them'),
    },
    events,
    send: async (topicId, text, buttons) => { sent.push({ topicId, text, buttons }); },
    answer: async (_id, text) => { answers.push(text); },
    ownerUserId: opts.owner ?? (() => OWNER),
    chatId: () => '-100',
    operatorTopicId: () => ('operatorTopic' in opts ? opts.operatorTopic : 7),
    enforcing: () => enforcing,
    now: opts.now,
  });
  return { tg, calls, sent, answers, events, setEnforcing: (v: boolean) => { enforcing = v; } };
}

const okForward = { text: `here: ${INVITE}`, topicId: 9, fromUserId: OWNER, verified: true };
const tap = (data: string, over: Partial<{ fromUserId: number; verified: boolean; chatId: string }> = {}) =>
  ({ callbackQueryId: 'q', data, fromUserId: OWNER, verified: true, chatId: '-100', ...over });

describe('PairingInviteTelegram', () => {
  it('detects invites, and scrubs the secret out of text', () => {
    expect(PairingInviteTelegram.carriesInvite(`Fwd: ${INVITE}`)).toBe(true);
    expect(PairingInviteTelegram.carriesInvite('tlinv1 is the prefix')).toBe(false);
    const token = findInviteToken(INVITE)!;
    expect(PairingInviteTelegram.scrub(`x ${token} y`)).toBe('x tlinv1:[removed] y');
    expect(PairingInviteTelegram.scrub(INVITE)).not.toContain(token);
  });

  it('the owner, verified, enforcing: opens an Approve/Decline prompt in the same topic', async () => {
    const { tg, sent, calls } = setup();
    await tg.onForwardedInvite(okForward);
    expect(calls).toEqual(['receive']);
    expect(sent[0].topicId).toBe(9);
    expect(sent[0].text).toContain('calls itself "Scout"');
    expect(sent[0].buttons?.map((b) => b.text)).toEqual(['Approve', 'Decline']);
    expect(sent[0].buttons!.every((b) => b.data.startsWith(CALLBACK_PREFIX) && Buffer.byteLength(b.data) <= 64)).toBe(true);
  });

  it.each([
    ['not verified (no lifeline secret)', { verified: false }],
    ['not the owner', { fromUserId: 1 }],
    ['no sender id (an unverified forward had it removed)', { fromUserId: undefined }],
  ])('a forwarded invite opens NO prompt when %s, and points at the dashboard', async (_n, over) => {
    const { tg, sent, calls } = setup();
    await tg.onForwardedInvite({ ...okForward, ...over } as never);
    expect(calls).toEqual([]);
    expect(sent[0].buttons).toBeUndefined();
    expect(sent[0].text).toMatch(/dashboard/);
  });

  it('observe mode: Telegram approval is off', async () => {
    const { tg, sent, calls } = setup({ enforcing: false });
    await tg.onForwardedInvite(okForward);
    expect(calls).toEqual([]);
    expect(sent[0].text).toMatch(/dashboard/);
  });

  it('an unusable invite is reported, with no buttons', async () => {
    const { tg, sent } = setup();
    await tg.onForwardedInvite({ ...okForward, text: 'tlinv1:AAAA.BBBB' });
    expect(sent[0].text).toContain("can't use that pairing invite");
    expect(sent[0].buttons).toBeUndefined();
  });

  it('a tap acts once: Approve calls the engine, and the sibling Decline is spent too', async () => {
    const { tg, sent, calls, answers } = setup();
    await tg.onForwardedInvite(okForward);
    const [approve, decline] = sent[0].buttons!;
    expect(await tg.onCallback(tap(approve.data))).toBe(true);
    expect(calls).toContain(`approve:${IID}`);
    await tg.onCallback(tap(approve.data));
    await tg.onCallback(tap(decline.data));
    expect(calls.filter((c) => c !== 'receive')).toEqual([`approve:${IID}`]);
    expect(answers.at(-1)).toMatch(/expired or was already used/);
  });

  it.each([
    ['unverified tap', { verified: false }],
    ['another member of the group', { fromUserId: 99 }],
    ['wrong chat', { chatId: '-200' }],
  ])('%s is refused and does NOT spend the button', async (_n, over) => {
    const { tg, sent, calls } = setup();
    await tg.onForwardedInvite(okForward);
    const approve = sent[0].buttons![0].data;
    await tg.onCallback(tap(approve, over));
    expect(calls).toEqual(['receive']);
    await tg.onCallback(tap(approve)); // the real owner can still use it
    expect(calls).toEqual(['receive', `approve:${IID}`]);
  });

  it('a tap after the guard dropped to observe is refused', async () => {
    const { tg, sent, calls, setEnforcing } = setup();
    await tg.onForwardedInvite(okForward);
    setEnforcing(false);
    await tg.onCallback(tap(sent[0].buttons![0].data));
    expect(calls).toEqual(['receive']);
  });

  it('a button expires after 24 hours', async () => {
    let t = 1_000_000;
    const { tg, sent, calls, answers } = setup({ now: () => t });
    await tg.onForwardedInvite(okForward);
    t += 24 * 60 * 60_000 + 1;
    await tg.onCallback(tap(sent[0].buttons![0].data));
    expect(calls).toEqual(['receive']);
    expect(answers.at(-1)).toMatch(/expired/);
  });

  it('data that is not ours is left to the caller; a forged token does nothing', async () => {
    const { tg, calls, answers } = setup();
    expect(await tg.onCallback(tap('tc:g:abc'))).toBe(false);
    expect(await tg.onCallback(tap(`${CALLBACK_PREFIX}${'0'.repeat(24)}`))).toBe(true);
    expect(calls).toEqual([]);
    expect(answers[0]).toMatch(/expired/);
  });

  it('a finish prompt goes to the operator topic with Finish / Not them, and a tap finishes', async () => {
    const { tg, sent, calls, events } = setup();
    events.emit('event', { kind: 'finish-prompt', iid: IID, claimedAgent: 'Carl', claimedOwner: 'Carl O', acceptorFp: 'f'.repeat(32), checkCode: 'AB12' });
    await new Promise((r) => setImmediate(r));
    expect(sent[0].topicId).toBe(7);
    expect(sent[0].buttons?.map((b) => b.text)).toEqual(['Finish', 'Not them']);
    await tg.onCallback(tap(sent[0].buttons![0].data));
    expect(calls).toEqual([`finish:${IID}`]);
  });

  it('when not enforcing, a finish prompt has no buttons and points at the dashboard', async () => {
    const { sent, events } = setup({ enforcing: false });
    events.emit('event', { kind: 'finish-prompt', iid: IID, claimedAgent: 'Carl', claimedOwner: '', acceptorFp: 'f'.repeat(32), checkCode: 'AB12' });
    await new Promise((r) => setImmediate(r));
    expect(sent[0].buttons).toBeUndefined();
    expect(sent[0].text).toMatch(/dashboard/);
  });

  it('the leak alarm and the used-elsewhere notice reach the operator', async () => {
    const { sent, events } = setup();
    events.emit('event', { kind: 'second-accept-alarm', iid: IID, pausedFp: 'a'.repeat(32), lateFp: 'b'.repeat(32), lateClaimedAgent: 'Mallory', lateClaimedOwner: 'M' });
    events.emit('event', { kind: 'invite-used-elsewhere', iid: IID, inviterFp: 'c'.repeat(32) });
    await new Promise((r) => setImmediate(r));
    expect(sent.map((s) => s.text).join('\n')).toMatch(/two agents used the same pairing invite[\s\S]*already been used/);
  });

  it('says "no owner set" (not "only the owner") when the agent has no owner it can name', async () => {
    const { tg, sent, calls } = setup({ owner: () => undefined });
    await tg.onForwardedInvite(okForward);
    expect(calls).toEqual([]);
    expect(sent[0].text).toContain(NO_OWNER_REFUSAL);
    expect(sent[0].text).not.toContain(NOT_OWNER_REFUSAL);
    expect(sent[0].text).toMatch(/dashboard/);
  });

  it('a genuine non-owner still hears "Only the agent\'s owner can do this."', async () => {
    const { tg, sent } = setup();
    await tg.onForwardedInvite({ ...okForward, fromUserId: 1 });
    expect(sent[0].text).toContain(NOT_OWNER_REFUSAL);
    expect(sent[0].text).not.toContain(NO_OWNER_REFUSAL);
  });
});

describe('resolveApprovalOwner (who may approve when no owner id is configured)', () => {
  const OP = 7812716706;
  let dir: string;
  let store: TopicOperatorStore;
  const evidence = (uid: number, messageId = '11') => ({
    kind: 'authenticated-inbound' as const, ingress: 'telegram-lifeline-forward' as const,
    authorization: 'telegram-is-authorized-sender' as const, senderUid: String(uid), messageId,
  });
  const bindVerified = (topic: number, uid: number) =>
    store.setAuthenticatedOperator(topic, { platform: 'telegram', uid: String(uid), displayName: 'Justin' }, evidence(uid));
  const bindings = () => Object.values(store.allBindings());

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-owner-'));
    store = new TopicOperatorStore(dir);
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline/PairingInviteTelegram.test.ts' }); });

  it('a configured owner wins, whatever the bindings say', () => {
    bindVerified(3, 555);
    expect(resolveApprovalOwner(OWNER, bindings())).toBe(OWNER);
  });

  it('a configured owner written as a string still counts; a malformed one means no owner, never the bindings', () => {
    bindVerified(3, 555);
    expect(resolveApprovalOwner(String(OWNER), bindings())).toBe(OWNER);
    expect(resolveApprovalOwner('not-an-id', bindings())).toBeUndefined();
    expect(resolveApprovalOwner(-5, bindings())).toBeUndefined();
  });

  it('no owner + exactly one verified operator (on one or several topics) → that operator', () => {
    expect(bindVerified(3, OP)).not.toBeNull();
    expect(resolveApprovalOwner(undefined, bindings())).toBe(OP);
    bindVerified(9, OP);
    expect(resolveApprovalOwner(undefined, bindings())).toBe(OP);
  });

  it('no owner + two different verified operators → nobody (never pick one)', () => {
    bindVerified(3, OP);
    bindVerified(9, 555);
    expect(resolveApprovalOwner(undefined, bindings())).toBeUndefined();
  });

  it('no owner + no bindings → nobody', () => {
    expect(resolveApprovalOwner(undefined, bindings())).toBeUndefined();
    expect(resolveApprovalOwner(undefined, null)).toBeUndefined();
  });

  it('a manually asserted record (POST /topic-operator) never counts', () => {
    expect(store.setOperator(3, { platform: 'telegram', uid: String(OP), displayName: 'Justin' })).not.toBeNull();
    expect(bindings()).toHaveLength(1);
    expect(resolveApprovalOwner(undefined, bindings())).toBeUndefined();
  });

  it('an asserted record for someone else does not make a verified operator ambiguous, nor stand in for one', () => {
    bindVerified(3, OP);
    store.setOperator(9, { platform: 'telegram', uid: '555' });
    expect(resolveApprovalOwner(undefined, bindings())).toBe(OP);
  });

  it('a legacy or self-described record without evidence (someone who merely messaged) never counts', () => {
    const forged = { platform: 'telegram', uid: String(OP), names: [], boundAt: '', boundFrom: 'authenticated-inbound' };
    expect(resolveApprovalOwner(undefined, [forged])).toBeUndefined();
    const mismatched = { ...forged, establishmentEvidence: evidence(555) };
    expect(resolveApprovalOwner(undefined, [mismatched])).toBeUndefined();
  });

  it('a verified binding on another platform does not count as a Telegram owner', () => {
    const wa = { platform: 'whatsapp', uid: String(OP), names: [], boundAt: '', boundFrom: 'authenticated-inbound', establishmentEvidence: evidence(OP) };
    expect(resolveApprovalOwner(undefined, [wa])).toBeUndefined();
  });

  it('end to end: no owner configured, the verified operator forwards → Approve prompt; anyone else → non-owner refusal', async () => {
    bindVerified(3, OP);
    const owner = () => resolveApprovalOwner(undefined, bindings());
    const a = setup({ owner });
    await a.tg.onForwardedInvite({ ...okForward, fromUserId: OP });
    expect(a.sent[0].buttons?.map((b) => b.text)).toEqual(['Approve', 'Decline']);
    await a.tg.onCallback(tap(a.sent[0].buttons![0].data, { fromUserId: OP }));
    expect(a.calls).toEqual(['receive', `approve:${IID}`]);

    const b = setup({ owner });
    await b.tg.onForwardedInvite({ ...okForward, fromUserId: 555 });
    expect(b.calls).toEqual([]);
    expect(b.sent[0].text).toContain(NOT_OWNER_REFUSAL);
  });
});
