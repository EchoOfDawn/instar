# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- Ordinary chat to an agent paired by invite is now always encrypted, to the identity key pinned when the two people paired. Before this, an Instar agent encrypted only when the relay had handed it the peer's keys during the current session; after a restart, or for a peer the relay had not described yet, it sent plaintext, even to a paired peer. `ThreadlineClient.sendAuto` now asks a new resolver (`setEncryptToResolver`) first, and `hasEncryptedSendPath` reports the pinned path too. Spec: `docs/specs/threadline-standalone-pairing.md` (approved r5.2; D9, D11, rollout steps 5 and 5b).
- The resolver returns a key only for peers that are `mutual-verified` AND were paired by invite. An acceptor still waiting for the inviter's Finish keeps the old rule, because the inviter cannot read a message encrypted by an agent it holds no key for yet. A peer paired by the older SAS method keeps the old rule too, because it may run a version from before 1.3.1345, which cannot decrypt to a pinned key without a cached one. Both sides of an invite pairing run 1.3.1352 or later, which can.
- **Explicit pairing method.** Trust profiles now record `pairingMethod` (`invite`, `sas` or `inherited`). The resolver keys on `pairingMethod === 'invite'` rather than on a missing SAS fingerprint (an inherited pairing has none either). Profiles from before the field are backfilled on load: a `mutual-verified` profile gets `sas` when it holds a SAS fingerprint, else `invite`; an existing value is never overwritten.
- **Live switch `threadline.encryptToPinned`** (`{ enabled?, dryRun? }`, same gate as `threadline.relayUnknownSenderTrust`: `enabled` omitted is live on a development agent and dark on the fleet; `dryRun` defaults true). Off: today's behaviour. Watch (`dryRun` not false): sends unchanged; each send that would have gone encrypted to the pinned key is counted (`wouldEncryptToPinned`). Enforce (`dryRun: false`): encrypted to the pinned key. Mode and counters: authed `/health` → `threadline.encryptToPinned`.
- **Never plaintext in enforce.** When the pinned send cannot be built or handed to the relay, `sendAuto` throws ("no plaintext fallback") instead of trying the relay-key or plaintext paths.
- **Every chat send path, and fail closed.** The pinned rule now covers every send method that can carry ordinary chat, including `sendPlaintext` (a collaboration re-drive nudge to an invite-paired peer now goes encrypted). In enforce, a peer whose pin cannot be looked up, or whose pinned key is malformed, is refused rather than sent plaintext (502 on relay-send; counters `lookupErrors`, `resolverErrors`, `malformedPinnedKey`). A refused re-drive nudge is not counted as a re-drive, and a refused a2a redelivery is not counted as redelivered.
- **Receive-side label (enforce only, never a refusal).** Plaintext ordinary chat under the fingerprint of an invite-paired, mutual-verified peer is delivered with a fixed server notice ("unverified sender … the relay could have written it") and at no more than `verified`. Watch counts it (`wouldLabelUnverified`).
- **Pairings follow the agent across its machines (step 5b).** With pairing replication on (`multiMachine.stateSync.threadlinePairing.enabled`, default off and unchanged), the replicated pairing record carries `pairingMethod` as an optional sixth field, and every merge (and once at startup) inherits the replicated pin on the agent's other machines, so whichever machine holds the relay connection encrypts to the same pinned key. An invite pairing is never downgraded by a record from an older machine, and a pairing made on a machine is never overridden by a replicated one. On upgrade, local invite pairings re-send their record so the method reaches the other machines.
- **Unpairing reaches every machine.** The revoke record names the pinned key; every other machine forgets the pairing it inherited for that key (never a pairing made locally, never a different key), so it stops encrypting to that peer and stops sending it credentials. A newer pairing record after the revoke wins.
- **Startup warning.** A machine of a multi-machine agent logs a warning when `encryptToPinned` is enforce and pairing replication is off.
- **relay-send answers 502** when an enforced pinned send fails; nothing is recorded as sent, and a standby forwarding through the relay holder gets that 502 back.
- Decrypting is unchanged. Every version that can pair by invite already decrypts messages encrypted to its pinned key.

## What to Tell Your User

If you paired me with another agent using an invite, everything I send that agent is now encrypted, every time. Before, my ordinary messages to it went out unencrypted after I restarted, until the relay reminded me of its keys. Secrets were already protected and still are. Agents you paired the older way, by comparing words, work exactly as before.

## Summary of New Capabilities

- `ThreadlineClient.setEncryptToResolver(fp => Buffer | null)`: the pinned key to always encrypt ordinary chat to.
- Invite-paired, mutual-verified peers: ordinary chat always encrypted to the pinned key.

## Evidence

- `tests/e2e/threadline/pairing-invite-production-path.test.ts`, new case on two real Instar agents and a real relay with both key caches cleared. Before Finish, the acceptor's message arrives in plaintext and is not lost. After Finish, both directions arrive encrypted. A pairing marked as SAS-made goes back to the old rule.
- `tests/unit/ThreadlineClient-encrypt-to-pinned.test.ts` (4): the pinned key and its derived X25519 are used with no cached keys, and the resend flag is carried; the pinned key takes precedence over relay-supplied keys; a key for another agent, or a resolver that throws, is ignored; with no resolver, behaviour is unchanged.
- `tests/unit/threadline/encrypt-to-pinned-switch.test.ts` (17) and `tests/unit/threadline/pairing-replication-merge.test.ts` (35, step 5b, on the real replication journal, applier and stream reader).
- Breakage checks on the pre-rebase branch: 6 tried, 6 caught. Threadline suites on this branch (main after #2229 plus this change): unit 137 files / 2,983 tests, integration 48 / 483, e2e 48 / 454 (444 pass, 10 skipped), all passing.
