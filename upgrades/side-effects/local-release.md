# Side-Effects Review — one-command local release; pre-push gate accepts release cut commits

**Version / slug:** `local-release`
**Date:** `2026-10-20`
**Author:** `Dawn`
**Second-pass reviewer:** `not required (see Conclusion) — the gate change only narrows a refusal for one exactly-specified diff shape`

## Summary of the change

Two parts. (1) `scripts/pre-push-gate.js` §3b (release-relevant change with no release-note fragment) now exempts a release CUT. The decision lives in the new pure module `scripts/release-cut-diff.mjs` (`classifyReleaseCut`, plus `detectReleaseCut` for the git I/O). A diff is a cut only when, with rename detection off, every entry is: `M package.json` whose parsed JSON differs from the merge-base only in `version` (required); optionally `M package-lock.json` whose parsed JSON differs only in top-level `version` and `packages[""].version`, both equal to the new version; exactly one `A upgrades/<new X.Y.Z>.md` (required); and any number of `D upgrades/next/*.md` / `D upgrades/NEXT.md`. Anything else, or any git/JSON failure, means "not a cut" and §3b runs unchanged. (2) `scripts/release-local.mjs` (`npm run release:local`) runs publish.yml's publish job on a workstation, step for step, with `--dry-run`. `scripts/lint-no-direct-destructive.js` allowlists both scripts (pre-compile scripts that cannot import the SafeGitExecutor funnel, same as `release-skip-annotate.mjs`). Three test fixture copy-lists gain `release-cut-diff.mjs` because the gate now imports it. `CONTRIBUTING.md` documents the path.

## Decision-point inventory

- `pre-push-gate.js §3b` release-fragment check — modify — exempts exactly a release-cut diff.
- `release-local.mjs` — add — an operator-run tool; its decisions (skip on no NEXT.md, tier gate, version) are the existing scripts' decisions, called the way publish.yml calls them.
- All other gate checks (§1 guide validation, §2 version, §3c internal-only lane, §5 side-effects, lints) — pass-through, unchanged.

---

## 1. Over-block

The gate now blocks less, not more. Residual over-block: a release cut that ALSO legitimately changes something else (for example a hand-fixed lockfile) is still refused by §3b. That is intended: such a push is not purely a cut, and needs a fragment or its own PR. A prerelease version (`1.4.0-rc.1`) is not recognised as a cut, because the versioned-guide naming the rest of the pipeline uses is `X.Y.Z` only.

For `release-local.mjs`: it refuses to start on a dirty tree or when HEAD is not `origin/main` (a dry run only warns). It fails closed when `npm view instar version` fails, where CI would fall back to `0.0.0`.

## 2. Under-block

A push that is byte-for-byte a release cut but was produced by hand (someone bumps the version, renames a fragment into a versioned guide) passes §3b. That is the same content the release pipeline would produce, and the other checks still run: the versioned guide is validated by §1 and by `check-upgrade-guide.js`, and §2 refuses a version that goes backwards. It cannot carry code, dependency or script changes, so it cannot ship behavior without a note.

## 3. Level-of-abstraction fit

The exemption sits where the false refusal happens (the local gate's §3b), and is decided by a pure function with its own tests rather than more inline logic in the gate. It does not change the shared release-relevance predicate (`release-relevant-paths.mjs`), which is right: package.json IS release-relevant for ordinary PRs, and the PR-time server gate shares that predicate. The local release script reuses every existing release script instead of re-implementing any of their policy.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface of its own beyond narrowing an existing deterministic push gate.

The pre-push gate is a deterministic safety check on an irreversible action (a push to main), which the principle allows. This change removes a false positive from it for one exactly-specified shape; it adds no new blocking logic. Every uncertain case resolves to the old behavior.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Is this diff a release cut?" is an enumerable structural invariant (which files, which JSON fields), not a judgment between conflicting live signals.

## 5. Interactions

- §1 of the gate: after a cut there are no fragments, so §1 validates the versioned guide (unchanged behavior). §2 then warns that the version equals the newest guide; that warning already fires after every cut and stays a warning.
- §5 side-effects check: no in-flight notes after a cut, so it does not fire (unchanged).
- `.husky/pre-push` runs the Stage-B fingerprint check, fixture guard and smoke tests on the release push; the local release path accepts that cost on purpose (hooks are never bypassed).
- `.husky/pre-commit`: package.json and upgrades/ are outside `instar-dev-precommit`'s scope, so the release commit needs no trace; `npm run lint` runs.
- publish.yml is untouched and keeps committing with `HUSKY=0`; the exemption does not change what it does.
- Test fixtures that copy the gate's imports into a scratch dir now copy `release-cut-diff.mjs` too (`tests/unit/pre-push-gate.test.ts`, `tests/integration/duplicate-build-guard-gates.test.ts`); without it the gate would fail to import there.

## 6. External surfaces

Nothing ships to agents: both scripts are maintainer tooling (the internal-only lane). A local release publishes to npm without provenance, which is visible on the npm package page for that version; the script and CONTRIBUTING.md say so. A local release pushes to main and tags, which needs the maintainer's branch-protection bypass, the same permission CI's release token uses.

## 6b. Operator-surface quality

Not applicable — no dashboard, approval page or grant/secret form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: a release is cut by one maintainer on one workstation against the shared remote. Concurrency with CI or another maintainer is handled the way publish.yml handles it: the version is resolved from the registry, `npm publish` refuses a version that already exists, and the push uses the same fetch-rebase-retry loop (never a force push). The script prints the `gh run cancel` command for the publish.yml run the shipped merge queued.

## 8. Rollback cost

Revert the PR. The gate goes back to refusing release commits (the pre-existing state, which CI never hit). Nothing is migrated and no agent state is involved.

## Conclusion

Narrow fix for a false refusal plus maintainer tooling that calls the existing release scripts. The gate change only relaxes §3b for one exactly-specified diff shape and was mutation-checked (six mutations, all caught); a second-pass reviewer was judged not required because no agent-facing gate, sentinel or watchdog behavior changes.

## Evidence pointers

- Real cut 5a90d6be7 (v1.3.1359): refused by the old gate, accepted by the new one ("Release cut v1.3.1359 recognised", exit 0).
- `tests/unit/release-cut-diff.test.ts`, `tests/unit/release-local-parity.test.ts`, `tests/unit/pre-push-gate.test.ts`.
- `node scripts/release-local.mjs --dry-run` on this branch (output summarised in the PR).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (The defect is in maintainer push tooling; its guard is the new unit and integration tests.)
