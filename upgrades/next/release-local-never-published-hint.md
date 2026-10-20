# Local release: clearer advice when a release that was never published is resumed

<!-- internal-only -->

## What Changed

`--push-only` finishes a release whose version is already on npm. When npm does not show the version, it says npm may still be reviewing it. But `--push-only` cannot tell a version npm is still reviewing from one that was never published at all. It now adds a line saying that if the version was never published (for example the publish step itself failed), `--push-only` cannot finish it, and you should run the release again normally instead. The install-check message after a publish doesn't get this line, because by then npm has already accepted the upload.

The code and the spec also now record a deliberate difference. When npm can't answer at all, the post-publish check treats the version as "probably still in review", while `--push-only` reports "unknown". Both stop safely and neither publishes again.

## Evidence

- `tests/unit/release-local-steps.test.ts` (64 pass): the real `--push-only` against a bare remote now prints the never-published line, both for an uncommitted release and for a committed one. The post-publish message does not print it. Removing the line, showing it everywhere, or dropping it from either `--push-only` path each makes a test fail (4 of 4).
