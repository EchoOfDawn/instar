---
title: "Threadline without Instar: verified pairing, encryption and the credential gate for any agent"
slug: "threadline-standalone-pairing"
author: "dawn"
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
status: "draft r2 (Echo round-1 review addressed, 2026-10-16)"
owners: "Dawn (author), Echo (review)"
builds-on: "docs/specs/a2a-pairing-invite-link.md (the protocol, unchanged)"
eli16-overview: "threadline-standalone-pairing.eli16.md"
review-convergence: ""
review-iterations: 0
approved: false
---

# Threadline without Instar

## 1. Why

Justin, topic 61599, 2026-10-15: *"threadline should NOT require Instar. It should be a self-sufficient service/protocol that any agent can use."*

Today it does require Instar for everything that makes a channel safe for secrets. The standalone package, `threadline-mcp` (0.4.4, `packages/threadline-mcp`, depending only on the MCP SDK, `ws` and `zod`), lets any agent discover others, message, keep contacts and notes, and set a self-assigned trust label. But it:

- sends every message as **plaintext** base64 JSON (`server.ts` ~:818). Only Instar's `MessageEncryptor` encrypts (X25519 from the Ed25519 identity, HKDF, XChaCha20-Poly1305) and signs the envelope;
- has **no verified pairing**. Its `trust` field (`unknown | seen | conversed | trusted`) is set by the agent itself and proves nothing about a key;
- has **no credential gate**. Nothing refuses to send a secret to an agent whose key nobody verified.

Invite pairing (instar 1.3.1352, spec `a2a-pairing-invite-link.md`) fixed the human step, but only inside Instar. A Claude Desktop user running `threadline-mcp` cannot pair with anyone, and cannot pair with an Instar agent at all.

## 2. Decisions

**D0. The principle (Justin, topic 61599, 2026-10-15T18:51Z).** *"Instar should do what it can to further streamline the processes and optimize them, especially between Instar agents, but the fundamental requirements of agent to agent communication should be self contained in Threadline (and the external packages we develop that both Threadline and Instar use)."* So identity, pairing, encryption and the credential gate belong in Threadline's packages, and work fully without Instar. Instar's Telegram buttons, dashboard card, replication across machines and convenience routes are streamlining layered on top. They are never the only way to do something fundamental. Every later decision here follows from this, and future Threadline work should be checked against it.

**D1. One implementation, in a package with no Instar imports.** New `packages/threadline-core` holds: identity keys; the X25519 derivation and `isX25519BoundToIdentity`; the message envelope (encrypt, decrypt, sign, verify), byte-compatible with Instar's `MessageEncryptor`; the invite format, transcript, MAC key, tag and check code (today's `PairingInvite.ts`, already pure); the protocol engine (today's `PairingInviteFlow.ts`, already I/O-injected); a file-backed invite store and a pinned-key store behind small interfaces; and the credential-gate predicate. Both `threadline-mcp` and Instar depend on it. Instar keeps its own trust manager, routes, Telegram and dashboard, and calls the core for the protocol.

**D2. Wire compatibility is the acceptance test.** A `threadline-mcp` agent and an Instar 1.3.1352+ agent must pair with each other and then exchange an encrypted credential. Same envelope, same four invite ops (`pair-invite-accept|used|finish|ack`), same transcript.

**D3. The person approves through the MCP host, not through the agent.** `threadline-mcp` uses MCP **elicitation** (the server asks the host to put a question to the human and return the answer). The model cannot answer an elicitation; the host shows it to the person. It is used for the two operator acts:
- **Accept** (recipient): "Pair with the agent that calls itself X, which says it belongs to Y? Check code: K7Q2." Approve / Decline.
- **Finish** (inviter): "The agent that calls itself Z accepted your invite. Finish only if that is who you sent it to." Finish / Not them.

**D4. The recipient's invite never passes through the model.** `threadline_pair_open` takes no invite argument. It elicits "Paste the invite you were sent" from the person, so the secret goes from the person to the server and is never in the model's context, transcript or logs. An invite is never relayed either: `threadline_send` refuses any message that contains one (`tlinv1:`), in every mode, because an invite works once and whoever sees it first is offered to the inviter's person.

**D5. Hosts without elicitation: a terminal command, off unless the person turns it on.** If the host cannot elicit, the pair tools refuse and say how to proceed. The person can set `THREADLINE_TERMINAL_PAIRING=1` for `threadline-mcp` in the host config; only then does the running server listen on a Unix socket in its state dir (`pair.sock`, 0600, in the 0700 state dir), and `npx threadline-mcp pair open | finish | status` talks to that server and asks each question on the terminal. One process keeps the relay connection and the pairing state. This boundary is **cooperative**, and the tool text and README say so: any process running as the same user can reach the socket, including an agent with a shell. Off by default means a host that can ask the person directly never exposes it. The command refuses without an interactive terminal, never takes over a live server's socket (only a stale one is replaced), closes a connection idle for 15 minutes (the pending question is answered with nothing), and allows at most 4 connections.

**D6. Encryption per peer, and no downgrade.**
- *To a pinned peer:* every message is encrypted to the pinned identity key (and the X25519 key derived from it), never to a relay-presented key. A message that fails to verify or decrypt is refused, never shown as plaintext.
- *Before pairing:* plaintext, as today. The sending agent is told when a message went unencrypted.
- *An acceptor waiting for the inviter's Finish* sends as before pairing: the inviter holds no key for it yet, so an encrypted message would be lost.
- *Plaintext naming a pinned sender:* on the relay path the sender is only the relay's word. It is delivered as "from that peer" only if the envelope is signed by the pinned key. Otherwise it is delivered labelled as an unverified claim ("the relay could have written it"). It never counts as a credential, and the standalone never replies in plaintext to a pinned peer.
- *The downgrade high-water mark:* once a pinned peer has sent encrypted ordinary chat, plaintext in its name is refused from then on (persisted per peer, 0600). Pairing messages and credentials do not set the mark, because they are always encrypted, even from Instar versions that still send ordinary chat in plaintext. In v1 the mark lives in `threadline-mcp`; it moves to `threadline-core` when Instar adopts the same rule (rollout step 3c).
- *Listener proxy mode:* when a local Threadline listener answers on `THREADLINE_SEND_PORT` (default 7711), `threadline-mcp` sends through it and has no relay connection of its own, so it cannot pair or encrypt. The pair tools refuse with that reason, and a message to a pinned peer is refused rather than sent through the listener in plaintext. Messages to unpinned agents go through the listener as before.

**D7. The credential gate is in the package.** `threadline_send` gains `credential: true`. It is refused unless the peer is `mutual-verified` with a pinned key, the envelope is encrypted to the X25519 key derived from that pinned key, and the receiving side applies the same rule on ingestion. Same predicate as Instar's `CredentialShareGate`, from `threadline-core`.

**D8. A key never changes under a pin.** A Threadline fingerprint is the first 16 bytes of the identity key, so an agent that rotates or recovers its identity has a new fingerprint: it is a different agent to every peer. A pin can therefore never move to a new key, and nothing re-pins automatically. An envelope that names a pinned fingerprint but is signed or encrypted with another key fails verification and is refused (D6). The old pin stays visible in `threadline_pair_status`; the person removes it with `threadline_pair_forget` (an operator act, because forgetting removes the always-encrypt rule and the credential right), and the agent's new identity is paired from scratch with a new invite. Any identity operation in Instar is covered either way: one that keeps the key keeps the pin, and one that makes a new key makes a new fingerprint, which needs a new pairing.

**D9. Instar encrypts ordinary chat to peers paired by invite (rollout step 3b).** Instar 1.3.1352 encrypts ordinary chat only when the relay has handed it the peer's X25519 key this session, so after a restart it can send a paired peer plaintext. With this step Instar's `sendAuto` consults an encrypt-to resolver first. For a peer that is `mutual-verified` **and** was paired by invite (no SAS fingerprint), it always encrypts to the pinned identity key via `sendToPinned`. If that send fails (bad key, not connected), it throws: there is no plaintext fallback. Two exclusions keep every message readable. An acceptor still waiting for the inviter's Finish is excluded, because the inviter holds no key for it. A peer paired by the older SAS method keeps the previous rule, because it may run a version before 1.3.1345, which cannot decrypt to a pinned key without a cached one, while both sides of an invite pairing run 1.3.1352 or later. **Multi-machine (open point for review):** a pairing replicated to the agent's other machines (FD11) arrives there as `identity-verified` and carries only five fields, with no record of how the pairing was made. On those machines the resolver therefore applies the previous rule, which is safe (never unreadable) but is not yet "always encrypted". Closing it means the replicated record carrying the pairing method (`invite` or `sas`) as a sixth field, so a standby machine applies the same rule with the same pinned key. That is a change to the replicated-store schema, proposed here for review rather than assumed. Receiving is unchanged: every Instar version that can pair by invite already decrypts messages encrypted to its pinned key. Instar adopting the D6 high-water mark on its receive side is step 3c.

**D10. `threadline-core` is published as its own package.** It is published by `.github/workflows/publish-threadline-core.yml`. *Trigger:* a push to `main` touching `packages/threadline-core/**`, or a manual run of the workflow. *Build:* `npm install`, then `npm test` (tsc plus the package's tests) must pass before anything is published. *Version:* if `package.json` already matches the published version, the workflow bumps the patch and commits the bump back to `main` (`[skip ci]`), using the `RELEASE_TOKEN` secret, a PAT that can bypass branch protection for that commit. *Publish:* `npm publish --provenance --access public` authenticated by the `NPM_TOKEN` repository secret, with the GitHub OIDC token (`id-token: write`) for npm provenance, so every published version links to the commit and workflow run that built it. *Who can cause a publish:* anyone who can merge to `main` or dispatch workflows in this repository, which is the same set who can release `threadline-mcp` today (its workflow has the same triggers). `threadline-core` must be on npm before any `threadline-mcp` release that depends on it.

## 3. The protocol

Unchanged from `a2a-pairing-invite-link.md` §4: invite fields, 1 h default and 24 h max expiry, binding by default for a known peer, the HMAC-and-signature accept, the signed finish and ack, the second-accept response (one alarm and one demotion per invite), and K kept only until `exp`. This spec moves code. It does not change the protocol.

## 4. `threadline-mcp` tools added

| Tool | Who | Operator act? | Notes |
|---|---|---|---|
| `threadline_pair_invite` | inviter | no | `{ for?: <known contact or fingerprint>, ttlMinutes? }`. Returns the invite message for the person to send privately. The inviter's own secret is in the inviter agent's context, as in Instar's MCP `invite` action. |
| `threadline_pair_open` | recipient | yes (elicitation) | Elicits the pasted invite (D4), checks it, then elicits Accept/Decline (D3). On Accept, pins the inviter as `invite-accepted` and sends the accept. |
| `threadline_pair_finish` | inviter | yes (elicitation) | Lists accepts waiting; elicits Finish / Not them for one. |
| `threadline_pair_status` | either | no | Pairings, open invites, waiting decisions, leak alarms. Never the secret or K. |
| `threadline_pair_cancel` | inviter | no | Revokes an open invite. |
| `threadline_pair_forget` | either | yes (elicitation) | Unpairs from an agent after the person confirms (D8). |

Inbound invite ops are handled by the server's relay listener, never surfaced to the model as messages. Events (accept arrived, paired, leak alarm) are recorded in the state dir and reported by `threadline_pair_status` and in `threadline_inbox` as system lines, not as agent messages.

## 5. Storage (state dir, 0700; files 0600)

`identity.json` (existing); `threadline/pairing-invites.json` (the invite store, same semantics as Instar's); `threadline/pinned-keys.json` (fingerprint to identity key, state, `verifiedAt`, `pairingId`, `via`); `threadline/encrypted-chat-peers.json` (the D6 high-water mark: fingerprint to first-seen time); `threadline/pairing-audit.jsonl` (every pairing event, refusal, and credential send or receipt; never message content, invite text or keys; rotated to `.1` past 1 MB; named by `threadline_pair_status`); and `pair.sock` only when terminal pairing is on (D5). The newest pairing events also appear in `threadline_inbox` as plain `pairing` lines, never as agent messages. The contacts file keeps its `trust` label, but it no longer counts for anything security-relevant; only `pinned-keys.json` does.

## 6. Threats (what changes outside Instar)

- **The model is not the operator.** Elicitation is the boundary: the agent can call `threadline_pair_open`, but only the person can answer it. In the D5 fallback, the boundary is cooperative, and that is said plainly.
- **The invite in context.** The recipient side keeps it out (D4). The inviter side cannot (the person needs the text). Single use, a short TTL and binding limit the damage, and so does the second-accept alarm.
- **Downgrade and injection by the relay.** After pairing, nothing is sent to that peer in plaintext (D6). In the other direction, a relay can inject plaintext in a pinned peer's name: it is never delivered as from that peer unless signed by the pinned key, and once the peer has sent encrypted chat it is refused outright (D6). Before pairing, messages are plaintext and the relay can read them, as today.
- **A peer's new key.** A new key is a new fingerprint and needs a new pairing; a pin never moves (D8).
- **The terminal socket.** Off by default; when on, any same-user process can answer through it, which is stated (D5).
- **Mixed versions.** An old `threadline-mcp` cannot pair. It only sees plaintext from agents that have no pinned key for it, which is today's behaviour.

## 7. Rollout

1. `packages/threadline-core`, with its own unit tests ported from Instar's (invite, store, flow, and envelope compatibility vectors generated by Instar's `MessageEncryptor`). Published per D10. (PR #2195.)
2. `threadline-mcp` 0.5.0 on it: the tools in §4, encryption and the downgrade rules (D6), the gate (D7), the terminal fallback (D5), and the audit log. An E2E with an in-process relay: the built `threadline-mcp` over stdio pairs with an Instar agent built by `bootstrapThreadline`, then a credential goes across. A second E2E covers listener proxy mode. (PR #2196.)
3. Instar switches its imports to `threadline-core` in a behaviour-identical PR. Its existing pairing tests are the check.
   - 3b. Instar encrypts ordinary chat to invite-paired peers (D9). E2E on a real relay with both key caches cleared: before Finish the acceptor's message still arrives; after Finish both directions are encrypted; an SAS-paired peer keeps the old rule.
   - 3c. Instar's receive side adopts the D6 high-water mark, and the mark moves into `threadline-core`.
4. A person walks the flow in Claude Code with `threadline-mcp`, pairing with an Instar agent (the completion criterion, as §8.5 was for Instar). On a machine running a Threadline listener, `THREADLINE_SEND_PORT` must point at an unused port so `threadline-mcp` has its own relay connection (D6, listener proxy mode).

## 8. Open question for review

1. Is elicitation reliable enough in the hosts we care about to keep D5 the rare case? A sub-agent's reading of Claude Code's documentation found that Claude Code shows a server's elicitation request as a dialog and blocks until the person answers; Claude Desktop's support is not confirmed. The walkthrough (step 4) answers this for Claude Code directly.
2. D9's multi-machine point: should the replicated pairing record carry the pairing method so standby machines apply D9 too?

## Later (not in this spec)

- Encrypting before pairing, to a relay-presented key, for confidentiality from the relay operator (not authentication). It needs a capability on the relay card (an `e2e-v1` flag), so a peer that cannot decrypt is never sent ciphertext.
