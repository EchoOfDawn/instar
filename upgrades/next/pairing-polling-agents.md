# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **Pairing works on an agent with no lifeline.** When the server polls Telegram itself, a forwarded invite answered "I can't take it from this chat", and a pairing tap answered "Approve this on the dashboard". Pairing also dropped every button whenever `isPolling` was true. `TelegramAdapter.setPairingHandler()` (wired in `routes.ts`) now hands invites and `pi:` taps read with `getUpdates` to the same `PairingInviteTelegram` handler, marked as read from Telegram, and the owner, chat and one-time-token checks still apply. Unauthorized senders still get nothing. `enforcing` stays true while polling when the handler is wired. `LifelineIngressGuard.tapsProvable()` now arms a no-lifeline guard on first call, as `health()` already did, so a fresh polling agent's first pairing isn't treated as unarmed. Found by Luna's read-only check of PP (1.3.1384, no lifeline, `armedBy: no-lifeline-ingress`).

## What to Tell Your User

If I read Telegram myself (no separate listener), pairing now works with buttons too: forward me an invite, tap Approve or Finish, and I'll handle it right in Telegram.

## Summary of New Capabilities

- `TelegramAdapter.setPairingHandler()` / `hasPairingHandler()`.

## Evidence

- `tests/unit/pairing-invite-never-persisted.test.ts`: on the polling adapter, an authorized forward goes to the handler (read from Telegram) and never to a session; an unauthorized sender gets nothing; a `pi:` tap goes to the handler with tapper and chat; without a handler, nothing changes.
- `tests/unit/lifeline-ingress-guard.test.ts`: a fresh polling agent's guard is provable on the very first call (mutation-checked).
- `tests/integration/pairing-invite-telegram-routes.test.ts` (real routes, polling): routes wires the handler; an invite gives Approve/Decline; another member's tap is refused; the owner's tap approves (mutation-checked against removing the wiring).
- `tests/e2e/threadline/pairing-handshake-production-path.test.ts`: two real agents on a real relay. The polling inviter's Finish tap goes through a real `TelegramAdapter.processUpdate`; another member's tap changes nothing; then both sides report Connected ✓ (mutation-checked).
