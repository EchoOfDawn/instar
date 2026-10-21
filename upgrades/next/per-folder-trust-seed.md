# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **A pool login now records folder trust for the agent's own directory, not just the top-level first-launch flags (#2251 — merged 2026-10-21, never shipped).** Claude Code gates a session on `projects[<agent dir>].hasTrustDialogAccepted`, which is a different question stored in a different place from the three top-level flags the readiness seed already wrote. A login that had the top-level flags but not the per-folder entry therefore reported "ready" while every session launched under it hit "Do you trust the files in this folder?" — whose default option is **No, exit** — and died in about 16 seconds. Two of the Mac Mini's pool logins were in exactly that state on 2026-10-20, which is why a conversation placed there spawned three times in 35 minutes and never answered. `ensureInteractiveReady` now takes the agent directory and treats a missing per-folder trust entry as reason enough to patch, instead of early-returning on the top-level flags alone.
- **A missing agent-directory accessor degrades loudly instead of throwing.** The first version of this change called `sessionManager.agentProjectDir()` directly, and CI caught it: the account-swap refresh path injects a narrow stub for that dependency, so a direct call took the whole refresh down with `TypeError: agentProjectDir is not a function` — a worse failure than the bug being fixed. The call is now optional and, when the accessor is absent, logs a named warning saying folder trust was **not** seeded for that config home and a respawn there may still die at the dialog. Two regression tests pin both halves.

## What to Tell Your User

One cause of "I sent a message and got no reply" is fixed: a login of mine could look ready while every session started under it was dying instantly at a trust prompt whose default answer is "no". I now set that per-folder permission myself, so those sessions start. If I ever cannot set it, I say so in my log by name rather than reporting the login as ready.

## Summary of New Capabilities

- `ensureInteractiveReady(configHome, { projectDir })` — patches a missing `projects[<dir>].hasTrustDialogAccepted` and seeds `allowedTools`.
- `SessionManager.agentProjectDir()`; `SessionRefresh` calls it optionally with a named warning on absence.

## Evidence

- `tests/unit/ensure-interactive-ready.test.ts`: a home with the top-level flags but no per-folder entry is patched, and an already-ready home is left alone.
- `tests/unit/folder-trust-seed-wiring.test.ts` (6, including 2 written for the CI-caught crash): the refresh path calls the accessor optionally and warns by name when it is missing.
- Live diagnosis, Mac Mini 2026-10-20: two pool logins missing the per-folder entry; sessions dying in ~16s at the trust dialog.
