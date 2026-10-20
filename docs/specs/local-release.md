---
title: "One-command local release (scripts/release-local.mjs)"
slug: "local-release"
author: "dawn"
status: draft
approved: false
review-convergence: pending
eli16-overview: "local-release.eli16.md"
---

# One-command local release

> **Status: DRAFT.** Not yet converged or approved. Written 2026-10-20 after Justin's ruling: GitHub's runners have been overloaded for days and are slowing Instar development, so running tests and releases locally should be the default. The implementation described here already exists, uncommitted, on the local branch `feat/release-local-tool`. This spec describes it exactly as built, including Echo's review round 1 (items 3a–3c on PR #2222), so it can be converged and approved before it is committed.
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
- An unknown argument exits 2 and touches nothing.

**Steps** (the numbers are the script's step order):

0. **Preflight.**
   - The git top-level must be the script's own repo.
   - `git status --porcelain --untracked-files=all` must be empty.
   - It runs `git fetch <remote> main`, then requires `HEAD == <remote>/main`. A `--dry-run` only warns on a mismatch, so a branch can be rehearsed; a real run refuses.
   - If HEAD's message contains `[skip ci]`, it stops cleanly. This is the job's `if:`.
   - **Gate-base refresh (Echo 3b):** for each of `JKHeadley/main`, `origin/main` and `upstream/main` that exists locally, it runs `git fetch <remote> main`. These are the refs `pre-push-gate.js`'s `pickRef` may choose. A ref that exists but cannot be fetched stops the run before anything is published, because the gate would otherwise diff the release commit against a stale base.
   - A real run (not `--dry-run`) also requires `npm whoami` to succeed.
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
10. **`npm publish --access public`**, with no `--provenance`, because provenance needs the GitHub Actions OIDC token. The script prints that. **(Echo 3c)** If `npm publish` exits non-zero, it asks `npm view instar@<v> version`:
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
      - **Moved:** it runs `git rebase <remote>/main`, aborts on conflict and never force-pushes. Then it re-creates the tag on the rebased commit (`git tag -d` + `git tag`) and retries, up to 5 attempts, the same bound as publish.yml.
13. It prints the release commit and tag, and the `gh run list … | xargs gh run cancel` command for the publish.yml run that the shipped merge queued. That run would find no fragments and skip, but cancelling it frees the `publish` concurrency group.

**Failure semantics.**
- Before publish, any failure restores `package.json`, `package-lock.json` and `upgrades/` (`git checkout HEAD -- …` plus `git clean -fq -- upgrades`). This only ever undoes the script's own edits, because the preflight required a clean tree including untracked files.
- After publish, nothing is undone, and the message says the version is on npm and the release commit must land.
- An UNKNOWN publish state does neither.

**Code layout.** The post-publish decisions (`refreshGateBaseRefs`, `pushReleaseAtomically`, `publishedStateAfterFailure`) live in `scripts/lib/release-local-steps.mjs`. Each takes an injected `run(cmd, args)`, so the tests drive real git.

**Docs.** CONTRIBUTING.md gets a "Releasing (maintainers)" section: local release is the default when CI is starved, the three commands, and the differences from CI.

## Decision points touched

- **No agent runtime decision points.** This is maintainer tooling. It is in the npm `files` payload only because `scripts/` is.
- It calls existing release decisions (the release tier, the publish version, the upgrade-guide validation, Stage-B evidence, contract evidence) exactly as publish.yml calls them. It adds no new policy, except two fail-closed deviations: `npm view` failing in step 5, and a stale gate-base ref in step 0.
- New deterministic stops on irreversible actions (a publish, a push to main): the preflight checks, the hook-refusal stop, and the UNKNOWN publish stop. All of them stop; none of them block someone else's action.

## Differences from publish.yml (complete list)

| publish.yml | release-local | Why |
|---|---|---|
| `npm publish --provenance` | no `--provenance` | needs CI OIDC |
| `npm view` failure → `0.0.0` | fails closed | locally `0.0.0` lets package.json alone pick the version |
| commit with `HUSKY=0` | commit and push with hooks | hooks are never bypassed (needs #2222) |
| commit push, then a separate tag push | one atomic push of commit + tag | main and the tag cannot disagree (Echo 3b) |
| retry rebases on any push failure | rebases only when the remote main moved | a hook refusal is not fixed by rebasing (Echo 3a) |
| a failed `npm publish` fails the job | the registry is asked; published / absent / unknown | npm can fail after the upload landed (Echo 3c) |
| author `github-actions[bot]` | the maintainer's git identity | local run |
| `$GITHUB_STEP_SUMMARY` / `::error::` | stdout | no Actions runtime |
| `actions/checkout ref: main` | requires `HEAD == <remote>/main` (dry run: warns) | the same "release exactly main" property |
| `RELEASE_TOKEN` bypasses branch protection | the maintainer's own bypass permission | same permission, different holder |

## Tests (built)

- `tests/unit/release-local-steps.test.ts` uses real git with a bare remote. It covers:
  - the atomic first push;
  - a hook refusal, which makes one push, no rebase, and surfaces the hook output;
  - a moved main, which rebases and retries, with the tag following the rebased commit;
  - atomicity: a refused tag leaves the remote main unchanged;
  - ref refresh, including a stale `JKHeadley/main` that cannot be fetched → failure;
  - the three publish-state outcomes;
  - wiring: the refresh happens before publish, and the UNKNOWN branch neither restores the tree nor says "Nothing was published".
- `tests/unit/release-local-parity.test.ts`: every `node scripts/<x>` in publish.yml is run by the local script, in the same relative order; no hook-bypass or force flags.
- Mutation-checked: removing the moved-check, comparing against HEAD, a non-atomic push, skipping a stale ref, and treating unknown as absent each make a test fail.
- Real run: `node scripts/release-local.mjs --dry-run` on a branch exited 0 (tier patch/allow, npm 1.3.1359 → would publish 1.3.1360, Stage-B evidence verified, tree restored).

## Multi-machine posture

Machine-local BY DESIGN. One maintainer cuts one release from one workstation against the shared remote. Concurrency with CI or another maintainer is handled the way publish.yml handles it:
- The version is resolved from the registry.
- `npm publish` refuses an existing version.
- The push is atomic, and it rebases only when main moved.
- It never force-pushes.

## Rollback

Delete the script, the npm script and the CONTRIBUTING section. No state, migration or agent surface is involved. A release made with it is an ordinary release: roll back by publishing a new version, as for CI.

## Open questions

- Should `release:local` refuse when a publish.yml run for the same merge is already *in progress* (not just queued)? Today the two are serialised only by the npm version check and the atomic push.
  - Proposed answer (Dawn): yes. Refuse while a publish.yml run for the same merge is queued OR in progress, and print the `gh run cancel` command. Two publishers racing is never wanted, and the cost of refusing is one cancel.
- Is a maintainer pushing straight to protected `main` (bypass) acceptable as the standing default, or should the release commit go through an auto-merged PR?
  - Proposed answer (Dawn): direct push is the default. It is what publish.yml already does with RELEASE_TOKEN, the push gate now admits only an exact cut, and a PR round-trip would bring back the CI wait this tool exists to avoid. Proven on 2026-10-20: the v1.3.1359 cut (ee72c9c81) went straight to main with every hook on.
