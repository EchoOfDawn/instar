# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

> **Catch-up note.** This change merged and shipped on 2026-10-21 with no release note of its own, so it reached users unannounced. Its presence in the published 1.3.1374 and 1.3.1375 packages was confirmed by reading the package contents, not by their version numbers.

- **Notices about interrupted work no longer need a Telegram topic (#2254 — merged and shipped 2026-10-21, unannounced).** `ReapNotifier` resolved its lifeline-bound notices — unbound sessions and the cross-topic index — solely through `lifelineTopic()`, which is Telegram-shaped. On an agent that talks on Slack that is always null, so every such notice was recorded `no-topic` ("lifeline topic not configured") and dropped: the layer whose whole job is to prevent silence was itself silent. Three honest outcomes now replace the single drop — a lifeline topic is used exactly as before; without one the notice goes through the server's notification gateway, which already reaches whichever platforms the agent actually has; and with no destination at all the notice is logged unconditionally and raises one `reap-notice-no-destination` item rather than disappearing.
- **The unanswered-message watcher is built on a Slack-only agent.** `PresenceProxy` and its siblings sat inside `if (sharedIntelligence && telegram)`, so on an agent with no Telegram adapter the whole block — including the watcher that notices an operator message going unanswered — was never constructed. Measured, not assumed: `grep -c 'Presence Proxy wired to Slack'` over the indra agent's entire server log returned **0**. The gate is now `if (sharedIntelligence && (telegram || _slackAdapter))`, with the Telegram-specific hooks inside it individually guarded.

## What to Tell Your User

On an agent that talks to you on Slack rather than Telegram, you now actually get told when a session of mine was interrupted, and I now notice when a message of yours goes unanswered. Both were built in a way that only worked if Telegram was set up, so on a Slack-only agent they were quietly doing nothing.

This change is already running on your machines — it reached you on 2026-10-21. This note is the plain-language explanation you should have had at the time.

## Summary of New Capabilities

- `ReapNotifier` `fallbackNotify` / `raiseNoDestination`; honest `sent` / `no-topic` outcome recording.
- The shared-intelligence block is constructed for Telegram **or** Slack; seven `onMessageLogged` hooks and three `getSessionForTopic` lookups individually guarded.

## Evidence

- `tests/unit/reap-notice-fallback-destination.test.ts` (5): the fallback is used, the outcome is recorded honestly, and total absence logs and raises.
- `tests/unit/presence-proxy-slack-only-agent.test.ts` (6): the watcher is constructed with Slack alone and the Telegram-only hooks stay unset.
- Live measurement, indra 2026-10-20: zero `Presence Proxy wired to Slack` lines in the whole server log; reap records repeating the `no-topic` outcome.
