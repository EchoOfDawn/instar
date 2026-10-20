# Local releases now treat a publish npm is still reviewing as pending, not failed

<!-- internal-only -->

## What Changed

On the first real local release, npm accepted the upload but kept the new version in an automated review it calls "Validating" for over 40 minutes. During that time the version can't be downloaded and only the package owner can see why. The release tool's install test timed out and stopped, correctly, with the command to finish the release later.

The tool now says what is probably happening. When the install test fails and npm does not show the version yet, the message explains that npm may still be reviewing it, gives the owner's link to check (the Versions tab on npmjs.com), and says not to publish again. `--push-only`, the command that finishes a release without publishing, behaves the same way: it keeps refusing while npm does not show the version and never claims nothing was published. Once npm shows it, it finishes. If the version is visible and the install test still fails, that is reported as a real failure of the published package.

The spec also records a coming date. npm says tokens that skip two-factor checks stop working for publishing in January 2027. Local releases will need another sign-in route by then, and Justin is choosing which.

## Evidence

- `tests/unit/release-local-steps.test.ts` runs the real `--push-only` against a bare remote with an npm stand-in. For a release npm does not show yet, the command refuses, shows the review notice and the owner link, says not to publish again, never prints "Nothing was published", and pushes nothing, both when the release commit is still uncommitted and when it is already committed. Once the npm stand-in starts showing the version, the same command lands the release.
- Unit tests check that an install-test failure is called pending only when npm does not show the version, and a real failure when it does. Each new check was disabled in turn, and each time a test failed (6 of 6).
