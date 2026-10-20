# Local release refuses to bury an unfinished release, and can finish one from npm

<!-- internal-only -->

## What Changed

instar 1.3.1362 was published from a machine that never finished the release, so main kept saying 1.3.1361 until the release commit was rebuilt by hand from the published package. The release tool now checks for this before doing anything. If npm already has a newer version than main, a real run refuses to start, names the unfinished version, and gives the two ways to finish it. It also refuses while this computer has a release in flight (a note the tool leaves just before publishing and removes once the release lands), or while GitHub has a version tag newer than main. Those two don't depend on npm, which can hide a new version while it reviews it. A dry run only warns.

The two ways to finish it:

- If the folder that still holds that release exists, run `--push-only` from it.
- If that folder is gone, run `--reconcile <version>`. It downloads the version npm actually shipped, copies its release notes exactly, removes the release-note fragments that version already included (the ones present at the commit it was built from), and bumps the version files. Then it commits with all checks on and pushes, exactly like `--push-only`. It never publishes. It refuses if npm doesn't show the version, if that version isn't newer than main, or if the commit it was built from isn't part of main's history. It also refuses to delete a release-note fragment that was edited on main after the publish, or whose text isn't in the released notes, and names the file.

## Evidence

- `tests/unit/release-local-steps.test.ts` (74 pass) runs the real tool against a bare git remote with a stand-in npm registry and a real tarball.
  - A release run refuses while npm is ahead and changes nothing.
  - `--reconcile` lands the rebuilt release with the notes byte-identical to the tarball, only the included fragment removed and a later one kept, both version files bumped, and the commit hook run.
  - It refuses when npm lacks the version, when the source commit isn't on main, and when main isn't behind.
  - When a commit check refuses the rebuilt commit, nothing is pushed and `--push-only` finishes it afterwards.
  - Each check was disabled in turn, and each time a test failed (10 of 10).
- Checked against the real 1.3.1362 release: the published package's release notes are byte-identical to the ones rebuilt by hand on main, and the commit it was built from held exactly the one fragment that the hand rebuild removed.
- A real dry run on current main reported "npm latest 1.3.1362, main 1.3.1362: no unfinished release".
