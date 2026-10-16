/**
 * Verified pairing, end-to-end encryption and the credential gate for threadline-mcp, with no
 * Instar (spec docs/specs/threadline-standalone-pairing.md, principle D0).
 *
 * Everything security-relevant comes from `threadline-core`, the same code Instar runs, so a
 * threadline-mcp agent and an Instar agent pair with each other and exchange encrypted messages.
 * This module has no MCP SDK import: the tools in server.ts call it, and tests drive it directly.
 *
 * Wire compatibility with Instar 1.3.1352+:
 *  - `pair-invite-accept` goes PLAINTEXT: payload = base64(JSON{ text: JSON(payload), type: op }).
 *  - `pair-invite-used|finish|ack` and every message to a pinned peer go ENCRYPTED to the pinned
 *    key: PlaintextMessage{ content, type, ...payload } in a signed envelope.
 * Rules: a peer with a pinned key never gets plaintext, and an encrypted message is only ever
 * decrypted with a PINNED key. A credential needs a mutual-verified pin bound to our current key.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  EnvelopeCrypto, PairingInviteFlow, PairingInviteStore, PinnedKeyStore, INVITE_OPS, OP_ACCEPT,
  canonicalizeEnvelope, credentialAcceptFrom, credentialSendKey, edPublicToX25519, findInviteToken, verify,
  type InviteEvent, type MessageEnvelope, type PlaintextMessage,
} from 'threadline-core';

export interface StandaloneIdentity {
  /** 32 hex chars: the first 16 bytes of the public key. */
  fp: string;
  publicKey: Buffer;
  /** The 32-byte Ed25519 seed. */
  privateKey: Buffer;
}

/** A relay envelope as it arrives: encrypted (signature, ephemeralPubKey) or plaintext. */
export type WireEnvelope = Partial<MessageEnvelope> & { from: string; to?: string; threadId?: string; messageId?: string; payload?: string; timestamp?: string };

export interface StandaloneDeps {
  stateDir: string;
  identity: StandaloneIdentity;
  ownName: () => { owner: string; agent: string };
  /** Put one envelope on the relay socket. */
  sendEnvelope: (envelope: Record<string, unknown>) => void;
  /** HTTP base of the relay (for the public a2a card), or null to skip the relay-key check. */
  relayHttpBase: string | null;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

/** What an incoming envelope turned out to be. */
export type Inbound =
  | { kind: 'control' }                                   // a pairing op, handled here, never shown to the model
  | { kind: 'message'; text: string; type?: string; encrypted: boolean; credential: boolean; fromPairedPeer?: boolean; unverifiedPairedClaim?: boolean }
  | { kind: 'refused'; reason: string };                  // e.g. an encrypted message from an unpinned sender

export interface StandaloneEvent { at: string; event: InviteEvent }

export const INVITE_IN_MESSAGE = 'invite-in-message';

/** One plain line per pairing event, for the inbox (spec §4: system lines, not agent messages). */
export function describePairingEvent(e: InviteEvent): string {
  switch (e.kind) {
    case 'accept-prompt': return `Pairing: you were invited by the agent that calls itself "${e.claimedAgent}". Your person decides with threadline_pair_open.`;
    case 'finish-prompt': return `Pairing: the agent that calls itself "${e.claimedAgent}" accepted your invite. Run threadline_pair_finish so your person can confirm it is who they sent it to.`;
    case 'paired': return `Pairing: you are now paired with "${e.claimedAgent}". Messages to it are always encrypted, and it can receive credentials.`;
    case 'second-accept-alarm': return `Pairing WARNING: a second agent ("${e.lateClaimedAgent}") used the same invite, so it leaked. The first pairing is paused. Tell your person.`;
    case 'invite-used-elsewhere': return 'Pairing: the invite you accepted had already been used by someone else, so it did not pair. Ask for a new one.';
  }
}

export class StandalonePairing {
  readonly flow: PairingInviteFlow;
  readonly keys: PinnedKeyStore;
  readonly invites: PairingInviteStore;
  readonly events = new EventEmitter();
  private readonly crypto: EnvelopeCrypto;
  private readonly recent: StandaloneEvent[] = [];
  /** Store files set aside this run (unparseable): an attention item in status and the inbox. */
  readonly storeProblems: Array<{ at: string; message: string }> = [];
  /** Encrypted messages already accepted, by sender and messageId, so a captured envelope cannot be replayed. In memory, bounded. */
  private readonly seen = new Set<string>();
  static readonly SEEN_MAX = 10_000;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  /** Append-only record of pairing events, refusals and credential sends (never content or secrets). 0600, rotated at 1 MB. */
  readonly auditPath: string;
  static readonly AUDIT_MAX_BYTES = 1_000_000;

  constructor(private readonly deps: StandaloneDeps) {
    this.now = deps.now ?? (() => new Date());
    this.auditPath = path.join(deps.stateDir, 'threadline', 'pairing-audit.jsonl');
    this.fetchImpl = deps.fetchImpl ?? fetch;
    // A store file that could not be parsed is set aside by threadline-core; the person must see that.
    const report = (message: string) => {
      this.storeProblems.push({ at: this.now().toISOString(), message });
      this.audit({ kind: 'store-problem', message });
      process.stderr.write(`[threadline-mcp] ${message}\n`);
    };
    this.keys = new PinnedKeyStore(deps.stateDir, this.now, report);
    this.invites = new PairingInviteStore(deps.stateDir, this.now, report);
    this.crypto = new EnvelopeCrypto(deps.identity.privateKey, deps.identity.publicKey);
    this.flow = new PairingInviteFlow({
      store: this.invites,
      trust: this.keys,
      identity: () => ({ fp: deps.identity.fp, publicKeyHex: deps.identity.publicKey.toString('hex'), privateKey: deps.identity.privateKey }),
      relayKeyFor: (fp) => this.relayKeyFor(fp),
      sendPlaintext: (to, op, payload) => this.sendPlaintextTyped(to, op, JSON.stringify(payload)),
      sendToKey: (to, keyHex, op, payload) => this.sendEncrypted(to, Buffer.from(keyHex, 'hex'), { content: op, type: op, ...payload } as PlaintextMessage),
      notify: (event) => { this.recent.unshift({ at: this.now().toISOString(), event }); this.recent.splice(50); this.audit({ ...event }); this.events.emit('event', event); },
      ownName: deps.ownName,
      now: this.now,
    });
  }

  /** Peers that have sent us encrypted ordinary chat (the downgrade high-water mark), persisted 0600. */
  private encryptedPeersFile(): string { return path.join(this.deps.stateDir, 'threadline', 'encrypted-chat-peers.json'); }

  private readEncryptedPeers(): Record<string, string> {
    try { const v = JSON.parse(fs.readFileSync(this.encryptedPeersFile(), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }

  encryptedChatSeen(fp: string): boolean { return Boolean(this.readEncryptedPeers()[fp.toLowerCase()]); }

  private markEncryptedChat(fp: string): void {
    const all = this.readEncryptedPeers();
    if (all[fp]) return;
    all[fp] = this.now().toISOString();
    const file = this.encryptedPeersFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.audit({ kind: 'encrypted-chat-first-seen', from: fp });
  }

  /** Best effort: the audit must never break messaging. */
  private audit(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true, mode: 0o700 });
      try { if (fs.statSync(this.auditPath).size > StandalonePairing.AUDIT_MAX_BYTES) fs.renameSync(this.auditPath, this.auditPath + '.1'); } catch { /* none yet */ }
      fs.appendFileSync(this.auditPath, JSON.stringify({ at: this.now().toISOString(), ...entry }) + '\n', { mode: 0o600 });
    } catch { /* unwritable state dir: messaging continues */ }
  }

  /** The key the relay's public card shows for `fp`, or null when it has none (spec: proceed). */
  async relayKeyFor(fp: string): Promise<string | null> {
    if (!this.deps.relayHttpBase || !/^[0-9a-f]{32}$/.test(fp)) return null;
    try {
      const res = await this.fetchImpl(`${this.deps.relayHttpBase}/v1/registry/agent/${fp}/a2a-card`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const card = (await res.json()) as { 'x-threadline'?: { publicKey?: unknown } };
      const b64 = card?.['x-threadline']?.publicKey;
      if (typeof b64 !== 'string') return null;
      const key = Buffer.from(b64, 'base64');
      return key.length === 32 && key.subarray(0, 16).toString('hex') === fp ? key.toString('hex') : null;
    } catch {
      return null;
    }
  }

  private sendPlaintextTyped(to: string, type: string, text: string, threadId?: string): string {
    const tid = threadId ?? `thread-${crypto.randomBytes(4).toString('hex')}`;
    this.deps.sendEnvelope({
      from: this.deps.identity.fp, to, threadId: tid, messageId: crypto.randomUUID(),
      timestamp: this.now().toISOString(), payload: Buffer.from(JSON.stringify({ text, type })).toString('base64'),
    });
    return tid;
  }

  private sendEncrypted(to: string, pinnedKey: Buffer, message: PlaintextMessage, threadId?: string): string {
    if (pinnedKey.length !== 32 || pinnedKey.subarray(0, 16).toString('hex') !== to.toLowerCase()) throw new Error('pinned key does not match the recipient');
    const tid = threadId ?? `thread-${crypto.randomBytes(4).toString('hex')}`;
    this.deps.sendEnvelope(this.crypto.encrypt(pinnedKey, edPublicToX25519(pinnedKey), tid, message) as unknown as Record<string, unknown>);
    return tid;
  }

  /**
   * Send an ordinary message. A paired peer is ALWAYS sent encrypted (never a silent downgrade);
   * an acceptor still waiting for the inviter's Finish sends as before pairing (see below). `credential: true` is refused unless the peer is mutual-verified and bound to our
   * current key, and then goes only to the key derived from the pin.
   */
  send(to: string, text: string, opts: { threadId?: string; credential?: boolean } = {}): { sent: true; threadId: string; encrypted: boolean } | { sent: false; reason: string } {
    const fp = to.toLowerCase();
    // An invite is handed over privately by a person, never relayed (spec D4): it works once,
    // and whoever sees it first is offered to the inviter's person.
    if (findInviteToken(text)) return { sent: false, reason: INVITE_IN_MESSAGE };
    if (opts.credential) {
      const d = credentialSendKey(this.keys, fp, this.deps.identity.publicKey.toString('hex'));
      this.audit({ kind: d.allow ? 'credential-sent' : 'credential-refused', to: fp, ...(d.allow ? {} : { reason: d.reason }) });
      if (!d.allow) return { sent: false, reason: d.reason };
      return { sent: true, encrypted: true, threadId: this.sendEncrypted(fp, d.peerIdentityPub, { content: text, type: 'chat', metadata: { credential: true } }, opts.threadId) };
    }
    const pin = this.keys.getProfileByFingerprint(fp);
    // An acceptor whose pairing the inviter has not finished yet holds the inviter's key, but the
    // inviter does not hold ours yet: an encrypted message would be dropped as from an unknown
    // sender. Until the Finish arrives we send as before pairing. A pin PAUSED after a leaked
    // invite was verified on both sides, so the peer can still read it: that stays encrypted.
    const awaitingFinish = pin?.pairingState === 'invite-accepted' && !String(pin.via ?? '').startsWith('paused:');
    if (pin?.peerIdentityPub && !awaitingFinish) {
      return { sent: true, encrypted: true, threadId: this.sendEncrypted(fp, Buffer.from(pin.peerIdentityPub, 'hex'), { content: text, type: 'chat' }, opts.threadId) };
    }
    return { sent: true, encrypted: false, threadId: this.sendPlaintextTyped(fp, 'chat', text, opts.threadId) };
  }

  /** Classify an incoming envelope: pairing ops are handled here; encrypted ones need a pinned sender. */
  async receive(env: WireEnvelope): Promise<Inbound> {
    const r = await this.classify(env);
    if (r.kind === 'refused') this.audit({ kind: 'refused', from: String(env.from || '').toLowerCase(), reason: r.reason });
    else if (r.kind === 'message' && r.credential) this.audit({ kind: 'credential-received', from: String(env.from || '').toLowerCase() });
    return r;
  }

  private async classify(env: WireEnvelope): Promise<Inbound> {
    const from = String(env.from || '').toLowerCase();
    if (env.signature && env.ephemeralPubKey) {
      const pin = this.keys.getProfileByFingerprint(from);
      if (!pin?.peerIdentityPub) return { kind: 'refused', reason: 'encrypted message from a sender with no pinned key' };
      let msg: PlaintextMessage;
      try {
        const key = Buffer.from(pin.peerIdentityPub, 'hex');
        msg = this.crypto.decrypt(env as MessageEnvelope, key, edPublicToX25519(key));
      } catch {
        return { kind: 'refused', reason: 'could not verify or decrypt with the pinned key' };
      }
      // Recorded only AFTER verification, so a forged envelope cannot poison the set.
      const id = `${from}:${env.messageId || env.signature}`;
      if (this.seen.has(id)) return { kind: 'refused', reason: 'replayed message (already received)' };
      this.seen.add(id);
      if (this.seen.size > StandalonePairing.SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
      if (msg.type && INVITE_OPS.has(msg.type)) {
        await this.flow.handleControl(msg.type, from, msg as unknown as Record<string, unknown>);
        return { kind: 'control' };
      }
      const credential = (msg.metadata as { credential?: unknown } | undefined)?.credential === true;
      if (credential && !credentialAcceptFrom(this.keys, from, this.deps.identity.publicKey.toString('hex'))) return { kind: 'refused', reason: 'credential from a peer that is not mutual-verified' };
      // The downgrade high-water mark: ordinary chat only. Pairing ops and credentials are always
      // encrypted, even from peers that still send ordinary chat in plaintext.
      if (!credential) this.markEncryptedChat(from);
      return { kind: 'message', text: String(msg.content ?? ''), type: msg.type, encrypted: true, credential };
    }
    // Plaintext.
    let text = String(env.payload ?? ''), type: string | undefined;
    try {
      const decoded = JSON.parse(Buffer.from(String(env.payload ?? ''), 'base64').toString('utf-8'));
      if (decoded && typeof decoded === 'object') { text = String(decoded.text ?? decoded.content ?? JSON.stringify(decoded)); type = decoded.type; }
    } catch { /* raw payload */ }
    if (type && INVITE_OPS.has(type)) {
      // Only the accept travels in plaintext; any other invite op in plaintext is dropped.
      if (type === OP_ACCEPT) {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(text); } catch { /* malformed: the engine refuses it */ }
        await this.flow.handleControl(type, from, payload);
      }
      return { kind: 'control' };
    }
    if (findInviteToken(text)) return { kind: 'refused', reason: 'a pairing invite arrived as a message; invites are pasted by a person, not relayed' };
    // Plaintext naming a PINNED sender (spec D6). On the relay path the sender is only the relay's
    // word, so it counts as from that peer only when the envelope is signed by the pinned key.
    // Once a peer has sent us encrypted chat, plaintext claiming to be from it is a downgrade and is
    // refused. Otherwise it is delivered marked as an unverified claim (Instar before step 9 sends
    // ordinary chat in plaintext). It never counts as a credential, and we never reply in plaintext.
    const pin = this.keys.getProfileByFingerprint(from);
    if (!pin?.peerIdentityPub) return { kind: 'message', text, type, encrypted: false, credential: false };
    if (this.encryptedChatSeen(from)) return { kind: 'refused', reason: 'plaintext from a paired agent that has sent encrypted messages before (possible downgrade)' };
    const signed = typeof env.signature === 'string'
      && verify(Buffer.from(pin.peerIdentityPub, 'hex'), Buffer.from(canonicalizeEnvelope(env as Record<string, unknown>), 'utf-8'), Buffer.from(env.signature, 'base64'));
    return signed
      ? { kind: 'message', text, type, encrypted: false, credential: false, fromPairedPeer: true }
      : { kind: 'message', text, type, encrypted: false, credential: false, unverifiedPairedClaim: true };
  }

  /** The newest pairing events as plain lines, for the inbox. */
  systemLines(limit = 5): string[] {
    const attention = this.storeProblems.map((p) => `${p.at} Pairing ATTENTION: ${p.message} Pairings recorded in it are not in use until the file is repaired; tell your person.`);
    return [...attention, ...this.recent.slice(0, limit).map((r) => `${r.at} ${describePairingEvent(r.event)}`)];
  }

  /** Recent pairing events (accepts waiting, leak alarms, paired), newest first. Never secrets. */
  recentEvents(): StandaloneEvent[] {
    return [...this.recent];
  }

  /** Invites waiting for this person's Finish (used, with an acceptor, undecided, not leaked). */
  waitingToFinish() {
    return this.invites.list().filter((i) => i.state === 'used' && i.acceptor && !i.decision && !i.secondAccept);
  }
}
