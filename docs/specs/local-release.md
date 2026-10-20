---
title: "One-command local release (scripts/release-local.mjs)"
slug: "local-release"
author: "dawn"
status: draft
approved: false
review-convergence: "Echo review round 1 (PR #2224 comment, 2026-10-20T05:31Z); both must-settle items and all four smaller items answered in round 2; open questions resolved. The formal /spec-converge multi-reviewer pass has NOT been run."
eli16-overview: "local-release.eli16.md"
---

# One-command local release

> **Status: DRAFT.** Not yet converged or approved. Written 2026-10-20 after Justin's ruling: GitHub's runners have been overloaded for days and are slowing Instar development, so running tests and releases locally should be the default. The implementation described here already exists, uncommitted, on the local branch `feat/release-local-tool`. This spec describes it exactly as built, including Echo's review of the tool on PR #2222 (items 3a–3c) and her round-1 review of this spec on PR #2224 (answered in round 2: no rebase over code, an OTP preflight, each gate ref fetched from its own remote, a `--push-only` resume, and a fail-closed publish.yml-run check), so it can be converged and approved before it is committed.
>
> Depends on PR #2222 (pre-push gate accepts release cut commits). Without it, step 12's push of the release commit is refused by `pre-push-gate.js` §3b.

## Problem statement

A merge to `main` reaches agents only when `.github/workflows/publish.yml` gets a runner. In mid-October 2026 the publish job queued for hours at a time. v1.3.1359 was released by hand on a workstation by copying the workflow's steps one at a time (assemble-next-md → resolve-release-tier → resolve-publish-version → npm version → rename NEXT.md and delete consumed fragments → check-upgrade-guide → npm publish → post-publish-smoke). Two things went wrong with that:

1. A hand-run sequence is a different release from CI's. It is easy to skip a step, run one out of order, or fail open where CI fails closed.
2. The resulting `chore: release vX [skip ci]` commit could not be pushed with hooks on. CI never meets this because its commit step runs with `HUSKY=0`. That gate bug is fixed separately in #2222.

## Proposed design

`scripts/release-local.mjs`, exposed as `npm run release:local`, performs the `publish` job of `publish.yml` on the maintainer's machine. It runs in the same order, calls the same scripts, and fails closed at every step.

**Arguments:**
- `--dry-run` runs every step up to, but not including, `npm publish`, the commit and the push. It prints the version it would publish, then restores the tree.
- `--userconfig <path>` names the npm config file that holds the publish auth. It is passed to `npm whoami`, `npm publish` and the post-failure `npm view`. The script never reads or prints a token.
- `--remote <name>` names the git remote for main. The default is `origin`.
- `--otp-command "<cmd>"` names a command that prints a fresh npm one-time password. It runs right before `npm publish`, and its output is never printed. A static `--otp <code>` is deliberately not offered: a TOTP code typed at the start expires during the build.
- `--token-skips-otp` is the caller's statement that the npm token publishes without an OTP (a granular token with "bypass 2FA", or a classic automation token). It is needed only when the preflight sees that the account requires, or may require, an OTP.
- `--allow-unverified-ci` lets a real run proceed when `gh` cannot say whether a publish.yml run is active. It never overrides a run that IS active.
- `--push-only` resumes after a publish: it lands an already-published release commit and never publishes (see "Push-only resume").
- `--keep-tag-on-published` (with `--push-only` only) pushes the tag on the published commit and lands the release commit on main separately.
- An unknown argument exits 2 and touches nothing, as do `--keep-tag-on-published` without `--push-only` and `--push-only` with `--dry-run`.

**Steps** (the numbers are the script's step order):

0. **Preflight.**
   - The git top-level must be the script's own repo.
   - `git status --porcelain --untracked-files=all` must be empty.
   - It runs `git fetch <remote> main`, then requires `HEAD == <remote>/main`. A `--dry-run` only warns on a mismatch, so a branch can be rehearsed; a real run refuses.
   - If HEAD's message contains `[skip ci]`, it stops cleanly. This is the job's `if:`.
   - **Gate-base refresh (Echo 3b):** for each of `JKHeadley/main`, `origin/main` and `upstream/main` that exists locally, it fetches that ref **from its own remote**: `git fetch JKHeadley main`, `git fetch origin main`, `git fetch upstream main`. It never fetches from `--remote`. These are the refs `pre-push-gate.js`'s `pickRef` may choose. A ref that exists but cannot be fetched stops the run before anything is published, because the gate would otherwise diff the release commit against a stale base.
   - **publish.yml run check (open question 1, resolved).** It runs `gh run list -R <owner/repo> --workflow publish.yml --commit <HEAD> --json databaseId,status`.
     - A run that is not `completed` (queued, in progress, waiting) stops a real run and prints the `gh run cancel` command. Two publishers must never race.
     - If `gh` is missing, fails, prints something unparseable, or the owner/repo can't be derived from the remote URL, the answer is UNKNOWN. A real run stops unless `--allow-unverified-ci` is given; it never assumes none.
     - A `--dry-run` only warns.
     - Real gh output was checked: the #2222 merge's run parses as `completed` → clear.
   - A real run (not `--dry-run`) also requires `npm whoami` to succeed.
   - **OTP preflight (Echo round-1 item 2).** Before anything is mutated, it runs `npm profile get --json` and reads `tfa`:
     - `tfa: false`, `pending`, or mode `auth-only` → not required.
     - mode `auth-and-writes` → required.
     - Anything unreadable (granular tokens often cannot read the profile) → unknown.
     - If it is required or unknown, the run stops here unless `--otp-command` or `--token-skips-otp` was given.
1. `NODE_ENV=development npm ci --include=dev`. A workstation may carry `NODE_ENV=production` or npm `omit=dev`; a CI runner installs dev dependencies by default.
2. `npm run build`.
3. `node scripts/assemble-next-md.mjs`. From this point the script has edited tracked files.
4. **NEXT.md content check**, the same three skip rules as the workflow: NEXT.md is missing; it is still the template (`[Feature name]` and `[Capability]`); or it has an `<!-- auto-draft-unreviewed` comment. On a skip, it runs `git fetch --tags <remote> main` and `node scripts/release-skip-annotate.mjs`, a signal only that always exits 0, then restores the tree and exits 0.
5. **Release tier.** It runs `node scripts/resolve-release-tier.mjs <local> <npm>`.
   - A non-zero exit fails the run.
   - `skip` stops cleanly with the reason and restores the tree.
   - Anything other than `allow` fails the run.
   - The npm version comes from `npm view instar version`. A failure, or a result that is not X.Y.Z, fails closed. **Deviation from CI**, which falls back to `0.0.0`: locally that fallback would let package.json alone choose the version.
6. **Version.** It runs `node scripts/resolve-publish-version.mjs <local> <npm>`. The result must be X.Y.Z. Then it runs `npm version <v> --no-git-tag-version --allow-same-version` and checks that package.json now says `<v>`.
7. It renames `upgrades/NEXT.md` to `upgrades/<v>.md` and deletes `upgrades/next/*.md`.
8. `node scripts/check-upgrade-guide.js`.
9. **prepublishOnly's gates, run up front so `--dry-run` covers them:** `node scripts/verify-codex-stage-b-release-evidence.mjs` and `node scripts/check-contract-evidence.js`. `npm publish` runs them again through `prepublishOnly`.
10. **`npm publish --access public`**, with no `--provenance`, because provenance needs the GitHub Actions OIDC token. The script prints that.
    - The publish.yml run check runs again first, to close the window since preflight.
    - If `--otp-command` was given, it runs now and must print a 6–8 digit code; it is passed as `--otp`, and the printed command line shows `--otp <hidden>`.
    - `npm publish` runs with **stdin closed**, so it can never sit waiting on an OTP prompt. A missing OTP becomes an `EOTP` failure, handled below.
    
    **(Echo 3c)** If `npm publish` exits non-zero, it asks `npm view instar@<v> version`:
    - `<v>` → **published.** It continues down the published path, with a message saying so.
    - E404 → **absent.** This is an ordinary failure; it restores the tree and prints "Nothing was published".
    - anything else (network, auth, a different version) → **UNKNOWN.** It stops without restoring the tree and without claiming either way, and prints the `npm view` command to settle it.
11. `node scripts/post-publish-smoke.mjs <v>`.
12. **Commit and push.**
    - It runs `git add package.json package-lock.json upgrades/` and `git commit -m "chore: release v<v> [skip ci]"` **with hooks**.
    - It refreshes the gate-base refs again (a failure here is post-publish: it is reported, and nothing is undone).
    - **(Echo 3b)** It runs `git tag v<v>`, then **one** `git push --atomic <remote> HEAD:main v<v>`, so main and the tag can never disagree.
    - **(Echo 3a)** Before each push it records `<remote>/main`. If the push is refused, it fetches and compares the remote main sha from before the push with the sha after the fetch. HEAD is not part of that comparison.
      - **Unchanged:** a hook or a permission refused the push. It fails at once with the push and hook output. It does not rebase or retry.
      - **Moved — only by release cuts:** it checks every commit on `<remote>/main` that HEAD lacks. A release cut is a non-merge commit whose diff against its parent passes the #2222 cut rule. If all of them are release cuts (so no code), it runs `git rebase <remote>/main`, aborts on conflict and never force-pushes. Then it re-creates the tag on the rebased commit (`git tag -d` + `git tag`) and retries, up to 5 attempts, the same bound as publish.yml. The tagged tree still equals the published tree.
      - **Moved — by anything else (Echo round-1 item 1, her option b):** it **stops without rebasing**. Rebasing would put `v<v>` on a tree containing code the npm tarball never had, and a rollback relies on the tag matching what was published. The version is on npm, so the stop prints the push-only resume commands below.
    - **Runner fix found in round 2:** step 12 used to pass the echoing runner, which does not capture stdout, into the push logic. `rev-parse` then returned empty strings, so every refused push would have been misread as a hook refusal. It now passes the capturing runner, and a test pins that.
13. It prints the release commit and tag. It also says whether publish.yml runs for the shipped merge were checked, or were NOT verified because `--allow-unverified-ci` was given (with the `gh run list` command to check).

**Push-only resume (Echo round-1 item 4).** Any failure after publish prints `node scripts/release-local.mjs --push-only --remote <r> [--userconfig <p>]`, plus `--keep-tag-on-published` for the case where main moved with code. `--push-only`:
- requires a clean tree and a HEAD subject of `chore: release vX [skip ci]`;
- requires HEAD to be a release cut by the #2222 rule, and package.json to say X;
- requires `npm view instar@X version` to return X. It refuses if the version is absent, and also if npm can't confirm, in which case the message says it is UNKNOWN. It lands only a version already on npm and never runs `npm publish`;
- creates the local tag `vX` if it is missing, and refreshes the gate refs (each from its own remote);
- then runs one of two pushes:
  - **default:** the same atomic push and cut-only rebase rule as step 12;
  - **`--keep-tag-on-published`:** the local tag must be on HEAD (the published commit). It pushes the tag alone, so the tag stays on the commit npm was built from. Then it pushes `HEAD:main`, rebasing the release commit over whatever moved main; the tag does not move. A hook refusal still stops at once, and it never force-pushes. Main then carries the version bump on top of the newer code, as CI's own release commit always does, while the tag marks exactly the published tree.

**Failure semantics.**
- Before publish, any failure restores `package.json`, `package-lock.json` and `upgrades/` (`git checkout HEAD -- …` plus `git clean -fq -- upgrades`). This only ever undoes the script's own edits, because the preflight required a clean tree including untracked files.
- After publish, nothing is undone, and the message says the version is on npm and the release commit must land.
- An UNKNOWN publish state does neither.

**Code layout.** The decisions live in `scripts/lib/release-local-steps.mjs`: `refreshGateBaseRefs`, `pushReleaseAtomically`, `pushTagThenMain`, `isReleaseCutCommit` / `incomingCommits`, `publishedStateAfterFailure`, `otpRequirement`, `ciRunState` and `ciGateAction`. They live in `scripts/lib/release-local-steps.mjs`. Each takes an injected `run(cmd, args)`, so the tests drive real git.

**Docs.** CONTRIBUTING.md gets a "Releasing (maintainers)" section: local release is the default when CI is starved, the three commands, and the differences from CI.

## Decision points touched

- **No agent runtime decision points.** This is maintainer tooling. It is in the npm `files` payload only because `scripts/` is.
- It calls existing release decisions (the release tier, the publish version, the upgrade-guide validation, Stage-B evidence, contract evidence) exactly as publish.yml calls them. It adds no new policy, except fail-closed deviations: `npm view` failing in step 5, a stale gate-base ref in step 0, an unknown publish.yml-run state, and an unknown OTP requirement.
- New deterministic stops on irreversible actions (a publish, a push to main): the preflight checks (including an active or unknown publish.yml run, and an OTP that may be needed with no way to supply it), the hook-refusal stop, the moved-with-code stop, and the UNKNOWN publish stop. All of them stop; none of them block someone else's action. The only override is `--allow-unverified-ci`, which applies to an UNKNOWN run state only; it never overrides an active run.

## Differences from publish.yml (complete list)

| publish.yml | release-local | Why |
|---|---|---|
| `npm publish --provenance` | no `--provenance` | needs CI OIDC |
| `npm view` failure → `0.0.0` | fails closed | locally `0.0.0` lets package.json alone pick the version |
| commit with `HUSKY=0` | commit and push with hooks | hooks are never bypassed (needs #2222) |
| commit push, then a separate tag push | one atomic push of commit + tag | main and the tag cannot disagree (Echo 3b) |
| retry rebases on any push failure | rebases only when the remote main moved, and only over release cuts | a hook refusal is not fixed by rebasing (Echo 3a); a rebase over code would put the tag on a tree npm never got (Echo #2224 item 1) |
| rebase re-tags over any concurrent merge | moved-with-code stops; `--push-only --keep-tag-on-published` keeps the tag on the published commit | the tag must match the tarball |
| no concurrent-publisher check (concurrency group) | refuses while a publish.yml run for the merge is queued or in progress; unknown → stop | two publishers must never race (open question 1) |
| non-interactive token in CI | OTP decided in preflight; `--otp-command` fresh code at publish; stdin closed | an OTP prompt mid-run would hang after mutating (Echo #2224 item 2) |
| — | `--push-only` resume | a post-publish failure must be resumable without a re-publish (Echo #2224 item 4) |
| a failed `npm publish` fails the job | the registry is asked; published / absent / unknown | npm can fail after the upload landed (Echo 3c) |
| author `github-actions[bot]` | the maintainer's git identity | local run |
| `$GITHUB_STEP_SUMMARY` / `::error::` | stdout | no Actions runtime |
| `actions/checkout ref: main` | requires `HEAD == <remote>/main` (dry run: warns) | the same "release exactly main" property |
| `RELEASE_TOKEN` bypasses branch protection | the maintainer's own bypass permission | same permission, different holder |

## Tests (built)

- `tests/unit/release-local-steps.test.ts` uses real git with a bare remote. It covers:
  - **Pushing:**
    - the atomic first push;
    - a hook refusal, which makes one push, no rebase, and surfaces the hook output;
    - main moved by a **code** commit → stop, with no rebase, main unchanged and no tag pushed;
    - main moved only by another **release cut** → rebase and retry, with the tag following the rebased commit;
    - atomicity: a refused tag leaves the remote main unchanged.
  - **Release-cut detection:** `isReleaseCutCommit` says yes for a cut and no for a code commit, a merge and a root commit.
  - **`--keep-tag-on-published`:**
    - the tag stays on the published commit, and main gets the rebased release commit on top of the code merge;
    - a hook refusal on the main push stops at once;
    - a tag that is not on HEAD is refused.
  - **Gate-ref refresh:** every existing ref is fetched from its **own** remote (the asserted fetches are `origin main` and `upstream main`); a stale `JKHeadley/main` that cannot be fetched → failure.
  - **Pure decision functions:**
    - the three publish-state outcomes;
    - `otpRequirement`: required, not-required, and every unreadable form → unknown;
    - `ciRunState`: queued and in_progress are active, completed is clear, and an unreadable answer is unknown;
    - `ciGateAction`: unknown stops a real run, an active run cannot be overridden, and a dry run warns.
  - **Wiring:**
    - the gate-ref refresh and the OTP preflight both happen before `npm ci`;
    - the publish.yml check runs in preflight and again just before publish;
    - `npm publish` runs with stdin closed;
    - the push logic gets the capturing runner;
    - `--push-only` checks npm before pushing and never publishes;
    - the UNKNOWN branch neither restores the tree nor says "Nothing was published";
    - the argument guards.
- `tests/unit/release-local-parity.test.ts`: every `node scripts/<x>` in publish.yml is run by the local script, in the same relative order; no hook-bypass or force flags.
- **Mutation-checked.** Each of these mutations made a test fail.
  - Round 1: removing the moved-check, comparing against HEAD, a non-atomic push, skipping a stale ref, treating unknown as absent.
  - Round 2: rebasing over code, counting a merge as a cut, moving the tag in keep-tag mode, dropping the moved-check or the tag-on-HEAD check in keep-tag mode, treating an unknown OTP requirement as not-required (two forms), deciding OTP after `npm ci`, leaving publish stdin open, fetching every ref from `origin`, treating an unknown run state as clear, ignoring in_progress, letting an unknown state proceed, letting an active run be overridden, ignoring the gate action in the script, dropping the pre-publish re-check, skipping the npm check in `--push-only`, and passing the echoing runner to the push.
- Real data: `gh run list` for the #2222 merge (run 39374587426, `completed`) parses as clear, and `isReleaseCutCommit` says yes for the real v1.3.1359 cut ee72c9c81 and no for merge d1ddf8b4b.
- Real run (round 1): `node scripts/release-local.mjs --dry-run` on a branch exited 0 (tier patch/allow, npm 1.3.1359 → would publish 1.3.1360, Stage-B evidence verified, tree restored). It has not been re-run since round 2, because the tool is still uncommitted and the dry run requires a clean tree.

## Multi-machine posture

Machine-local BY DESIGN. One maintainer cuts one release from one workstation against the shared remote. Concurrency with CI or another maintainer is handled the way publish.yml handles it:
- The version is resolved from the registry.
- `npm publish` refuses an existing version.
- It refuses while a publish.yml run for the same merge is queued or in progress, and stops when it can't tell.
- The push is atomic, and it rebases only when main moved, and only over release cuts.
- It never force-pushes.

## Rollback

Delete the script, the npm script and the CONTRIBUTING section. No state, migration or agent surface is involved. A release made with it is an ordinary release: roll back by publishing a new version, as for CI.

## Open questions

*(none)*

## Resolved questions

- **Refuse while a publish.yml run for the same merge is active?** Resolved (Dawn proposed, Echo agreed, #2224 round 1): **yes**, whether the run is queued OR in progress, and print the `gh run cancel` command. If gh can't answer, a real run stops; `--allow-unverified-ci` is the explicit override, and it never overrides an active run. Implemented in step 0, and re-checked before step 10.
- **Direct push to protected `main`, or an auto-merged PR?** Resolved (Dawn proposed, Echo agreed): **direct push is the default.** It is what publish.yml already does with RELEASE_TOKEN; the push gate after #2222 admits only an exact cut; and a PR round-trip would bring back the CI wait this tool exists to avoid. It was proven on 2026-10-20, when the v1.3.1359 cut (ee72c9c81) went straight to main with every hook on.
- **Echo round 1, item 1 (tag vs published tree after a rebase):** her option (b): no rebase over non-release commits. `--push-only --keep-tag-on-published` is the explicit resume path.
- **Echo round 1, item 2 (OTP):** OTP preflight; `--otp-command` for a fresh code at publish time, or `--token-skips-otp` for a granular/automation token; publish stdin closed.
- **Echo round 1, items 3–4:** each ref is fetched from its own remote; a `--push-only` resume exists.
