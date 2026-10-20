# Invite pairing: paused pairings stay paused, weak keys are refused, and a broken invite store shows in health

## What Changed

Three follow-ups to Instar taking invite pairing from `@sagemindai/threadline-core` (spec `threadline-standalone-pairing`, step 3).

- **A paused pairing stays paused.** When an invite is used by two agents, the agent that accepted first is paused (spec `a2a-pairing-invite-link` §4.4.2). The shared invite code refuses a late Finish for a paused pairing, but it could not see Instar's pause because Instar did not record it. Instar now records the pause on the trust profile and shows it to the invite code. A Finish that arrives after the pause is refused, and the pairing stays unverified until a new invite completes. The pause survives a restart. A new invite approved by the person, a completed pairing, or a 12-word confirm ends it.
- **Weak identity keys are refused when pinning.** A small-order or non-canonical identity key is now refused on every path that pins one: the invite accept and finish, the 12-word pairing (start, pending, and the copy inherited from another of the agent's machines). This matches what threadline-core already does (spec D8, SEC-16). A real agent's key is never weak, so real pairings are unaffected. Starting a 12-word pairing with such a key returns a clear refusal from the pairing route.
- **"Invite pairing is off" now shows in health.** If `threadline/pairing-invites.json` cannot be read, invite pairing is turned off and the rest of Threadline keeps running, as before. That used to be only a log line. It is now reported as a degradation, so it appears in `/health` and in the degradation digest. The file is still left untouched.

## What to Tell Your User

Nothing changes in normal use. If an invite you sent was used twice and the first pairing was paused, a late Finish no longer completes it; send a new invite. If invite pairing ever turns off because its file cannot be read, the agent's health report now says so.

## Summary of New Capabilities

- None new for the user. The health report now covers invite pairing being off.

## Evidence

- `tests/unit/threadline/threadline-core-trust-followups.test.ts`: real AgentTrustManager with the real threadline-core invite engine. Demote, then a late Finish: refused, pin stays unverified (control: without the pause the Finish promotes). Pause survives restart and is not written as `via`. A new invite from the same agent completes, and a 12-word confirm also ends the pause. Small-order and non-canonical keys refused on all five pinning paths, real keys accepted.
- `tests/e2e/threadline/pairing-invite-store-unreadable.test.ts`: real `bootstrapThreadline` on a real relay with an unreadable invite store: still connected, invite pairing off, one `Threadline.pairingInvites` degradation, file untouched (control: a readable store reports nothing).
- Mutation checks: each of the 11 code changes, removed on its own, turns at least one of these tests red.
