# Releases can be cut from a workstation with one command, and the push gate accepts the release commit

<!-- internal-only -->

## What Changed

GitHub's runners have been backed up for days at a time, and a merged change reaches nobody until the publish workflow gets a runner. Releasing from a workstation is now the default when that happens, and it is one command: `npm run release:local`. It runs the publish workflow's steps on your machine, in the same order and with the same scripts: install, build, fold the release-note fragments into one guide, the release-tier check, pick the version, rename the guide, check it, the Stage-B and contract evidence checks, publish to npm, the post-publish install test, then the release commit, the push to main and the version tag. It stops at the first step that fails, and before publishing it puts the files it changed back the way they were. `--dry-run` does everything except publish, commit and push, and prints the version it would publish. Releases made this way carry no npm provenance, because provenance needs a token that only exists inside a GitHub Actions run; the script says so when it publishes.

This also fixes the push gate refusing every release commit. The gate refuses a push that changes a file which ships behavior but adds no release-note fragment, and package.json counts as such a file. A release commit changes package.json (the version) and removes fragments instead of adding one, so the gate refused it. The workflow never saw this because it commits with the hooks turned off. The gate now recognises a release commit and lets it through, but only when the push changes nothing else: package.json and package-lock.json may differ only in their version fields (checked by reading both versions of each file, not by comparing lines), exactly one versioned guide matching the new version is added, and the only other changes are deleted fragments. Anything more in the push and the gate refuses it exactly as before.

## Evidence

- Reproduced first: the gate run against the real release commit for 1.3.1359 refused it with "2 release-relevant file(s) changed but no release-note fragment was added" for package.json and package-lock.json. With the fix, the same commit passes and the gate prints "Release cut v1.3.1359 recognised".
- `tests/unit/release-cut-diff.test.ts` (21 pass): a real cut in a real git repo passes the gate; a cut that also changes a dependency, or also changes a source file, or a bare version bump with no guide, is still refused. Each of the six checks in the new code was disabled in turn and each time at least one test failed.
- `tests/unit/release-local-parity.test.ts` (5 pass): every script the publish workflow runs is run by the local release too, in the same order.
