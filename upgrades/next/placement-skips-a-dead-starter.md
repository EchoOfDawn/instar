# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

> **Catch-up note.** This change merged and shipped on 2026-10-21 with no release note of its own, so it reached users unannounced. Its presence in the published 1.3.1374 and 1.3.1375 packages was confirmed by reading the package contents, not by their version numbers.

- **A conversation is no longer placed on a machine that cannot start a session (#2252 — merged and shipped 2026-10-21, unannounced).** Placement already avoided a machine whose account quota was exhausted or whose LLM circuit was open, because routing a conversation there is silence the user has to discover. A machine that cannot start a session **at all** was not covered — and it is the one cause that makes a machine look *best* rather than worst: no load, no sessions, untouched quota. On the Mac Mini (2026-10-20) two pool logins had never recorded folder trust, so every Claude session launched under them died in 16 seconds at a dialog whose default option is "No, exit"; the operator's conversation had been placed there, spawned three times in 35 minutes, died three times, and placement kept it there throughout. A new `SessionStartFailureTracker` counts consecutive startup deaths inside a 15-minute window (default threshold 3) and reports the machine as unable to start work; a single successful start clears it completely, so a machine that recovers is re-admitted with no operator action. The signal is fed from the existing `sessionExited` path (`reason: 'process-exited-during-startup'`) and the new `sessionStartSucceeded` event, rides the existing capacity heartbeat, and joins the existing placement-eligibility signal rather than adding new plumbing. The transition into the blocked state raises one attention item.

## What to Tell Your User

If one of my machines is broken in a way that kills every session it starts, I will stop sending your conversations there after the third failure instead of retrying into silence, and I will tell you that machine cannot start work. When it recovers, it starts taking work again on its own.

This change is already running on your machines — it reached you on 2026-10-21. This note is the plain-language explanation you should have had at the time.

## Summary of New Capabilities

- `src/core/startFailureTracker.ts` — `SessionStartFailureTracker`, `DEFAULT_START_FAILURE_WINDOW_MS` (15 min), `DEFAULT_START_FAILURE_THRESHOLD` (3).
- `computeSelfQuotaState(..., startFailure?)` carries the cause; `MachinePoolRegistry.recordHeartbeat` replicates it; `PlacementExecutor.decide()` consumes it.
- `SessionManager` emits `sessionStartSucceeded`; one `machine-cannot-start-sessions` attention item per transition.

## Evidence

- `tests/unit/start-failure-placement.test.ts` (17): both sides of the threshold and the window; a success clears it; the cause reaches the placement decision.
- `tests/e2e/placement-start-failure-alive.test.ts` (3): the real `AgentServer` stack reports the honest answer out of `GET /pool/placement` and `GET /pool`.
