# A paused invite pairing is unpaused when another of the agent's machines verifies it

## What Changed

When an invite pairing is paused (its invite was used twice) and another of the same agent's machines later verifies that agent, the pause now ends on this machine too, but only if that verification was made after the pause. A verification from before the pause, or one with no usable time, keeps the pause. Before, the pairing became verified but kept a stale pause marker, which would have refused a later invite Finish from that agent. Also added: a code comment on how the pause must be read, and a note in the side-effects review that keys pinned before the weak-key check are not re-checked.

## What to Tell Your User

Nothing changes in normal use. If an invite pairing was paused and the agent was then verified from another of your agent's machines, it now counts as verified everywhere, with no leftover pause, as long as that verification happened after the pause.

## Summary of New Capabilities

- None new. A paused invite pairing no longer stays paused after the same agent is verified from another of your agent's machines.

## Evidence

- `tests/unit/threadline/threadline-core-trust-followups.test.ts`: a newer replicated verification clears the pause; an older, equal-time, missing or unparsable one keeps it. Each rule is mutation-checked.
