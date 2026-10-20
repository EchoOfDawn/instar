# Instar uses @sagemindai/threadline-core for invite pairing

## What Changed

Instar now depends on `@sagemindai/threadline-core` at exactly 0.1.0, the package `threadline-mcp` already uses, and takes its invite pairing from it instead of keeping its own copy (spec `threadline-standalone-pairing`, D1 and rollout step 3). `src/threadline/PairingInvite.ts`, `PairingInviteFlow.ts` and `PairingInviteStore.ts` are now re-exports of core, under the same paths and names, so nothing else in Instar changed its imports. The identity-key helpers that are the same code in both (key generation, signing, X25519 exchange, the Ed25519 to X25519 key maps, the fingerprint, the pairing id) also come from core. `AgentTrustManager` declares that it implements core's `InviteTrust`. The SAS word list, the Telegram and dashboard pairing screens, `AgentTrustManager` itself, `verify` and the `MessageEncryptor` class stay in Instar, because core's versions of those behave differently in small ways (listed in the side-effects review).

An Instar agent and a `threadline-mcp` agent now run the same invite code, so the two cannot drift. Wire formats are unchanged.

Behaviour that changes, all from fixes already made in core:

- The invite message uses the same host-neutral words as `threadline-mcp`: it tells the person to ask their agent to open a Threadline invite and paste it into the box shown, not into the chat, and, for an Instar agent, to forward it to its Telegram or paste it in its dashboard. It also says the invite works once.
- Names the other agent chose are cleaned more thoroughly before they are shown: bidirectional overrides, zero-width characters and C1 control characters are removed, and the text is NFKC-normalised.
- On the receiving side, a Finish is accepted only for an invite this agent's person approved, from that inviter, for that invite, at most 24 hours after it expired, and only once (a retried Finish is acknowledged again without changing anything). An invite approved before this upgrade and finished after it is refused; the person sends a new invite.
- If the accept cannot be sent (the relay is not connected), Approve now says so and keeps the invite waiting to be approved again, instead of failing with an error.
- `pairing-invites.json` also records the invites this agent approved. If the file is not valid JSON it is moved aside as `pairing-invites.json.unreadable-<time>` and reported, instead of being silently replaced. If it cannot be read at all, invite pairing is turned off with a logged error, and the rest of Threadline keeps running.

## What to Tell Your User

Pairing works as before. The invite message now has the same wording whether it comes from an Instar agent or from an app running threadline-mcp, and it says where to paste it in either. If you approved an invite just before this update and the other side had not finished yet, ask them to send a new one.

## Summary of New Capabilities

- None for the user. Instar and threadline-mcp now share one implementation of invite pairing, published as `@sagemindai/threadline-core`. A fix to it is published once, then Instar bumps its exact pin.

## Evidence

- Instar's own pairing suites run unchanged against core: `tests/unit/threadline/PairingInvite.test.ts`, `PairingInviteFlow.test.ts`, `PairingInviteStore.test.ts`, `PairingInviteTelegram.test.ts`, `tests/unit/pairing-invite-never-persisted.test.ts`, `tests/integration/pairing-invite-telegram-routes.test.ts`, and the end-to-end `tests/e2e/threadline/pairing-invite-production-path.test.ts`, `pairing-invite-failure-paths.test.ts` and `standalone-instar-pairing.test.ts` (an Instar agent pairing with threadline-mcp in both directions).
- `tests/unit/threadline/threadline-core-compat.test.ts`: envelopes encrypted by core decrypt in Instar's `MessageEncryptor` and the reverse, and both derive the same fingerprints, X25519 keys and pairing ids.
- `npx tsc --noEmit` passes with `AgentTrustManager implements InviteTrust`.
