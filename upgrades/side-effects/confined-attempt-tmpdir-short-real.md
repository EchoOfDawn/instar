# Side-Effects Review — the confined attempt's temp directory is a short, real path under the system temp root

**Version / slug:** `confined-attempt-tmpdir-short-real`
**Date:** `2026-10-19`
**Author:** `Echo`
**Second-pass reviewer:** `required (confinement sandbox adjacent) — see below`

## Summary of the change

Wall 3 behind the operator's approver tap (ACT-111). Live measurement (Mac Studio, Claude Code 2.1.303, the executor's own `buildClaudeSandboxSettings` output, an interactive session launched with the confined argv and `env -i`): every Bash call exited 1 with `zsh:1: operation not permitted: /tmp/claude-501/cwd-<id>`. From the Claude Code binary: the sandbox temp dir honours `CLAUDE_CODE_TMPDIR` only while the override is short (its warning: "≤ ~30 bytes, too long for AF_UNIX sockets"), else it falls back to `/tmp/claude-<uid>`; the attempt's `<agentHome>/.worktrees/<attempt>-tmp` is 83 bytes. A short `/tmp/fb-probe01` moved the cwd file into our directory but the sandbox runtime still refused it (it matches real paths; `/tmp` is a link on macOS). `/private/tmp/fb-probe02` (22 bytes): git 0, echo 0, write inside the dir OK, `/tmp/feedback-canary-probe` still refused.

- `attemptFs.shortAttemptTmpDir(initiativeId, attempt)`: `<realpath(shortTmpDir())>/fb-<10 hex of sha256>` (26 bytes on macOS, 18 on Linux); `shortTmpRealRoot()`; `SHORT_ATTEMPT_TMP_RE`.
- `FeedbackExecutorService.attemptPaths` derives `tmpDir` from it (every reader recomputes the same path; nothing stored changes shape).
- `removeAttemptTree`: on `EXDEV` (a tmpfs `/tmp` on Linux cannot be renamed into the trash under the agent state) it removes in place through SafeFsExecutor; any other error still throws.
- `pruneScratch`: also sweeps `fb-*` directories in the short temp root older than 14 days that no live attempt maps to.

## Decision-point inventory

None added. Policy builders are unchanged; only the value of `tmpDir` changes.

## 1. Over-block

Nothing new is blocked. The shared temp roots (`/tmp`, `/private/tmp`, `/var/tmp`, `os.tmpdir()`) stay in `denyRead`/`denyWrite`; the canary's `bash-write-system-temp` / `write-system-temp` probes still hold (measured).

## 2. Under-block

- The attempt's temp dir now sits in a world-traversable root (`/private/tmp`, sticky) rather than under the 0700 agent home; the directory itself is created 0700 by the executor (`fs.mkdirSync(p.tmpDir, { mode: 0o700 })`) and its name is derived, not secret. Contents: Claude Code's shell bookkeeping, sockets, the canary report, the review's `check-*` run dirs. Nothing credential-shaped is written there by design (the fixture secrets live under the state dir). Accepted.
- The 30-byte limit is Claude Code's own and undocumented beyond its warning; a future uid or root making the path longer would reproduce wall 3. The unit test pins `≤ 30` bytes for a long initiative id so a regression is loud, and the canary's `session-git-status` probe fails closed if the host changes the rule again.
- `pruneScratch` touches only `fb-[0-9a-f]{10}` names in that root and only when older than 14 days and unmapped: a foreign directory with that exact shape would be removed; bounded by the shape and the age.

## 3. Level-of-abstraction fit

The path shape is a property of the host (Claude Code's limit + the runtime's real-path matching), so it lives beside the other host measurements in `attemptFs` and is consumed by the one path derivation. The sandbox policy (`executePolicy.ts`) is untouched, which is what the wall-2 directive required.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — no decision point; a path value changes.

## 4b. Judgment-point check

None.

## 5. Interactions

- Canary: `prepareCanaryFixture` writes its report under `tmpDir` (now short); `systemTmpWritePath` stays `/tmp/feedback-canary-<nonce>` (still refused). The runner path already set the outer `TMPDIR` to `shortTmpDir()` for its sockets; unchanged.
- Confined spawn: `CLAUDE_CODE_TMPDIR`/`TMPDIR` carry `tmpDir` (SessionManager, unchanged code) and now stay within Claude Code's limit.
- Disk cap: `treeBytes(row.tmpDir)` keeps counting the new location.
- Wall 2 (PR 2211, confined interactive reroute) is independent; both are needed before the canary passes under `force`.

## 6. External surfaces

Operator: none. Agents: none. Persistent state: rows store `tmpDir` as a string already; old rows with the long path are still removed by `endAttempt` through the stored value.

## 7. Multi-machine posture

Per machine; the executor runs on the canonical owner only.

## 8. Rollback cost

Revert; a leftover `fb-*` dir in the temp root is swept by the 14-day rule or by the OS.

---

## Conclusion

Removes a deterministic, measured wall that would have failed every attempt's canary after the operator's tap, without widening the sandbox. Clear to ship pending the second-pass review.

---

## Second-pass review (if required)

_pending_

---

## Evidence pointers

Probe transcripts (scratchpad `wall3/`): long tmpDir → `cwd-*` under `/tmp/claude-501`, exit 1 on every call; `/tmp/fb-probe01` → `cwd-*` under the override but `ls` refused ("Operation not permitted"); `/private/tmp/fb-probe02` → git 0, echo 0, write OK, canary write refused. Tests: `tests/unit/feedback-factory/execute-short-attempt-tmpdir.test.ts`; the execute suites (124 tests) unchanged and green.

---

## Class-Closure Declaration (display-only mirror)

No self-triggered controller added or modified.
