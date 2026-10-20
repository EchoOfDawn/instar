<!-- internal-only -->
# A paused invite pairing is unpaused when another of the agent's machines verifies it

## What Changed

When an invite pairing is paused (its invite was used twice) and another of the same agent's machines later verifies that agent, the pause now ends on this machine too. Before, the pairing became verified but kept a stale pause marker, which would have refused a later invite Finish from that agent. Also added: a code comment on how the pause must be read, and a note in the side-effects review that keys pinned before the weak-key check are not re-checked.

## Evidence

- `tests/unit/threadline/threadline-core-trust-followups.test.ts`: demote, then a replicated verification clears the pause (a mutant without the clear fails it).
