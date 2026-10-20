# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **An invite waiting for approval leaves a notice when a restart clears it.** The recipient side of invite pairing keeps a pasted or forwarded invite in memory only, so its secret never reaches disk. A restart used to drop it silently. Now a marker with no secret in it (a hash of the invite id, the claimed agent and owner names, the expiry) is written to `threadline/pairing-pending-accept-markers.json` (0600) while the invite waits, and deleted when it is approved, declined or expires. On startup, an unexpired marker becomes a notice: at the top of the dashboard pairing card (`GET /threadline/pairing/invites` → `restartNotices`, dismissed with `DELETE /threadline/pairing/restart-notices/:id`), and one Telegram message to the operator naming the agent and the expiry in the owner's time zone when their user profile has one (UTC otherwise). The notice ends when the invite is pasted again, dismissed, or expires. Spec: `docs/specs/a2a-pairing-invite-link.md` §8.
- **The auto-updater holds its restart while an invite waits.** `UpdateGate` gains restart holds (in-flight work a restart would lose rather than resume), and `AutoUpdater.gatedRestart` defers through its existing durable deferral record and retry timer while any hold is in force. Each hold ends at its invite's expiry; the re-check runs every 5 minutes or at that expiry, whichever is first. The reason is logged and shown in `restartDeferral`. A manual `POST /updates/apply` is not held.
- **The dashboard's "Could not reach the agent" error clears itself** on the next refresh that reaches the agent, instead of staying until a page reload.

## What to Tell Your User

If you paste or forward a pairing invite and I restart before you approve it, the invite is lost, because I never write its secret to disk. I will now tell you when that happens, on the dashboard and in Telegram, and say when the invite stops working, so you can paste or forward it again in time. I also wait to install updates while an invite is waiting for you, up to when that invite expires.

## Summary of New Capabilities

- `restartNotices` on `GET /threadline/pairing/invites`, and `DELETE /threadline/pairing/restart-notices/:id`.
- `AutoUpdater.setRestartHold(key, provider)` / `UpdateGate.setRestartHoldProvider` and `getActiveHolds`.
- A one-time Telegram notice for an invite a restart cleared.

## Evidence

- `tests/unit/threadline/pairing-pending-accept-markers.test.ts`: the marker file holds neither K, S, the invite text nor the invite id (checked in hex and base64, mode 0600); approve, decline and expiry delete it; a failed send keeps it; a restart yields the notice with the invite's expiry and one Telegram message; after expiry the marker is gone and there is no notice; re-paste and dismiss end the notice.
- `tests/unit/AutoUpdater-restart-holds.test.ts`: the restart is held while an invite waits, on the existing durable deferral, and released when the accept finishes or the invite expires; a manual apply is not held; a run against the real invite engine.
- `tests/unit/dashboard-pairing-panel.test.ts`: the notice sits at the top; the connection error clears itself when the agent answers again; other messages stay.
- `tests/e2e/threadline/pairing-invite-production-path.test.ts`: two real agents on a real relay; the recipient's server and Threadline are restarted on the same state dir; the notice appears with the right expiry, and re-pasting restores the invite.
