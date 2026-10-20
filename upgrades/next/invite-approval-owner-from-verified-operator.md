# Pairing invites can be approved in Telegram when the agent has no owner id set

## What Changed

Approving a Threadline pairing invite in Telegram is allowed only for the agent's owner. Until now the agent found its owner only in the Telegram settings (`ownerUserId`, or `promptGate.ownerId` in the same block). Many agents were set up without either, so when their real owner forwarded an invite from his own Telegram account, the agent answered "Only the agent's owner can do this." and sent him to the dashboard.

Now, when no owner id is set, the agent uses the operator it has already verified: the person whose own messages reached it through its Telegram listener and were recorded as its operator. This counts only when every verified operator record on the machine names the same one person. If two different people are recorded, or nobody is, the agent still refuses. Records typed in by hand through the operator API, and records copied from another machine, never count. An owner id that is set still wins, so agents that have one see no change. `monitoring.promptGate.ownerId` now also counts as a set owner for pairing, and an owner id written as text ("7812716706") is read as a number.

When the agent cannot name its owner at all, it now says so: "I can't approve this here because this agent hasn't been told who its owner is." followed by the dashboard pointer. "Only the agent's owner can do this." is kept for someone who genuinely isn't the owner.

The rest of the agent's owner handling (private messages to the owner, tunnel consent prompts) is unchanged.

## What to Tell Your User

If you forward a pairing invite to me in Telegram and you're the person I already know as my operator, I can now show you the Approve button even if nobody ever typed your Telegram id into my settings. If I don't know who my owner is, I'll tell you that plainly and point you to the dashboard instead of saying you're not my owner. If other people also write in my Telegram group, it is safest to set your Telegram id as my owner, so approval never depends on who spoke to me last.

## Summary of New Capabilities

- Telegram invite approval works for the verified operator when no owner id is configured.
- A clear refusal when the agent has no owner it can name.

## Evidence

- `tests/unit/threadline/PairingInviteTelegram.test.ts` (29 pass) and `tests/integration/pairing-invite-telegram-routes.test.ts` (12 pass, through the real forward and callback routes with a real operator store): set owner wins; one verified operator approves; another person is refused as not the owner; two operators, none, a hand-typed record, or a sender whose message was not verified all get the "hasn't been told who its owner is" refusal.
- Breakage: 9 tried, 9 caught (each guard disabled in turn made a test fail).
