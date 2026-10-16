/**
 * Pinned keys and the credential gate, framework-free (spec threadline-standalone-pairing D1, D7).
 *
 * `InviteTrust` is the surface the pairing engine needs. Instar's AgentTrustManager satisfies it
 * structurally. `PinnedKeyStore` is the standalone implementation: one 0600 JSON file of
 * fingerprint → pinned identity key + pairing state, with Instar's invite semantics:
 *  - recordInviteAccepted: pin the inviter as `invite-accepted` (NOT credential-eligible). An
 *    existing verified pin for the same key is left alone.
 *  - markInviteVerified: → `mutual-verified`, records the pairing id. Never swaps a pinned key.
 *  - demoteInvitePairing: back to `invite-accepted` (a leaked invite was used twice).
 * Only `mutual-verified` with a pinned key counts for anything security-relevant. A
 * self-assigned contact label never does.
 */

import fs from 'node:fs';
import path from 'node:path';
import { derivePairingId, edPublicToX25519 } from './crypto.js';

export type PairingState = 'invite-accepted' | 'mutual-verified' | 'identity-verified' | 'pending-verification' | 'verification-failed';

export interface PeerProfile {
  agent: string;
  fingerprint?: string;
  peerIdentityPub?: string;
  pairingState?: string;
  pairingId?: string;
  verifiedAt?: string;
}

/** What the pairing engine needs from a trust store. Instar's AgentTrustManager fits this shape. */
export interface InviteTrust {
  getProfileByFingerprint(fp: string): PeerProfile | null | undefined;
  recordInviteAccepted(fp: string, args: { peerIdentityPub: string; displayName?: string; ownFp?: string }): boolean;
  markInviteVerified(fp: string, args: { peerIdentityPub: string; displayName?: string; ownFp?: string; via: string; ownIdentityPub?: string }): boolean;
  demoteInvitePairing(fp: string, reason: string): boolean;
}

interface StoredPeer {
  agent: string;
  fingerprint: string;
  peerIdentityPub: string;
  pairingState: PairingState;
  pairingId?: string;
  verifiedAt?: string;
  updatedAt: string;
  via?: string;
}

export const PINNED_KEYS_FILE = 'pinned-keys.json';
const FP = /^[0-9a-f]{32}$/;
const KEY = /^[0-9a-f]{64}$/;

export class PinnedKeyStore implements InviteTrust {
  private readonly file: string;
  private peers = new Map<string, StoredPeer>();

  constructor(stateDir: string, private readonly now: () => Date = () => new Date()) {
    this.file = path.join(stateDir, 'threadline', PINNED_KEYS_FILE);
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { peers?: StoredPeer[] };
      for (const p of raw.peers ?? []) if (FP.test(p.fingerprint) && KEY.test(p.peerIdentityPub)) this.peers.set(p.fingerprint, p);
    } catch { /* no file yet, or unreadable: nothing is pinned, which is the safe default */ }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ peers: [...this.peers.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  getProfileByFingerprint(fp: string): PeerProfile | null {
    const p = this.peers.get(String(fp || '').toLowerCase());
    return p ? { ...p } : null;
  }

  list(): PeerProfile[] {
    return [...this.peers.values()].map((p) => ({ ...p }));
  }

  private valid(fp: string, key: string, ownFp?: string): boolean {
    return FP.test(fp) && KEY.test(key) && key.slice(0, 32) === fp && !(ownFp && fp === ownFp.toLowerCase());
  }

  recordInviteAccepted(peerFp: string, args: { peerIdentityPub: string; displayName?: string; ownFp?: string }): boolean {
    const fp = String(peerFp || '').toLowerCase();
    const key = String(args.peerIdentityPub || '').toLowerCase();
    if (!this.valid(fp, key, args.ownFp)) return false;
    const cur = this.peers.get(fp);
    if (cur && cur.peerIdentityPub === key && (cur.pairingState === 'mutual-verified' || cur.pairingState === 'identity-verified')) return true;
    if (cur && cur.peerIdentityPub !== key && cur.pairingState === 'mutual-verified') return false; // never swap a verified pin
    this.peers.set(fp, { agent: args.displayName || cur?.agent || fp.slice(0, 8), fingerprint: fp, peerIdentityPub: key, pairingState: 'invite-accepted', updatedAt: this.now().toISOString() });
    this.save();
    return true;
  }

  markInviteVerified(peerFp: string, args: { peerIdentityPub: string; displayName?: string; ownFp?: string; via: string; ownIdentityPub?: string }): boolean {
    const fp = String(peerFp || '').toLowerCase();
    const key = String(args.peerIdentityPub || '').toLowerCase();
    if (!this.valid(fp, key, args.ownFp)) return false;
    const cur = this.peers.get(fp);
    if (cur && cur.peerIdentityPub !== key && cur.pairingState !== 'verification-failed') return false; // re-pair to change a key
    const now = this.now().toISOString();
    this.peers.set(fp, {
      agent: args.displayName || cur?.agent || fp.slice(0, 8), fingerprint: fp, peerIdentityPub: key, pairingState: 'mutual-verified',
      pairingId: args.ownIdentityPub ? derivePairingId(Buffer.from(args.ownIdentityPub, 'hex'), Buffer.from(key, 'hex')) : undefined,
      verifiedAt: now, updatedAt: now, via: args.via,
    });
    this.save();
    return true;
  }

  demoteInvitePairing(peerFp: string, reason: string): boolean {
    const fp = String(peerFp || '').toLowerCase();
    const cur = this.peers.get(fp);
    if (!cur) return false;
    this.peers.set(fp, { ...cur, pairingState: 'invite-accepted', verifiedAt: undefined, updatedAt: this.now().toISOString(), via: `paused: ${reason}` });
    this.save();
    return true;
  }

  /**
   * Same name and meaning as Instar's: may a credential go to this peer at all? True only for a
   * `mutual-verified` pin with a recorded pairing id. (`credentialSendKey` also checks that the
   * pairing id still matches our current key and returns the key to encrypt to.)
   */
  isCredentialShareAllowedByFingerprint(peerFp: string): boolean {
    const p = this.peers.get(String(peerFp || '').toLowerCase());
    return !!p && p.pairingState === 'mutual-verified' && !!p.pairingId;
  }

  /** Forget a peer entirely (the person chose to unpair). */
  forget(peerFp: string): boolean {
    const ok = this.peers.delete(String(peerFp || '').toLowerCase());
    if (ok) this.save();
    return ok;
  }
}

export type CredentialDecision =
  | { allow: true; peerIdentityPub: Buffer; x25519: Buffer }
  | { allow: false; reason: 'peer-not-mutually-verified' | 'encryption-key-not-bound' };

/**
 * May a credential go to `peerFp`? (Instar's CredentialShareGate rules, spec D7.) Allowed only
 * when the peer is `mutual-verified` with a pinned key AND the pairing still matches our current
 * key (so a rotated own key re-requires pairing). Returns the ONLY key a credential may be
 * encrypted to: the X25519 key derived from the PINNED identity key, never one the relay
 * supplied. Fail-closed: any error refuses.
 */
export function credentialSendKey(trust: Pick<InviteTrust, 'getProfileByFingerprint'>, peerFp: string, ownIdentityPubHex: string): CredentialDecision {
  try {
    const p = trust.getProfileByFingerprint(String(peerFp || '').toLowerCase());
    if (!p || p.pairingState !== 'mutual-verified' || !p.peerIdentityPub || !KEY.test(p.peerIdentityPub)) return { allow: false, reason: 'peer-not-mutually-verified' };
    const pin = Buffer.from(p.peerIdentityPub, 'hex');
    if (!p.pairingId || p.pairingId !== derivePairingId(Buffer.from(ownIdentityPubHex, 'hex'), pin)) return { allow: false, reason: 'encryption-key-not-bound' };
    return { allow: true, peerIdentityPub: pin, x25519: edPublicToX25519(pin) };
  } catch {
    return { allow: false, reason: 'peer-not-mutually-verified' };
  }
}

/** May a credential that ARRIVED from `senderFp` be accepted? Only from a mutual-verified peer. */
export function credentialAcceptFrom(trust: Pick<InviteTrust, 'getProfileByFingerprint'>, senderFp: string): boolean {
  try {
    const p = trust.getProfileByFingerprint(String(senderFp || '').toLowerCase());
    return !!p && p.pairingState === 'mutual-verified' && !!p.peerIdentityPub;
  } catch {
    return false;
  }
}
