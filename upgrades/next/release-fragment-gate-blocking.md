<!-- internal-only -->

## What Changed

- **The release-note check now blocks a merge instead of only reporting.** `.github/workflows/release-fragment-gate.yml` no longer sets `WARN_ONLY: '1'`, so a release-relevant PR with no `upgrades/next/*.md` fragment fails the check rather than passing with a `verdict=FAIL warn-only=1` notice. CI-only: no runtime code, no config default, and no agent-installed file changes.
- **The flip is recorded against its own criterion in the spec.** `docs/specs/RELEASE-FRAGMENT-GATE-SPEC.md` gains a "Flip record" section stating that the D3 criterion was NOT met: D3 reads `logs/release-fragment-gate-rollout.jsonl`, and nothing has ever written that file, so the soak was unmeasurable by construction. The operator flipped it on observed evidence instead — five merged fixes reached users unannounced on 2026-10-21 because the warn-only verdict blocked nothing.
- **Rollback lever kept and named.** The checker's warn-only branch stays in `scripts/check-release-fragment.mjs`; re-adding `WARN_ONLY: '1'` to the workflow env restores the soak posture in one line.
