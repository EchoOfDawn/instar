# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **A pairing message with no buttons now says why.** When an agent can't offer Telegram Approve/Finish (spec §6.1), its "Open the Threadline tab on the dashboard" message used to say only "until its listener protection is fully on". It now names the cause and the agent's Instar version: the listener hasn't proven itself yet (older or not running), the protection is watch-only or bypassed in config, the secret can't be read, or the agent reads Telegram directly. New: `LifelineIngressGuard.tapsUnprovableReason()` and the `whyNoButtons` dep on `PairingInviteTelegram`, wired in `routes.ts`. Nothing about when buttons show changes.

## What to Tell Your User

If I ever can't show you pairing buttons in Telegram, I'll now tell you why in the same message, so you know what's wrong without anyone checking my machine.

## Summary of New Capabilities

- `LifelineIngressGuard.tapsUnprovableReason()`.

## Evidence

- `tests/unit/lifeline-ingress-guard.test.ts` › tapsUnprovableReason (null when provable; never proven; held observe; bypass).
- `tests/integration/pairing-invite-telegram-routes.test.ts` (real routes): a never-proven new agent's reply names the cause and "(Instar …)". Mutation-checked against the wiring.
- `tests/e2e/threadline/pairing-handshake-production-path.test.ts` › "a new agent whose listener never proved itself…": real relay, real guard. The Finish prompt names the cause and the version, with no buttons. Mutation-checked.
