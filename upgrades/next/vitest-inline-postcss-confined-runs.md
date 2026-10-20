<!-- internal-only -->
# Vitest: inline empty PostCSS config so confined test runs work

## What Changed

Every `vitest*.config.ts` now sets `css: { postcss: {} }`. Vite skips its parent-directory PostCSS search, which aborted on EPERM when the feedback executor's sandbox read-denies the agent home around the fix workspace. Before this, the canary's `base-unit-smoke` probe failed on any agent whose home is an instar checkout, so every executor attempt would have stopped as `profile-unenforceable`.

## Evidence

On the Mac Studio, using the server's own `SandboxRuntimeRunner` and `runRunnerCanary`, the runner canary had 27/28 probes passing and `base-unit-smoke` failing: exit 1, `EPERM ... open '<agentHome>/package.json'`. With this config the same confined `npx vitest run --no-cache tests/unit/feedback-factory/triage-floors.test.ts` exits 0 with 47/47 tests passing. Outside the sandbox, the unit, integration and e2e configs still run.
