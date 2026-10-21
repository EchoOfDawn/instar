## What Changed

- **Your agent stops calling itself unhealthy over a job that was switched off.** The health report added up every scheduled job's run of consecutive failures with no time limit. A job's failure count only resets when that job next succeeds — so a job you disabled keeps its last count forever, and nothing can ever bring it down. One agent reported 119 failures while nothing at all was wrong: 118 of them belonged to a job that had been off since 26 September.
- **A failure now counts while it can still change.** A job's failures count toward health if the job is switched on and ran within the last 24 hours. Everything else is still reported, under a separate heading that names the job, its count, its last run, and whether it was excluded for being disabled or for being out of date — so nothing is hidden, it just stops dragging the verdict down.
- **The threshold itself is unchanged.** Five or more current failures still marks the agent degraded, exactly as before. This narrows what counts as current; it does not relax the rule.

## What to Tell Your User

If your agent has been reporting itself as degraded and you could not find anything wrong, this may be why — check whether the failures it was counting belong to a job you turned off weeks ago. After this update the health report separates the two: the number at the top is what is failing now, and anything historical is listed beneath it with the reason it does not count.

Nothing you need to do. If a job genuinely is failing, you will still hear about it.

## Evidence

Reproduced from live state and fixed with the real numbers:

- **Before.** `GET /health` on a working agent answered `consecutiveJobFailures: 119` and `status: degraded`. Reading `GET /jobs` showed the source: `w29-working-set-mirror` with `enabled: false`, `consecutiveFailures: 118`, `lastRun: 2026-09-26T07:01:15.227Z` — twenty-five days earlier. The remaining 1 was a single historical session kill. Because the job is disabled it can never run, so the count could never decrease: the agent was permanently degraded over something nothing could fix, and an operator was nearly told it was an active fire.
- **After.** The same two jobs produce `consecutiveJobFailures: 1`, `status: ok`, and `staleJobFailures: { total: 118, windowHours: 24, jobs: [{ slug: "w29-working-set-mirror", failures: 118, lastRun: "2026-09-26T07:01:15.227Z", reason: "disabled" }] }`. Asserted end-to-end through the real route pipeline in `tests/integration/health-stale-job-failures.test.ts` (4 tests), including that five current failures still degrade, and that the excluded detail never appears for an unauthenticated caller.
- **Boundaries.** `tests/unit/job-failure-currency.test.ts` (11 tests) covers both sides of each decision: enabled/disabled, inside/outside the window, exactly at the edge, absent and unparseable timestamps (both count as current, so a corrupt state file cannot silence a real failure), a job that is both disabled and stale (reported as disabled, the actionable reason), and the list cap keeping the worst offenders while the total still counts every excluded failure.

## Summary of New Capabilities

- The health report distinguishes a job failing now from a job that failed once and was then switched off, and says which is which.
