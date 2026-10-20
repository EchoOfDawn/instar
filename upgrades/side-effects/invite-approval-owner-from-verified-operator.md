# Side-Effects Review — Telegram invite approval uses the verified operator when no owner id is set

**Version / slug:** `invite-approval-owner-from-verified-operator`
**Date:** `2026-10-19`
**Author:** `Dawn`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Pairing by invite in Telegram (spec `docs/specs/a2a-pairing-invite-link.md` §6.1) only lets the agent's owner forward an invite and tap Approve. The owner was read from `TelegramAdapter.getOwnerUserId()`, which returns the Telegram block's `ownerUserId ?? promptGate.ownerId` and nothing else. Agents set up without either (Scout on 1.3.1357; on one machine two of three agents confirmed) refused their real owner with "Only the agent's owner can do this." even though the owner's id was already recorded by the agent's own Know-Your-Principal operator binding.

`src/threadline/PairingInviteTelegram.ts` gains `resolveApprovalOwner(configuredOwner, operatorBindings)`: a configured owner wins; with none, the owner is the single Telegram user named by every VERIFIED topic-operator binding (each record re-checked with `isVerifiedTopicOperatorBinding`); zero or two-plus distinct verified operators gives no owner. `operatorTap()` now separates "no owner" (new wording, `NO_OWNER_REFUSAL`) from "not the owner" (`NOT_OWNER_REFUSAL`, unchanged text). `src/server/routes.ts` wires the pairing dep through it, passing `ctx.telegram.getOwnerUserId() ?? ctx.config.monitoring?.promptGate?.ownerId` and the raw bindings of the local `TopicOperatorStore`. `getOwnerUserId()` itself is untouched.

## Decision-point inventory

- `PairingInviteTelegram.operatorTap` owner check — modify — the owner may now come from a single verified operator binding when none is configured; refusal wording split.
- `resolveApprovalOwner` — add — deterministic resolution of the approving principal.
- `TelegramAdapter.getOwnerUserId()` (owner DMs, tunnel consent prompts, prompt relay) — pass-through, deliberately unchanged.
- `TopicOperatorStore` writes (lifeline-forward and polling auto-bind) — pass-through, read only.

---

## 1. Over-block

The no-owner fallback refuses when two different people are verified operators on this machine, even if one of them is clearly the owner (for example a family member once messaged a topic in an agent with no `authorizedUserIds` allowlist). That is intended: the rule never picks between principals. Such an owner can set `ownerUserId`, or use the dashboard (PIN), which is unchanged. The refusal text now says the agent hasn't been told who its owner is, which points at the fix.

## 2. Under-block

- A topic's binding is replaced when a different authorized sender messages that topic; the store keeps no history. So "single verified operator" means single among current bindings: a second person whose binding was later overwritten on the same topic by the owner is not counted. They would have to message again to show up, and then the agent refuses.
- **The last speaker on a shared topic can become the approver.** The other direction of the same replacement: on an agent with no `authorizedUserIds` allowlist, if the owner and one other group member have only ever spoken in the SAME topic, whoever spoke last holds that topic's binding and is the single verified operator, so that person passes. The exactly-one rule only catches two people bound on different topics. This is the largest remaining gap. It is bounded by: the person must be a real member of the agent's Telegram group, forward and tap through the lifeline with the secret in enforce mode, and the agent already treats that same person as its operator for every other operator-role decision. Agents that set `ownerUserId` (or keep an `authorizedUserIds` allowlist of one) are not exposed. Closing it fully needs the store to keep every distinct verified uid per topic rather than the latest, which changes a Know-Your-Principal store and is outside this fix.
- **An asserted record can matter by deleting.** `POST /topic-operator` (`setOperator`) overwrites a topic's verified binding with an asserted one. An assertion never counts as an owner, but a Bearer caller can erase the owner's verified binding and so turn "two operators, refuse" into "one operator: the other person". That needs the agent's Bearer token, which is inside §6.1's cooperative "Honest boundary".
- In an agent with no `authorizedUserIds` allowlist, every authenticated sender in the group is "authorized", so a binding proves an authenticated Telegram sender, not an owner. If only one other person has ever messaged an otherwise silent agent, that person is the single verified operator. This is the same principal the agent already treats as its operator for every other operator-role decision (session-start `<topic-operator>` block), and the forward and tap must still come through the lifeline with the lifeline-only secret in enforce mode.
- Before the lifeline ingress guard arms (bounded pre-arm allowance in `LifelineIngressGuard`), an unproven forward still carries sender trust and can write a verified binding. A local process with the agent's Bearer token could therefore plant a binding in that window. This is inside the spec's §6.1 "Honest boundary" (the same process could read the lifeline secret file), and approval itself still needs a verified tap from the bound person.

## 3. Level-of-abstraction fit

The fallback lives in the pairing dep, not in `getOwnerUserId()`. `getOwnerUserId()` also chooses the DM target for `sendToOwnerDM` (tunnel URL + PIN + signed view links), the tunnel consent prompt, and prompt-gate relays; widening it would change who receives secrets across the product. The verified-binding primitive (`TopicOperatorStore` + `isVerifiedTopicOperatorBinding`) already exists and is reused rather than re-implemented.

## 4. Signal vs authority compliance

- [x] No — this change has no new brittle block surface; it adjusts which principal an existing deterministic authority check compares against.

The owner check is a safety guard on an irreversible-ish action (pairing grants trust) and is deterministic by design, as spec §6.1 requires. The new input is the store's own verified-binding oracle, not a heuristic.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. "Exactly one verified principal, else refuse" is an invariant (Know Your Principal: an unverified or ambiguous identity is a guess), not a weighing of live signals.

## 5. Interactions

- **Shadowing:** the configured owner still short-circuits, so agents with `ownerUserId`/`promptGate.ownerId` behave exactly as before (test: "a configured owner still wins over a verified operator binding").
- **Double-fire:** none; the resolver is a pure read per forward/tap.
- **Races:** the store caches one JSON file in memory; the same instance the auto-bind writes is the one read (`ctx.topicOperatorStore`), so a bind is visible on the next tap.
- **Feedback loops:** the invite-carrying forward returns before the operator auto-bind, so forwarding an invite never binds anyone.
- **Replication / assertions:** `TopicOperatorReplicatedStore` records are a separate store and are never passed in. Asserted `POST /topic-operator` records are never COUNTED as an owner (filtered by the oracle; tests cover the helper and the real route), but an assertion does replace a verified binding on the same topic, so it can remove one (see §2).
- **Malformed configured owner:** config is raw JSON. A configured owner id written as a numeric string is accepted; any other non-empty configured value means "no owner" and never falls through to the bindings, so a typo cannot hand approval to a binding. (Before, a string owner id silently never matched anyone.)

## 6. External surfaces

- Telegram text: a new refusal "I can't approve this here because this agent hasn't been told who its owner is." followed by the existing dashboard hint. "Only the agent's owner can do this." is kept for a genuine non-owner.
- Agents with no configured owner but one verified operator now get the Approve/Decline prompt instead of a refusal (the fix).
- `monitoring.promptGate.ownerId` now counts as a configured owner for pairing. It never reached `getOwnerUserId()`: the adapter is built from the messaging block's `config` only (`src/commands/server.ts`, both `new TelegramAdapter({...telegramConfig.config, ...})` sites), and `getOwnerUserId()` reads `this.config.promptGate`, i.e. the messaging block's.
- Operator surface: the dashboard PIN route is unchanged and remains the phone-completable fallback named in every refusal.
- No persistent state written.

## 6b. Operator-surface quality

No dashboard or approval-page file touched — not applicable. The Telegram text is plain words.

## 7. Multi-machine posture

Machine-local BY DESIGN. The verified operator binding is per-machine (`state/topic-operators.json`) and the Know Your Principal invariant forbids a replicated record from establishing an operator. The Telegram pairing prompt is served by the machine whose lifeline received the forward, which is the machine whose binding was written from that person's authenticated messages. On a machine that never saw the owner's messages the result is "no owner", the safe direction. No new notices, durable state or URLs.

## 8. Rollback cost

Pure code change. Revert and ship a patch; no data written, no migration. During rollback the affected agents return to refusing (dashboard still works).

## Conclusion

The fix is the narrowest that closes Scout's case: only the pairing dep changes, a configured owner keeps precedence, and the fallback accepts only the store's verified-binding oracle with an exactly-one rule. The review surfaced two honest limits that are recorded above rather than hidden: bindings keep no history, and the pre-arm window can bind from an unproven forward (inside the spec's cooperative boundary). The spec's §6.1 says "the agent's configured operator user id"; this change reads "configured" to include the verified Know-Your-Principal operator when no id is configured. A one-sentence clarification of §6.1 is suggested in the PR rather than edited into the approved spec.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read-only)
**Independent read of the artifact: concern raised; on re-read, concur** (concern 3 fixed in code; concerns 1 and 2 accepted and documented, not fixed)

- Concern 1: the artifact described binding replacement only in the harmless direction; the last speaker on a shared topic can become the approver on an open-allowlist agent. Resolution: documented in §2 as the largest remaining gap, with its bounds, and raised in the PR.
- Concern 2: "asserted records never count" was true only of counting in; an assertion can delete a verified binding. Resolution: §2 and §5 qualified.
- Concern 3: a configured owner of the wrong JSON type (string) was skipped and fell back to bindings. Resolution: code changed: numeric strings accepted, any other configured value means no owner; test added and mutation-checked.
- Confirmed by the reviewer: only `setAuthenticatedOperator` writes records that pass the oracle; both writers require `isAuthorizedSender` and exclude untrusted senders; exactly-one rule and configured-owner precedence hold; the replicated store never writes `topic-operators.json`; an invite forward returns before auto-bind; the pre-arm statement is accurate; leaving `getOwnerUserId()` unchanged is right.

---

## Evidence pointers

- `tests/unit/threadline/PairingInviteTelegram.test.ts` (29 pass): configured owner wins; one verified operator (one or several topics) resolves; two different verified operators, none, asserted-only, legacy/self-described or evidence-mismatched records, and a non-Telegram binding all give no owner; operatorTap uses the new wording for no owner and keeps the old wording for a non-owner; end to end through the class with the resolver.
- `tests/integration/pairing-invite-telegram-routes.test.ts` (12 pass): through the real `/internal/telegram-forward` and `/internal/telegram-callback` routes with a real `TopicOperatorStore`: the owner's own authenticated message binds him and his forwarded invite opens Approve, his tap approves; another sender gets the non-owner refusal; two operators and no binding get the no-owner refusal; an unproven message binds nobody (observe: delivered with identity stripped; enforce: 401); a `POST /topic-operator` assertion never counts; a configured owner wins; `monitoring.promptGate.ownerId` counts.
- Mutation: 9 tried, 9 caught (malformed configured owner never falls through, configured-owner precedence, verified-binding filter, exactly-one rule, platform filter, no-owner wording, sender==owner, route fallback wiring, monitoring.promptGate owner).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a runtime source bug: the owner source ignored the agent's verified operator).
