# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

> **Catch-up note.** This change merged and shipped on 2026-10-21 with no release note of its own, so it reached users unannounced. Its presence in the published 1.3.1374 and 1.3.1375 packages was confirmed by reading the package contents, not by their version numbers.

- **A message pasted into a session is recovered or announced, never silently abandoned (#2250 — merged and shipped 2026-10-21, unannounced).** Stage B fences a recovery keypress behind the durable delivery row that authorized the original injection, but those rows are prepared for `codex-cli` only — so on every other framework `fireStuckInputRecovery` returned `refused` / `missing-durable-delivery-evidence` without pressing anything. One agent's event log carried **75,001 consecutive such refusals, every one at attempt 0**: the ladder never advanced, never exhausted, and never escalated, re-asking the same impossible keypress every ten seconds while the logs recorded that recovery had happened. The fence now applies where its evidence can exist and falls through to the pre-Stage-B best-effort keypress where it structurally cannot — the same untracked path the session's own injection already takes. `verifyInjection` consumes the recovery result instead of discarding it, ends on a verify-only pass, and reports `Recovery keypress sent; outcome reported by the verification pass that follows` rather than the previous `Recovered without user intervention`, which was asserted before anything had been checked. `StuckInputSentinel` now carries a refusal budget: after `maxAttempts` consecutive refusals it raises one `undeliverable` alarm (attention item plus a line in the topic) and marks the draft exhausted, so an impossible recovery becomes an honest terminal state instead of an infinite retry.

## What to Tell Your User

If you send me something and it lands in my input box without being submitted, I will now actually press Enter for you — and if I genuinely cannot, you get told once that your message was not delivered, instead of nothing. Before, on some of my agents, that recovery could never succeed and never gave up, so a message could sit unsent for half an hour while my own logs claimed it had recovered.

This change is already running on your machines — it reached you on 2026-10-21. This note is the plain-language explanation you should have had at the time.

## Summary of New Capabilities

- `fireStuckInputRecovery` returns `{status: 'attempted' | 'effect-unknown' | 'refused'}`, and the Stage B fence is scoped to frameworks whose delivery rows exist.
- `StuckInputSentinel` refusal budget → one `undeliverable` escalation; `SessionManager.markStrandedDraftExhausted`.
- `onUndeliverable` wired in `server.ts` to the attention queue and the bound topic.

## Evidence

- `tests/unit/stuck-input-undelivered-alarm.test.ts` (10): the fence falls through where no row can exist and still holds where one can; the budget raises exactly one alarm and marks the draft exhausted.
- Live diagnosis, indra 2026-10-20: 75,001 of 75,328 rows `Enter/refused` at attempt 0, zero `undeliverable`; two operator messages sat unsubmitted for 28 minutes across three sessions on two machines.
