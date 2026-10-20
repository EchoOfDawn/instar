# The push gate accepts release commits, and a deleted release note no longer counts as one

<!-- internal-only -->

## What Changed

The push gate refuses a push that changes a file which ships behavior but adds no release-note fragment, and package.json counts as such a file. A release commit changes package.json (the version) and uses fragments up instead of adding one, so the gate refused every release commit pushed from a workstation. The publish workflow never saw this because it commits with the hooks turned off.

The gate now recognises a release commit and lets it through, but only when the push changes nothing else. package.json and package-lock.json may differ only in their version fields, checked by reading both versions of each file rather than comparing lines. The version must go up, compared as numbers. Exactly one versioned guide matching the new version must be added, and the only other changes may be deleted fragments. If the push contains anything more, the gate refuses it exactly as before.

The same check also had a hole that let changes through: it counted a deleted fragment as if one had been added. A change could ship behavior with no release note just by deleting someone else's already-released fragment. Now only fragments the push adds or edits count, with git's rename detection off, so a fragment moved or renamed inside the release-notes folder still counts and a release commit passes only through the release-commit rule above.

## Evidence

- Reproduced first: the gate run against the real release commit for 1.3.1359 refused it with "2 release-relevant file(s) changed but no release-note fragment was added" for package.json and package-lock.json. Git had seen the fragment renamed into the versioned guide, and the gate listed only the new path, so it found no fragment. With the fix, the same commit passes and the gate prints "Release cut v1.3.1359 recognised".
- `tests/unit/release-cut-diff.test.ts` (29 pass) runs the real gate in real git repos. A real cut passes, including the exact shape of the 1.3.1359 commit. These are refused: a cut that also changes a dependency or a source file, a version that goes down, a bare version bump with no guide, and a source change whose only fragment activity is a deletion or a move out of the release-notes folder. A fragment renamed and edited inside the folder still counts. Each check was disabled in turn, and each time at least one test failed.
