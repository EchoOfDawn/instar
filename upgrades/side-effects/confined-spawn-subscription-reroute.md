# Side-Effects Review — confined spawns on the subscription (rerouted interactive) lane

**Version / slug:** `confined-spawn-subscription-reroute`
**Date:** `2026-10-19`
**Author:** `Echo`
**Spec:** `docs/specs/confined-spawn-subscription-reroute.md` (converged at round 12; see its report)
**Second-pass reviewer:** required (session lifecycle, confinement, a gate). See the end of this file.

## Summary of the change

Under `intelligence.subscriptionPath.mode: force` (the operated host's mode), `SessionManager.spawnSession` refused every confined spawn (`confinement-reroute-unsupported`). The feedback executor spawns both its session canary and every build confined, so no executor attempt could ever run, even after the operator's approver tap. This change gives the rerouted interactive lane the same confinement as the headless lane:
- one shared adapter (`applyClaudeConfinement`): no permission bypass, `dontAsk`, the confined tool list, `env -i` plus an allowlist, and the attempt temp dir;
- no agent authority in the tmux env;
- the prompt delivered as a 0600 file behind one fixed typed line (D1);
- a deterministic startup state machine that answers only the measured trust dialog (exact path, verified focus) and the browser offer's safe default, and kills the session on anything else (D2);
- no Instar writer may press a key or type into a confined session except the D2 startup driver while it holds that session: the guard sits at the real chokepoints (`performTmuxInjectionEffect` for text, `sendKey`/`sendKeyAsync`, `performStuckInputKeyEffect`, `detectClaudePrompt`'s consent auto-accept, and the server's `tmuxOps.sendKeys`), and a test enumerates every raw `send-keys` site in SessionManager and the server and requires each to be guarded or allowlisted by name (D3);
- boot kills an undelivered confined rerouted session;
- the executor defers claims while the lane is full and maps a typed `RerouteRefusedError` to `stopped` / `reroute-capacity`, with an exactly-once, capped start refund.

## Decision-point inventory

- `spawnSession` confined + reroute — **modify**: from refuse to launch confined on the interactive lane.
- D2 startup state machine (`confinedStartupDialogs.ts` + `runConfinedStartup`) — **add**: deterministic floor; its only actions are two known safe answers, wait, type one fixed line, or fail-and-kill.
- D3 auto-answerer exclusion for `confinedConfigHome` sessions — **add**: removes authority only.
- `purgeDeadSessions` confined-undelivered kill — **add**.
- Executor admission `reroute-capacity`, plus the `RerouteRefusedError` mapping — **add**: defers or stops, never grants.

## 1. Over-block

- A Claude Code release that rewords either dialog, or the composer/footer, fails closed (`dialog-unknown`) until the fixtures are updated. The canary catches it first, so it shows as the executor's existing `profile-unenforceable` Attention item and the item is untouched.
- A sustained full reroute lane defers executor claims. This is visible: `admission: reroute-capacity`, plus one degradation report after 12 saturated ticks.

## 2. Under-block

- **Named residual:** a key pressed during startup or at submit could land on a dialog that appeared in the milliseconds after the last capture. Launch-fixed controls (env, Bash sandbox, settings sources, MCP) cannot be changed by it. The CLI's own tool-permission state could be, in principle. A post-submit check (the measured `don't ask on` footer, no dialog) detects a mode change and kills the session, but cannot prevent a tool call inside 300 ms. The spec accepts this as Frontloaded Decision 6, versus the status quo of no confined session ever running under `force`.
- The completion sentinel can be spoofed with probability 2^-32 per attempt by pre-written report text. Correctness rests on effects-based judgment, not on completion.
- Trust entries accumulate in the config home's `.claude.json` (about 2,000 a year at the default cadence).

## 3. Level-of-abstraction fit

- Confinement stays in SessionManager (one shared adapter for both lanes).
- The startup protocol is a pure module plus a thin driver.
- Capacity is handled at the executor's existing admission and error-mapping seams.
- The executor's sandbox policy and canary are untouched.

## 4. Signal vs authority compliance

- [x] Deterministic floor holding blocking authority, by design: the decision is "may an unattended process press a key in a security dialog". An exact allowlist with refusal on any deviation is the only acceptable policy, and an LLM there would be the defect.
- [x] Every other addition removes authority (D3) or only defers (admission).

## 5. Interactions

- **Reroute cap/gate:** confined spawns count toward `maxRerouted` like any reroute.
- **PromptGate/AutoApprover and every other pane writer:** on the operated host the PromptGate is enabled with `autoApprove`. Without D3 its Enter on the trust dialog would select `No, exit`. D3 removes that race at the chokepoints, so the `/compact` context-wall recovery, the stuck-input recovery keys, the generic consent auto-accept, paste retries and the server's message delivery all refuse a confined session (a stuck one is ended by its lifetime cap or `killSession`, never nudged). Allowlisted by name, each with its reason beside it: the driver's own fixed-line send; the operator `/interrupt` Escape (a non-typing key that cancels, never accepts); the setup-time login pane; `C-c` to the agent's own server pane.
- **OrphanProcessReaper:** cleans an untracked pane left by a crash between the tmux spawn and the first save.
- **Restart adoption:** headless confined sessions are untouched by the new boot kill; it applies to the rerouted lane only.

## 6. External surfaces

- Operator: none new. Each failure kind has a degradation report class (`SessionManager.confinedSession`, `SessionManager.runConfinedStartup`, `FeedbackExecutor.rerouteCapacity`).
- Install base: only agents running the executor under `force` or `auto` are affected. Every other spawn is byte-for-byte unchanged (pinned by tests).

## 7. Multi-machine posture

- Spawns and `confinedDeliveredAt`: machine-local by design (`physical-credential-locality`: the confined session runs under one machine's Claude login).
- `execution_refunds`: in the canonical drain DB, owner-fenced, backed up with it.

## 8. Rollback cost

Revert the commit. Before downgrading, disable the executor and end live sessions with `confinedConfigHome`, because the reverted code lacks D3. The remaining state is inert.

## Evidence

- **Unit:**
  - `confined-startup-dialogs.test.ts`: measured frames, precedence, the exact-path match, composer shape, state machine.
  - `session-manager-confined-reroute.test.ts`: argv/env pins G1–G9, D1 file delivery, typed refusal, driver echo-then-Enter and post-submit check, D3 exclusion, restart boundary.
  - `execute-reroute-capacity.test.ts`: deferral, typed mapping, exactly-once capped refund, cross-midnight refund.
  - `session-manager-confined-spawn.test.ts`: updated; the forced refusal is gone.
- **E2E:** `confined-reroute-lifecycle.test.ts`. Real tmux, production-shaped config, and a fake TUI that draws the measured dialogs.
- **Live (Mac Studio, 2026-10-19):** the executor's session canary, run through this branch's built `SessionManager` under `force`, in a fresh untrusted workspace with a planted project hook and planted MCP server.
  - The trust dialog was answered, the task was delivered by file, and `confinedDeliveredAt` was recorded.
  - 16/17 probes passed. The planted hook did not run and the planted MCP server did not start (G1/G3 by effect).
  - The one failing probe, `session-git-status`, fails because every Bash command exits 1 on Claude Code 2.1.303's cwd bookkeeping write to `/tmp/claude-501/`, which the executor's sandbox policy does not allow (it allows `/tmp/claude`). That is a sandbox-policy issue independent of the lane, out of this change's scope, and reported as the next executor blocker.

---

## Second-pass review (independent reviewer, run by the coordinating session, 2026-10-19)

**Verdict: Concern raised, otherwise strong.**

Concern: the D3 "refusal enforced at the chokepoint" claim was not true as written. `confinedWriteRefused` guarded `sendKey` and `rawInject`, but raw `tmux send-keys` writers bypassed both: `injectInternalControlCommand` → `performTmuxInjectionEffect` (the `/compact` context-wall recovery), `detectClaudePrompt`'s Down+Enter consent auto-accept, `performStuckInputKeyEffect` (StuckInputSentinel), and the server's `tmuxOps.sendKeys` (MessageDelivery). Practical reach was narrow (a confined session has no topic binding), but the real text chokepoint is `performTmuxInjectionEffect` and the real key chokepoints are those raw execs.

Confirmed without change: launch parity (shared `applyClaudeConfinement`; `--settings` + local source; strict MCP; `dontAsk` + fixed tools; `env -i` allowlist filtered by `isCredentialEnvName`; `CLAUDE_CODE_TMPDIR`/`TMPDIR`; `--session-id` from the executor), the 0600 `wx` task file and the fixed typed line, the startup machine's exact-match answers and bounded failure, the race's bounded persistence, the executor lease/hard-cap bounds; 46/46 tests. Pre-existing note (not new to this change): `anthropicEnvFlags` still put a configured API key into the tmux session env on both lanes while `env -i` keeps it out of the CLI.

**Fix applied (same branch):** the guard now refuses every write to a confined session, before or after delivery, from any writer except the D2 startup driver while it holds that session (`confinedStartupHolders`), and it is consulted at the real chokepoints: `performTmuxInjectionEffect`, `sendKey`, `sendKeyAsync`, `performStuckInputKeyEffect`, `detectClaudePrompt`, and the server's `tmuxOps.sendKeys` (via the public `isConfinedWriteRefused`). `tests/unit/confined-send-keys-chokepoints.test.ts` enumerates every raw `send-keys` / `buildLiteralSendArgs` site in `src/core/SessionManager.ts`, `src/commands/server.ts` and `src/server/*.ts` and fails on any site that neither consults the guard in its enclosing function nor carries a `confined-write-allowed: <reason>` comment. The four allowlisted sites are named above. The artifact and spec now say "every Instar writer through SessionManager or the server's tmux operations", with the remaining honest limit being a writer that shells out to tmux directly without either.
