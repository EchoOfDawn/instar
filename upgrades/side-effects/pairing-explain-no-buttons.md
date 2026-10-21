# Side-Effects Review — A pairing message with no buttons says why

**Version / slug:** `pairing-explain-no-buttons`
**Date:** `2026-10-21`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo, on the Studio, before push (pending at commit time)`
**Spec:** `docs/specs/a2a-pairing-invite-link.md` §6.1 (r6, approved: false).

## Summary of the change

Justin's second PP test (12:57 PDT, 2026-10-21) still got "Open the Threadline tab on the dashboard". The possible causes were: PP not on 1.3.1383, a lifeline that never armed the guard, held observe, bypass, or a polling server. Nobody could tell which one without access to PP's machine (dabomb-ultra), and neither Echo nor I have that access.

1. `src/server/LifelineIngressGuard.ts`: `tapsUnprovableReason()` returns null when `tapsProvable()`; otherwise one plain cause (bypass, held observe, never proven, no secret held).
2. `src/threadline/PairingInviteTelegram.ts`: optional `whyNoButtons` dep; `offLine()` puts the cause into the three "Approving in Telegram is off" messages (forwarded invite, tap refusal, finish prompt). Without the dep, or if it throws, the old generic line is used.
3. `src/server/routes.ts`: wires `whyNoButtons`, which says "reads Telegram directly" when the server polls, and otherwise uses the guard's reason, with `(Instar <version>)`.

## Decision-point inventory

None. When buttons show and which taps count are unchanged; only the text of an existing message changes.

## 1. Over-block / 2. Under-block

No change. `enforcing()` and `operatorTap` are untouched apart from where the text comes from.

## 3. Level-of-abstraction fit

The guard knows why it can't prove a tap; routes adds the polling case and version; pairing only renders.

## 4. Signal vs authority compliance

The text is a signal to the owner and authorises nothing.

## 5. Interactions

The same messages are still sent; they get longer by one clause. No other caller of `tapsUnprovableReason()`.

## 6. External surfaces

Telegram text only. The reason includes the Instar version and a config state (watch-only / bypass), and nothing secret. It goes to the owner's own chat, where the dashboard pointer already went.

## 7. Multi-machine posture

Machine-local, as before.

## 8. Rollback cost

Remove the `whyNoButtons` wiring; the generic line returns.

## Evidence pointers

- Unit: `tests/unit/lifeline-ingress-guard.test.ts` › tapsUnprovableReason.
- Integration (real routes): `tests/integration/pairing-invite-telegram-routes.test.ts` › never proven (mutation-checked: wiring returning null fails it).
- E2E: `tests/e2e/threadline/pairing-handshake-production-path.test.ts` › "a new agent whose listener never proved itself…" (mutation-checked).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is fixed and no self-triggered sends are added.
