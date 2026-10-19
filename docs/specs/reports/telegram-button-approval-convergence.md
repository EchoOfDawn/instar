# Convergence Report — Telegram-button approval

**Spec:** [docs/specs/telegram-button-approval.md](../telegram-button-approval.md)
**Slug:** `telegram-button-approval`
**Status:** ⚠ **convergence-failed** — the 10-iteration cap was reached with DESIGN-class findings still being
raised in round 10. The `review-convergence` tag is **not** written. Human input is required before a retry.
**Iterations:** 11 (2026-10-19; round 11 was a desk-approved extra round under the 80/20 convergence standard)

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran in rounds 2–10 through the agent's codex CLI. Round 1's pass degraded
(`error`): the main checkout's built reviewer module was stale and resolved the retired `gpt-5.5`, which the
ChatGPT-account Codex refuses; from round 2 the reviewer ran from a fresh build of `origin/main`, which resolves
`gpt-6-astra`. Gemini was not authenticated on this machine (`gemini-not-authed`). The Anthropic clean-door
second read (`claude-code:claude-fable-5`, not cross-family) ran in all ten rounds. The six internal reviewers
ran each round on `claude-opus-5-5` via `claude -p` (this session could not spawn subagents). The
Standards-Conformance Gate ran every round (1–3 signal-only flags each; recurring flag: *Canonical Pipeline
Operational Completeness* on the human per-PR floor, refuted by several reviewers and kept as an operator
question in the spec).

## ELI10 Overview

The operator asked whether he could approve things with a Telegram button instead of typing a dashboard PIN,
and said he cannot be the bottleneck for ~300 feedback fixes. This spec answers both. Today neither the PIN nor
a button is a real lock: the agent can read the PIN, can fake a button press, and anyone holding the agent's
API key can make the agent do anything — and the PIN itself is exchanged for that key. So a button would lose
nothing today; but once the PIN moves onto the operator's phone as a passkey, a button can never match it,
because Telegram cannot prove whose hand pressed it. Buttons may therefore only ever approve things that are
safe even if faked (stop, hold, decline).

What ships now is small: the rule, written into the reviewers' lessons index, two dated notes on older specs
whose "the agent can never approve this" promises are weaker than they read, and (after approval) a test that
fails when someone adds a Telegram button site without classifying it. The PIN's real fixes — including a live
leak this review found, filed as ACT-113 — go to one follow-up spec. On volume, no change of venue helps; a
proposed evidence card was examined in depth and rejected because its honesty promise cannot be enforced. The
standing structural answer is a second trusted reviewer, the operator's decision.

## Original vs Converged

- **Originally:** build a Telegram tap gate for "re-grant" approvals and harden the callback route with a
  Telegram check. **Now:** no tap gate at all — the only re-grant candidate needs no human (a daily cap reset,
  ACT-118), and checking a callback with Telegram proves a press happened, not who pressed.
- **Originally:** "today the PIN and a tap are equivalent, both stop an outsider with the API token."
  **Now:** neither stops that outsider — the token can spawn a session that does anything (G11), and the PIN is
  exchanged for the token. Approvals on this host are intent records, not boundaries.
- **Originally:** fix the PIN leak in this build. **Now:** the leak (the agent's own chat history serves the PIN
  to any token holder) is an urgent separate item (ACT-113) — it touches every copy of history, and rewriting
  stored history needs its own design. Route-level detail is kept out of this public document until fixed.
- **Originally:** link buttons on the action list. **Now:** dropped — the messages already carry tappable
  links, and a keyboard can be silently dropped on the relay path or block the whole list.
- **Added (coordinator input, round 9):** an evidence card per executor PR. **Now rejected** under its own kill
  condition: the diff it would show is session-written prose, the "reproduced" verdict rests on output the
  session's test prints, and every fix carries a test file. A smaller, commit-bound inventory card stays
  possible, to revisit once the executor has produced pull requests.
- **Added:** the full volume analysis (options (a)–(g)), the constitutional collision between the rung floor and
  *Canonical Pipeline Operational Completeness* as an operator question, and a class map with an annotation-based
  test as the rule's structural carrier.

## Iteration Summary

| Round | Reviewers raising DESIGN findings | DESIGN bullets (all reviewers) | Main spec changes |
|---|---|---|---|
| 1 | all six internal | ~40 | lifeline-secret forgery path; revoke ≠ R; R has no consumer; maturation, migration gaps |
| 2 | security, adversarial, integration, scalability, decision-completeness, codex | ~35 | answer-first callback check dropped; existing taps classified; Bearer PIN leak found (G3) |
| 3 | all | ~34 | leak fix moved to ACT-113; Bounded Blast Radius miscitation; buttons scoped |
| 4 | adversarial, integration, scalability, decision-completeness, lessons, codex | ~19 | buttons dropped; build reduced to an instruction section |
| 5 | security, adversarial, integration, decision-completeness, lessons, codex | ~12 | T1 reason corrected; operator-session token; instruction wording |
| 6 | all except scalability | ~16 | G11 (token = full control); instruction change moved to sibling; L15 carrier |
| 7 | all | ~15 | class map + test; burn-alert buttons (G12, ACT-119); option (e)/(f); supersession notes |
| 8 | all | ~13 | site-keyed map; prompt-gate always-approve (ACT-120); per-PR floor wording |
| 9 | all | ~37 | evidence card (d) added, judged, rejected; constitution wording narrowed |
| 10 | security, adversarial, integration, scalability, decision-completeness, lessons, codex | ~9 | prompt-gate is P (exception); annotation-based site test; rotation revokes token; (d) reframed |

| 11 | all six internal, codex | ~16 | dispatch entry points listed and discovered; comment/type lines skipped by parser; Slack prompt buttons mapped; exceptions end on events, age only warns; burn-alert `handle` exists |

Round 11 was run on the desk's instruction to test the 80/20 standard ("stop when findings stop changing
the build"). It still produced build-changing findings — all on the class-map test — so the tag is not
written. Round 11's findings were applied in the spec text after the round; no round reviewed those edits.

## Findings still open at the cap (rounds 10–11, addressed in text, unreviewed)

- Prompt-gate answers are not S-equivalent (the permission floor answers only registered approval prompts):
  reclassified as P under an event-bound exception tied to ACT-120.
- The class-map test's counting rule was undefined and missed the pairing button method: redesigned as
  required `// callback-site:` annotations on every button/dispatch line, with listed generic button methods.
- PIN rotation without revoking the API token and sessions does not close T3: sibling item 2 now requires both.
- S-class floods: future S taps must be rate-bounded with the way back off the tap venue.
- The (d) rejection was reframed: the ten-second promise is unsupported; a smaller commit-bound card is possible
  but unmeasured with zero executor pull requests.
- Round 11 (build-changing, class-map test): dispatch branches were undiscoverable (now: listed entry points,
  every branch inside them must be annotated); the line rule matched comments and types (now: parser-based);
  pairing's `{text, data}` literals and Slack `prompt::` buttons were unmapped (now mapped); `BurnAlertButtons.handle`
  exists, so `unwired` means unconstructed; a fixed review-by date would redden the suite fleet-wide (now: event-bound
  end, age only warns); the prompt-gate exception must end when sibling item 7 moves every authority-bearing
  answer, not at ACT-120.

## Hand-offs (this agent's evolution queue, owner `echo`)

ACT-113 PIN readable with the API token (high, due 2026-10-26) · ACT-115 fail-open owner checks · ACT-116
remediator countersignature · ACT-117 triage-spec Bounded Blast Radius miscitation · ACT-118 spend-brake
auto-resume · ACT-119 burn-alert buttons · ACT-120 prompt-gate always-approve row.

## Convergence verdict

**Not converged.** Eleven rounds; DESIGN-class findings were still arriving, though they narrowed from
architecture (rounds 1–3) to the mechanics of one unit test (rounds 10–11). The analysis
sections — the head-on answer, the classes, the volume options and their recommendation — were stable from
round 8 onward apart from the (d) addition. A retry needs a human decision on scope: either accept the
documentation-only part (rule, notes, hand-offs) and split the class-map test into its own small spec, or run a
fresh convergence on this text.
