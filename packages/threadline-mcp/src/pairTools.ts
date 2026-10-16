/**
 * The pair tools' logic for threadline-mcp (spec threadline-standalone-pairing §4, D3, D4).
 * No MCP SDK import: server.ts registers thin wrappers and passes `elicit`, which asks the PERSON
 * through the host (MCP elicitation). The model cannot answer an elicitation, so the two operator
 * acts (accept and finish) are the person's. The recipient's invite is pasted by the person
 * straight to this server, so its secret never enters the model's context (D4).
 */

import type { StandalonePairing } from './pairing.js';

/** One elicitation: a message and the fields to ask for. Returns null when the person declines or cancels. */
export type Elicit = (message: string, fields: Record<string, { type: 'string'; title: string; enum?: string[]; description?: string }>) => Promise<Record<string, string> | null>;

export interface PairToolsDeps {
  pairing: StandalonePairing;
  /** Null when the host cannot ask the person (no elicitation support). */
  elicit: Elicit | null;
  /** Resolve a contact name or fingerprint to a fingerprint, or null. */
  resolvePeer: (nameOrFp: string) => string | null;
  /** Why pairing cannot work right now (e.g. no direct relay connection), or null. */
  unavailable?: () => string | null;
}

export type ToolResult = { ok: true; [k: string]: unknown } | { ok: false; error: string };

const NO_ELICIT = 'Your app cannot ask you questions directly (it does not support MCP elicitation), and approving a pairing must come from you, not from me. Either use an app that supports it, such as Claude Code, or turn on terminal pairing (set THREADLINE_TERMINAL_PAIRING=1 for threadline-mcp in your app config and restart it), then open a terminal and run: npx threadline-mcp pair open (to accept an invite you were sent) or npx threadline-mcp pair finish (to confirm who accepted yours). That command asks you, not me. It is an honest boundary rather than a hard one: an agent that can run commands in a terminal could run it too, so do not let one do it for you.';

export class PairTools {
  constructor(private readonly deps: PairToolsDeps) {}

  /** threadline_pair_invite: make an invite for the person to send privately. Grants nothing. */
  invite(args: { for?: string; ttlMinutes?: number }): ToolResult {
    const why = this.deps.unavailable?.();
    if (why) return { ok: false, error: why };
    let bindFp: string | undefined;
    if (args.for) {
      const fp = this.deps.resolvePeer(args.for);
      if (!fp) return { ok: false, error: `No contact matches "${args.for}". Leave "for" empty to invite someone new.` };
      bindFp = fp;
    }
    if (args.ttlMinutes !== undefined && (!(args.ttlMinutes > 0) || args.ttlMinutes > 1440)) return { ok: false, error: 'ttlMinutes must be between 1 and 1440' };
    const r = this.deps.pairing.flow.createInvite({ ttlMs: args.ttlMinutes ? args.ttlMinutes * 60_000 : undefined, bindFp });
    if (!r.ok) return { ok: false, error: r.reason };
    return {
      ok: true, iid: r.iid, exp: r.exp, message: r.message, ...(bindFp ? { boundTo: bindFp } : {}),
      instruction: 'Give this message to your person to send PRIVATELY to the other agent\'s person, in an app they already use. Never post it or send it over Threadline: it works once, and whoever uses it first is offered to your person. When they accept, run threadline_pair_finish so your person can confirm.',
    };
  }

  /** threadline_pair_open: the person pastes an invite (never through the model), then approves or declines. */
  async open(): Promise<ToolResult> {
    const why = this.deps.unavailable?.();
    if (why) return { ok: false, error: why };
    if (!this.deps.elicit) return { ok: false, error: NO_ELICIT };
    const pasted = await this.deps.elicit('Paste the pairing invite you were sent. It goes straight to Threadline, not to your agent.', {
      invite: { type: 'string', title: 'Pairing invite', description: 'The whole message, including the part that starts with tlinv1:' },
    });
    if (!pasted?.invite) return { ok: false, error: 'No invite was pasted, so nothing changed.' };
    const r = await this.deps.pairing.flow.receiveInvite(pasted.invite);
    if (!r.ok) return { ok: false, error: `That invite can't be used: ${r.reason}` };
    const owner = r.claimedOwner ? `, which says it belongs to ${String(r.claimedOwner)}` : '';
    const answer = await this.deps.elicit(
      `Pair with the agent that calls itself "${String(r.claimedAgent)}"${owner}? Only approve if you know who sent you this invite. Check code (optional, to read to them): ${String(r.checkCode)}`,
      { decision: { type: 'string', title: 'Your decision', enum: ['approve', 'decline'] } },
    );
    const iid = String(r.iid);
    if (answer?.decision !== 'approve') {
      this.deps.pairing.flow.declineAccept(iid);
      return { ok: true, result: 'declined', note: 'Nothing was paired.' };
    }
    const a = this.deps.pairing.flow.approveAccept(iid);
    if (!a.ok) return { ok: false, error: a.reason };
    return { ok: true, result: 'approved', inviter: a.inviterFp, note: 'Approved. The pairing completes when the other side finishes; check with threadline_pair_status.' };
  }

  /** threadline_pair_finish: the person confirms (or refuses) the agent that accepted their invite. */
  async finish(args: { iid?: string }): Promise<ToolResult> {
    const why = this.deps.unavailable?.();
    if (why) return { ok: false, error: why };
    if (!this.deps.elicit) return { ok: false, error: NO_ELICIT };
    const waiting = this.deps.pairing.waitingToFinish();
    const target = args.iid ? waiting.find((i) => i.iid === args.iid) : waiting.length === 1 ? waiting[0] : undefined;
    if (!target) {
      return waiting.length === 0
        ? { ok: false, error: 'Nobody has accepted one of your invites yet.' }
        : { ok: false, error: 'More than one accept is waiting; pass iid.', waiting: waiting.map((i) => ({ iid: i.iid, claimedAgent: i.acceptor?.agent })) } as ToolResult;
    }
    const owner = target.acceptor?.owner ? `, which says it belongs to ${target.acceptor.owner}` : '';
    const answer = await this.deps.elicit(
      `The agent that calls itself "${target.acceptor?.agent}"${owner} accepted your pairing invite. Finish only if that is who you sent it to.`,
      { decision: { type: 'string', title: 'Your decision', enum: ['finish', 'not them'] } },
    );
    if (answer?.decision === 'finish') {
      const r = this.deps.pairing.flow.approveFinish(target.iid);
      return r.ok ? { ok: true, result: 'finished', peer: r.peerFp, note: 'Paired. Messages to this agent are now always encrypted, and you can send it credentials.' } : { ok: false, error: r.reason };
    }
    if (answer?.decision === 'not them') {
      const r = this.deps.pairing.flow.rejectFinish(target.iid);
      return r.ok ? { ok: true, result: 'not-them', note: 'Not paired. That invite is used up; make a new one if you still want to pair.' } : { ok: false, error: r.reason };
    }
    return { ok: true, result: 'undecided', note: 'Nothing changed. Run this again when your person is ready.' };
  }

  /** threadline_pair_status: pairings, open invites, accepts waiting, recent events. Never secrets. */
  status(): ToolResult {
    const p = this.deps.pairing;
    return {
      ok: true,
      paired: p.keys.list().map((k) => ({ agent: k.agent, fingerprint: k.fingerprint, state: k.pairingState, verifiedAt: k.verifiedAt })),
      openInvites: p.invites.list().filter((i) => i.state === 'open').map((i) => ({ iid: i.iid, exp: i.exp, boundTo: i.bind })),
      waitingToFinish: p.waitingToFinish().map((i) => ({ iid: i.iid, claimedAgent: i.acceptor?.agent, claimedOwner: i.acceptor?.owner })),
      recent: p.recentEvents().slice(0, 10),
      auditLog: p.auditPath,
    };
  }

  /**
   * threadline_pair_forget: unpair. An operator act, because forgetting a pin removes the always-
   * encrypt rule and the credential right for that agent. A rotated key is a different fingerprint
   * (the fingerprint is the key's first 16 bytes), so a pin can never move to a new key: the old
   * pin is forgotten here and the agent is paired again from scratch.
   */
  async forget(args: { peer: string }): Promise<ToolResult> {
    if (!this.deps.elicit) return { ok: false, error: NO_ELICIT };
    const fp = this.deps.resolvePeer(String(args.peer || ''));
    const pin = fp ? this.deps.pairing.keys.getProfileByFingerprint(fp) : null;
    if (!fp || !pin) return { ok: false, error: `You are not paired with "${args.peer}".` };
    const answer = await this.deps.elicit(
      `Unpair from the agent "${pin.agent}" (${fp})? Messages to it will no longer be guaranteed encrypted, and it can no longer receive credentials. To pair again you will need a new invite.`,
      { decision: { type: 'string', title: 'Your decision', enum: ['unpair', 'keep'] } },
    );
    if (answer?.decision !== 'unpair') return { ok: true, result: 'kept', note: 'Nothing changed.' };
    this.deps.pairing.keys.forget(fp);
    return { ok: true, result: 'unpaired', peer: fp };
  }

  /** threadline_pair_cancel: revoke an open invite. */
  cancel(args: { iid: string }): ToolResult {
    return this.deps.pairing.invites.revoke(String(args.iid || '').toLowerCase())
      ? { ok: true, result: 'cancelled' }
      : { ok: false, error: 'No open invite with that id.' };
  }
}
