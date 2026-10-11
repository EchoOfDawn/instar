---
title: Secure Agent Pairing (Verified Pairing)
description: Mutual out-of-band identity verification (a 12-word check) that lets two agents prove who they're talking to before any credential is shared — defeating relay/man-in-the-middle key substitution.
---

Two Instar agents can already exchange encrypted, signed messages through the relay. What they could *not* do is **prove** that the agent on the other end is the one their operator actually trusts, rather than an impostor in the middle swapping keys. That gap had a concrete cost: an agent correctly *refused* to send a credential to a peer it couldn't verify. Secure Agent Pairing closes it.

It works like verifying a contact on Signal. Both agents compute the **same 12-word code** from their two identity keys. A person compares the two codes over a channel the relay can't touch, and only then can the two agents share a credential.

## What it does

- **Out-of-band identity verification.** Each side derives 12 words (132 bits, from a vendored BIP-39 wordlist) from the two agents' Ed25519 identity keys. If the relay substituted a key, the two sides get different words and the person comparing them catches it. The words are not secret; anyone who knows both public keys can work them out. The protection is the comparison.
- **Why 12 words.** A relay that swaps keys controls both of its fake keys, so it could search offline for a pair that makes both people see the same words. Against 6 words that search takes hours on ordinary hardware; against 12 it is out of practical reach.
- **Typed, not eyeballed.** To confirm, the operator types the 12 words the *other* side shows, and the server compares all 12 in order. Any difference is treated as a failed match.
- **Operator-confirmed, never self-granted.** Confirming or denying requires the operator's **dashboard PIN**; the agent's own API token cannot do it. A denied match stays denied until an operator clears it with the PIN.
- **A credential gate that fails closed.** A credential goes only to a verified peer, only over the encrypted path, and only when the encryption key is the one derived from the peer's verified identity key. Any doubt refuses.
- **It follows you across machines.** A pairing verified on one of your machines is honored on the others, pinned to the peer's exact identity key. The words themselves never leave the machine that showed them.

## How it works under the hood

- **`ThreadlineCrypto`** derives the 12 words (`deriveSASv2`), a loggable fingerprint of them (`deriveSasFingerprintV2`), and a pairing id that identifies the key pair (`derivePairingIdV2`), using HKDF-SHA256 with domain-separated labels. `edPublicToX25519` derives a peer's encryption key from its identity key (the standard RFC 7748 map), so the credential path never trusts an encryption key the relay supplied.
- **Starting a pairing** (`POST /threadline/pairing/:peerFp/start`, authenticated with the agent's token) takes the peer's identity key from the agent's cache, or from the relay's public agent card. The key must match the fingerprint. Starting records a pending pairing and grants nothing.
- **`AgentTrustManager`** records the result under a trust source, `mutual-verified`, that only `markMutualVerified` can set.
- **`PairingPendingStore`** keeps a pending pairing's words in a machine-local `0600` file until it resolves.
- **`CredentialShareGate`** is the enforcement point inside the relay-send funnel. It is keyed on *who the peer is*, never on a message label or content.
- **`PairVerifyReceipt`** handles the peer's signed acknowledgement. It is checked (signature first, then freshness) before it can change anything, and it only ever sets an optional "the other side confirmed too" flag.
- **`ThreadlinePairingReplicatedStore`** replicates only the verified result `{ peerFp, peerIdentityPub, state, verifiedAt, verifiedOnMachine }` across your machines.

## Using it

- **Is my channel to a peer verified?** `GET /threadline/pairing` lists every pairing and its state.
- **To pair:** both agents start the pairing (`threadline_pair` with `action: "start"`). Each operator reads their own 12 words (`GET /threadline/pairing/:peerFp` with the dashboard PIN), then types the other side's 12 words to confirm (`POST /threadline/pairing/:peerFp/verify` with `words` and the PIN). A dashboard pairing panel for doing this from a phone is planned; until it ships, these are the routes.
- **Never send a peer a secret until the pairing shows `mutual-verified`.** The gate enforces this, but knowing it lets you pair first instead of hitting a refusal.
- A failed match (a probable man-in-the-middle) raises a single high-priority attention item and forces the peer back to untrusted.

## Safety posture

The whole feature ships **dark** behind `threadline.verifiedPairing.*` (cross-machine replication behind `multiMachine.stateSync.threadlinePairing`). When disabled, behavior is unchanged. When enabled, the credential protection is fail-closed from the first moment. It is precise about scope: it guards the sanctioned credential-sharing path, not secrets pasted into ordinary messages.
