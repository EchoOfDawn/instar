# release-local --push-only: the two instructions say which case each is for

## What Changed

When `--push-only` refuses because npm does not show the version yet, its notice gives two instructions: one for a version that was never published, and one for a version that was published and is still in npm's review. The second now begins "Otherwise (published, still in review):", so the two no longer read as contradictory.

## What to Tell Your User

Nothing for agent users. This only changes a message in the maintainers' release tool.

## Summary of New Capabilities

- None. The release tool's `--push-only` message is clearer.

## Evidence

- `tests/unit/release-local-steps.test.ts`: the `--push-only` notice ends with the prefixed line, after the never-published caveat, and the smoke-path notice is unchanged. A mutant without the prefix fails 2 tests.
