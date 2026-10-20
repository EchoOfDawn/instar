# One-command local release — Plain-English Overview

> The one-line version: when GitHub's machines are too busy to release Instar, a maintainer can now run the exact same release from their own computer with one command, and the safety check that runs before every push no longer refuses the release commit.

## The problem in one breath

Every merge to Instar's main branch is supposed to be released by a GitHub workflow, but GitHub's shared machines have been backed up for days, so finished fixes sat unreleased. Releasing by hand meant copying the workflow's steps one at a time, and then the push of the release commit was refused by our own pre-push check.

## What already exists

- **The publish workflow** — on GitHub, it gathers the release notes, picks the version, publishes to npm, tests the install, and commits "chore: release vX". It commits with the hooks turned off, so it never meets the pre-push check.
- **The pre-push check** — before any push it refuses changes that ship behavior without a release note. A while ago it started counting package.json as "ships behavior", which is right for normal changes but means a release commit (which changes the version in package.json and uses up the notes instead of adding one) is always refused.

## What this adds

A single command, `npm run release:local`, that does exactly what the workflow does, in the same order with the same scripts, and stops at the first failure. Before it publishes, a failure puts the files back. `--dry-run` rehearses everything except publishing, committing and pushing, and says which version it would publish.

- **It needs the pre-push fix in PR #2222**, which lets a pure release commit through the pre-push check. Without it, the release commit is refused at the push.
- **After publishing, it is careful about what it can't see.** It pushes the release commit and its version tag in one step, so both land or neither does. It retries only when main really moved. When a hook refuses the push, it stops at once and shows why. If npm reports a failed publish, it asks npm whether the version landed anyway. When npm can't answer, it says the state is unknown and leaves everything as it is.

## The safeguards

**It cannot release something that isn't on main.** It refuses to start unless the working copy is clean and exactly matches main on GitHub.

**It cannot release against a stale picture of main.** Before publishing, it refreshes every copy of main the pre-push check might compare against, and stops if one can't be refreshed.

**It never turns off the checks.** The release commit and push run every hook; there is no force push; a conflicting rebase stops instead of overwriting.

**What it cannot do locally:** npm provenance (a signed record that the package was built by GitHub) needs a token only GitHub's machines have, so local releases go out without it, and the script says so.

## What ships when

First the pre-push fix (#2222). Then this spec is converged and approved. Then one PR with the command, its tests and a short CONTRIBUTING.md section. The code is already written and tested, and it is waiting on this approval.
