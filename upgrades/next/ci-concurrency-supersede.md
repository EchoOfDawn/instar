# CI supersedes its own stale runs instead of queueing them forever

## What Changed

GitHub Actions concurrency is allotted **per account, shared across every repository the
owner has** — not per repo. Measured on 2026-10-20:

    JKHeadley/instar-2   10 jobs running, 25 queued
    JKHeadley/instar      0 jobs running, 21 queued

So this repo ran at roughly 3 concurrent jobs against a 20-job allowance. One pull request
here needs 8 unit shards (`node-version: [20, 22]` x `shard: [1..4]`), which is why a heavy
`CI` run took **17-19 hours** end to end and a two-file test-config fix sat **3h54m** in the
queue before its first job started.

Part of that is genuine contention between two projects and is not fixable here. The
*avoidable* part is supersession: `ci.yml` declared **no `concurrency` block at all**, so every
push to a branch started a NEW 13-job run while the previous run kept consuming shared slots.
`pull_request_review` is also a trigger, so approving a pull request spawned another full
13-job run alongside the push run. Nothing superseded anything.

The cost showed up as manual labour: **126 stale runs had to be cancelled by hand in one
night** to let a single-line fix reach a runner. A superseded run is waste by definition —
nobody is waiting on its result.

This adds a top-level `concurrency` block:

- **Grouped by pull-request number**, so `pull_request` and `pull_request_review` events for
  the same pull request share one slot instead of racing. Falls back to the ref for pushes to
  `main`.
- **`cancel-in-progress` excludes `main`.** A blanket `true` would be wrong: main's
  post-merge run is the release gate and its record is the evidence a merge was sound. Only
  branch and pull-request runs supersede.

`tests/unit/ci-workflow-concurrency.test.ts` makes it an invariant rather than a decision
someone has to remember — removing the block, dropping `cancel-in-progress`, or letting it
cancel `main` all fail the suite. It also pins the unit matrix at 8 shards, because that figure
is what makes one pull request cost ~2h of shared allowance; if it grows, the capacity question
has to be re-opened deliberately rather than by drift.

## Evidence

**Reproduction.** Open any pull request against `main`, then push a second commit to the same
branch before its `CI` run finishes. Observed before this change: the first run stays
`in_progress`/`queued` and the second run starts alongside it, so one branch holds two full
13-job runs. Approving the pull request adds a third, because `pull_request_review` is also a
trigger.

**Observed before (2026-10-20, PR 2216 — a two-file test-config fix):**

- CI run created `22:52:17Z`; its first job reached `in_progress` at `02:46:27Z`. **3h54m
  queued**, with all 13 jobs reading `queued` throughout.
- Account-wide concurrency at `02:50Z`: `instar-2` 10 running / 25 queued, `instar` 0 running /
  21 queued. Allowance for a free public repo is 20 concurrent jobs, so this repo was getting
  roughly 3.
- Measured throughput across two real runs' job start/complete timestamps: **~3.8 unit shards
  per hour**, against 8 shards per pull request.
- A heavy `CI` run created `05:20:01Z` concluded `00:04:40Z` — **18.7h** creation to conclusion,
  its 13 jobs dripped through shared slots rather than sitting unscheduled.
- **126 stale runs were cancelled by hand** across that night to get a single-line fix to a
  runner. Those cancellations are the manual cost this block removes.

**Observed after.** Not yet observable in production: the superseding behaviour is enforced by
GitHub when the block is present, and this change has not merged. What IS verified here is the
configuration itself — `tests/unit/ci-workflow-concurrency.test.ts` passes with the block (4
tests) and fails without it (3 of 4, by assertion message, not by crash). The production
check, once merged, is that pushing twice to one branch leaves exactly one live `CI` run.

**Not claimed.** This does not fix the cross-project contention, which is the larger half of
the delay and is not a `ci.yml` matter: two projects share one account's allowance with no
arbitration between them.

## What to Tell Your User

Nothing user-visible. Finished work reaches a runner sooner because the project stops spending
its shared build capacity on runs that have already been replaced.

## Summary of New Capabilities

None. This is a build-capacity repair plus the test that holds it in place.
