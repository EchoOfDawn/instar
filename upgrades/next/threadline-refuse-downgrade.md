# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **No downgrade after encryption.** When an agent paired by invite sends this agent an encrypted message, and the signature matches the key pinned when the two people paired, Instar now remembers that (`encryptedSeenAt` on the trust profile). After that, a plaintext message in that agent's name can only be the relay's word, so it is refused. Pairing messages and credentials do not count, because they are always encrypted. Spec: `docs/specs/threadline-standalone-pairing.md` (D6, D11, rollout step 6).
- **Live switch `threadline.refuseDowngrade`** (`{ enabled?, dryRun? }`, the same gate as `threadline.encryptToPinned`: live on a development agent, dark on the fleet, `dryRun` defaults true). Off: nothing is recorded or refused. Watch: the fact is recorded, and plaintext that would have been refused is counted (`wouldRefuseDowngrade`) and delivered. Enforce: it is refused (`refusedDowngrade`). Mode and counters: authed `/health` → `threadline.refuseDowngrade`. Listed on `/guards` as `a2aRefuseDowngrade`.
- **One record across the agent's machines.** With pairing replication on (`multiMachine.stateSync.threadlinePairing.enabled`), each machine shares what it recorded, every machine keeps the earliest time any of them saw, and only the person unpairing removes it. So a relay cannot get plaintext through by aiming at whichever machine takes over.
- Agents paired the older way, by comparing words, keep the rule they had.
- `@sagemindai/threadline-core` gains `earliestMark`, `unifyEncryptedSeen` and `PinnedKeyStore.mergeEncryptedSeen`, the shared rule for the record. Instar carries an identical copy (checked by a parity test) until a core release exporting it is published and Instar's pin moves to it.

## What to Tell Your User

If you paired me with another agent using an invite, and that agent has sent me an encrypted message, I can now refuse unencrypted messages that claim to come from it, because those could have been written by the relay in between. This is off by default. If that agent's owner ever goes back to an older version that sends unencrypted messages, unpair and pair again.

## Summary of New Capabilities

- `threadline.refuseDowngrade` (off | watch | enforce), read live.
- `AgentTrustManager.markEncryptedSeen` / `mergeEncryptedSeen`; the trust profile's `encryptedSeenAt`.
- Replicated mark and unpair records on the `threadline-pairing-record` stream.

## Evidence

- Two real agents on a real relay (`tests/e2e/threadline/pairing-invite-production-path.test.ts`): the switch changed live from off to watch to enforce and back; enforce refuses the plaintext and a later encrypted message still arrives; an SAS pairing is not refused.
- Two machines on the real replication stream (`tests/unit/threadline/refuse-downgrade-replication.test.ts`): a mark set on one appears on the other, which then refuses; unpairing removes it on both.
- Breakage checks: 19 tried, 19 caught.
