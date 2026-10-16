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
  credentialAcceptFrom, credentialSendKey, edPublicToX25519, findInviteToken,
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
  | { kind: 'message'; text: string; type?: string; encrypted: boolean; credential: boolean; fromPairedPeer?: boolean }
  | { kind: 'refused'; reason: string };                  // e.g. an encrypted message from an unpinned sender

export interface StandaloneEvent { at: string; event: InviteEvent }

export class StandalonePairing {
  readonly flow: PairingInviteFlow;
  readonly keys: PinnedKeyStore;
  readonly invites: PairingInviteStore;
  readonly events = new EventEmitter();
  private readonly crypto: EnvelopeCrypto;
  private readonly recent: StandaloneEvent[] = [];
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
    this.keys = new PinnedKeyStore(deps.stateDir, this.now);
    this.invites = new PairingInviteStore(deps.stateDir, this.now);
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
      if (credential && !credentialAcceptFrom(this.keys, from)) return { kind: 'refused', reason: 'credential from a peer that is not mutual-verified' };
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
    // Plaintext from a PAIRED agent is delivered but marked unencrypted (Instar 1.3.1352 still
    // encrypts ordinary chat only when the relay gave it our X25519 key; spec step 9 makes Instar
    // encrypt to pinned peers). It can never count as a credential, and we never reply in plaintext.
    if (findInviteToken(text)) return { kind: 'refused', reason: 'a pairing invite arrived as a message; invites are pasted by a person, not relayed' };
    const pin = this.keys.getProfileByFingerprint(from);
    return { kind: 'message', text, type, encrypted: false, credential: false, fromPairedPeer: pin?.pairingState === 'mutual-verified' };
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
