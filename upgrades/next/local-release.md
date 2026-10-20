# Releases can be cut from a workstation with one command: npm run release:local

<!-- internal-only -->

## What Changed

GitHub's runners have been backed up for days at a time, and a merged change reaches nobody until the publish workflow gets a runner. Releasing from a workstation is now the default when that happens, and it is one command: `npm run release:local`. It runs the publish workflow's own steps on your machine, in the same order and with the same scripts: install, build, fold the release-note fragments into one guide, the release-tier check, pick the version, rename the guide and check it, the Stage-B and contract evidence checks, publish to npm, the post-publish install test, then the release commit, the push to main and the version tag. It stops at the first failure, and before publishing it puts the files it changed back the way they were. `--dry-run` does everything except publish, commit and push, and prints the version it would publish.

It is careful in the places a hand-run release goes wrong:

- It refuses to start while any of GitHub's own release jobs is waiting or running, for any merge, because such a job publishes whatever main is when it starts. If it cannot ask GitHub, it stops instead of guessing.
- It checks before building anything whether the npm account will ask for a one-time password. You then either pass a command that prints a fresh code at publish time, or use a token that doesn't need one. npm never sits waiting on a prompt.
- The release commit and its version tag go to GitHub together, so either both land or neither does. If main moved during the release, it only rebases over other release commits. If code landed in the meantime, it stops, so the tag still marks exactly what went to npm.
- If anything fails after publishing, `--push-only` finishes the job without publishing again. It checks npm first.

Releases made this way carry no npm provenance, because provenance needs a token that only exists inside a GitHub Actions run. The script says so when it publishes. The differences from the GitHub workflow are listed in the spec, docs/specs/local-release.md.

## Evidence

- A real end-to-end dry run on current main exited 0. It ran the preflight (GitHub release jobs: none for any merge; npm login and one-time-password checks reported where a real run would stop, since this shell's npm is not logged in), then install, build, guide assembly, the release tier (patch, allowed), the version (npm 1.3.1359 → 1.3.1360), the guide check and the Stage-B evidence check, followed by a second GitHub release-job check. It printed "Would publish instar@1.3.1360" and restored the tree. That run found two bugs that are now fixed: a status name GitHub's CLI rejects, which made every release-job query fail (the tool correctly read that as "unknown" and would have stopped), and a misread of the first line of git's status output.
- `tests/unit/release-local-steps.test.ts` runs against real git with a bare remote, and runs the installed npm's own one-time-password handling. `tests/unit/release-local-parity.test.ts` checks that every script the GitHub workflow runs is also run locally, in the same order. Every safety check was disabled in turn, and each time a test failed.
