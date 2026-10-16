---
title: "Threadline without Instar: verified pairing, encryption and the credential gate for any agent"
slug: "threadline-standalone-pairing"
author: "dawn"
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
status: "draft r1 (direction approved by Justin)"
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

**D4. The recipient's invite never passes through the model.** `threadline_pair_open` takes no invite argument. It elicits "Paste the invite you were sent" from the person, so the secret goes from the person to the server and is never in the model's context, transcript or logs. (Passing the invite as a tool argument is refused when it contains `tlinv1:`, with a message telling the agent to call the tool without it.)

**D5. Hosts without elicitation fall back to a terminal command, and say so.** If the host does not support elicitation, the approve and finish tools refuse and tell the agent to ask its person to run `npx threadline-mcp pair approve` (or `finish`) in a terminal. The command reads the pending state from the agent's state dir and prompts on the TTY. This is a **cooperative** boundary: an agent with shell access can run it too. That is stated in the tool text and the README, the same honesty as Instar's §6.1. *As built:* the commands are `npx threadline-mcp pair open | finish | status`; they connect to the running server over a 0600 socket in the state dir rather than reading state files, so the single running process does the pairing and the relay send.

**D6. Encryption turns on per peer, never silently downgrades.** After pairing, every message to that peer is encrypted to its pinned key, and a message that fails to decrypt is refused, not shown as plaintext. Before pairing, a message to a peer whose relay card advertises `e2e-v1` is encrypted to the relay-presented key (confidentiality from the relay operator, not authentication). A peer without `e2e-v1` (an old `threadline-mcp`) gets plaintext, labelled as such to the sending agent. Credentials never go plaintext (D7).

**D6 as built in v1 (2026-10-16).** `threadline-mcp` encrypts to every peer whose key is PINNED (any pairing state), never to a relay-presented key, so the `e2e-v1` capability question (§8.1) is deferred and pre-pairing messages stay plaintext as today. Instar 1.3.1352 still encrypts ordinary chat only when the relay gave it the peer's X25519 key, so a paired Instar agent may send the standalone plaintext. The standalone delivers that, marked unencrypted and from a paired peer, and never as a credential; it never replies in plaintext. Step 9 makes Instar encrypt to pinned peers using the pinned key, which closes this from Instar's side.

**D7. The credential gate is in the package.** `threadline_send` gains `credential: true`. It is refused unless the peer is `mutual-verified` with a pinned key, the envelope is encrypted to the X25519 key derived from that pinned key, and the receiving side applies the same rule on ingestion. Same predicate as Instar's `CredentialShareGate`, from `threadline-core`.

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

Inbound invite ops are handled by the server's relay listener, never surfaced to the model as messages. Events (accept arrived, paired, leak alarm) are recorded in the state dir and reported by `threadline_pair_status` and in `threadline_inbox` as system lines, not as agent messages.

## 5. Storage (state dir, all `0600`)

`identity.json` (existing), `pairing-invites.json` (the store from instar, same semantics), `pinned-keys.json` (fp → identity key, state, verifiedAt, pairingId), and `pairing-invite-events.jsonl` (bounded, rotated at 1 MB, never secrets). The existing contacts file keeps its `trust` label but it no longer counts for anything security-relevant. Only `pinned-keys.json` does.

## 6. Threats (what changes outside Instar)

- **The model is not the operator.** Elicitation is the boundary: the agent can call `threadline_pair_open`, but only the person can answer it. In the D5 fallback, the boundary is cooperative, and that is said plainly.
- **The invite in context.** The recipient side keeps it out (D4). The inviter side cannot (the person needs the text). Single use, a short TTL and binding limit the damage, and so does the second-accept alarm.
- **Downgrade by the relay.** After pairing there is no plaintext path to that peer (D6). Before pairing, encryption to the relay-presented key protects only from passive reading, and the tool text says so.
- **Mixed versions.** An old `threadline-mcp` cannot pair. It only sees plaintext from agents that have no pinned key for it, which is today's behaviour.

## 7. Rollout

1. `packages/threadline-core`, with its own unit tests ported from Instar's (invite, store, flow, envelope compatibility vectors generated by today's `MessageEncryptor`).
2. `threadline-mcp` 0.5.0 on it: the tools in §4, encryption (D6), the gate (D7). An E2E with an in-process relay: a `threadline-mcp` agent pairs with an Instar agent built by `bootstrapThreadline`, then a credential goes both ways.
3. Instar switches its imports to `threadline-core` in a behaviour-identical PR. Its existing pairing tests are the check.
4. A person walks the flow in Claude Desktop with `threadline-mcp`, pairing with an Instar agent (the completion criterion, as §8.5 was for Instar).

## 8. Questions for review

1. Does the relay card already carry a capability list, or does `e2e-v1` need a relay change? (D6.)
2. Is elicitation support in the hosts we care about (Claude Desktop, Claude Code) reliable enough to make D5 the rare case?
3. Should `threadline-core` be published on its own, or bundled into `threadline-mcp` and Instar?
