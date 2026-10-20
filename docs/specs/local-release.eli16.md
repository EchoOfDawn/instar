# One-command local release — Plain-English Overview

> The one-line version: when GitHub's machines are too busy to release Instar, a maintainer can now run the exact same release from their own computer with one command, and the safety check that runs before every push no longer refuses the release commit.

## The problem in one breath

Every merge to Instar's main branch is supposed to be released by a GitHub workflow, but GitHub's shared machines have been backed up for days, so finished fixes sat unreleased. Releasing by hand meant copying the workflow's steps one at a time, and then the push of the release commit was refused by our own pre-push check.

## What already exists

- **The publish workflow** — on GitHub, it gathers the release notes, picks the version, publishes to npm, tests the install, and commits "chore: release vX". It commits with the hooks turned off, so it never meets the pre-push check.
- **The pre-push check** — before any push it refuses changes that ship behavior without a release note. A while ago it started counting package.json as "ships behavior", which is right for normal changes but means a release commit (which changes the version in package.json and uses up the notes instead of adding one) is always refused.

## What this adds

A single command, `npm run release:local`, that does exactly what the workflow does, in the same order with the same scripts, and stops at the first failure. Before it publishes, a failure puts the files back. `--dry-run` rehearses everything except publishing, committing and pushing, and says which version it would publish.

- **The release commit is recognised by the pre-push check** — only when the push is purely a release: the two package files differ only in their version numbers (checked by reading the files, not comparing lines), one versioned release guide is added, and used-up notes are deleted. Anything else in the push and the check behaves exactly as before.

## The safeguards

**It cannot release something that isn't on main.** It refuses to start unless the working copy is clean and exactly matches main on GitHub.

**It cannot sneak code past the release-note check.** The exemption fails on any extra file or any change to package.json beyond the version, and every uncertain case falls back to the old refusal.

**It never turns off the checks.** The release commit and push run every hook; there is no force push; a conflicting rebase stops instead of overwriting.

**What it cannot do locally:** npm provenance (a signed record that the package was built by GitHub) needs a token only GitHub's machines have, so local releases go out without it, and the script says so.

## What ships when

One PR: the check fix, the command, its tests and a short section in CONTRIBUTING.md.
