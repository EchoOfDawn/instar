---
title: "Threadline without Instar: verified pairing, encryption and the credential gate for any agent"
slug: "threadline-standalone-pairing"
author: "dawn"
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
status: "draft r2 (direction approved by Justin; r1 review by Echo addressed)"
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

**D5. Hosts without elicitation fall back to a terminal command, off unless the person turns it on.** If the host does not support elicitation, `threadline_pair_open` and `threadline_pair_finish` refuse. If the person has set `THREADLINE_PAIR_TERMINAL=1` in the host's config for this server, the refusal tells the agent to ask its person to run `npx threadline-mcp pair open | finish | status` in a terminal. Those commands talk to the running server over a `0600` Unix socket in the state dir, so the one running process does the pairing and the relay send. Without the variable the socket is never created and the refusal says only that this host cannot ask the person. This is a **cooperative** boundary: any process running as the same user, an agent with shell access included, can connect to the socket and approve. That is stated in the tool text and the README, the same honesty as Instar's §6.1.

**D6. Encryption is per pinned peer and never silently downgrades.** `threadline-mcp` encrypts every ordinary message to a peer whose identity key is pinned (any pairing state), to the X25519 key derived from the PINNED key, never to a key the relay presented. A message that fails to verify or decrypt with the pinned key is refused, not shown as plaintext. To an unpinned peer, messages stay plaintext as today, and the sending agent is told so.

Inbound plaintext is never attributed to a pinned peer. A plaintext envelope carries no signature, so on the relay path the only evidence of its sender is the relay's word. Plaintext arriving under a pinned fingerprint is therefore delivered, if at all, as **unverified**: labelled "plaintext, claims to be from <fp>, not verified", never "from <peer>", never a credential, never a pairing op other than the accept, and never answered in plaintext. That allowance has an end. Each pin records `encryptedSeen` the first time a message from that peer verifies under the pinned key; from then on, plaintext ordinary chat under that fingerprint is refused outright (a per-peer high-water mark), so a relay cannot downgrade a peer that has ever spoken to us encrypted. Once D9 has shipped, every peer that pairs encrypts from its first message, so the unverified label only covers pre-D9 Instar senders.

**D6a. Listener proxy mode.** When a local Threadline listener answers on `THREADLINE_SEND_PORT` (default 7711), `threadline-mcp` sends through it and has no relay connection of its own. It then cannot pair or encrypt, so `threadline_pair_invite|open|finish` (and the terminal commands) refuse with that reason, and an ordinary message to a peer it holds a pin for is refused rather than sent through the listener in plaintext. Messages to unpinned peers go through the listener as before. Any message containing an invite (`tlinv1:`) is refused in every mode (D4).

**D7. The credential gate is in the package.** `threadline_send` gains `credential: true`. It is refused unless the peer is `mutual-verified` with a pinned key, the envelope is encrypted to the X25519 key derived from that pinned key, and the receiving side applies the same rule on ingestion. Same predicate as Instar's `CredentialShareGate`, from `threadline-core`.

**D8. A changed key is a new agent, never an automatic re-pin.** A Threadline fingerprint is the first 16 bytes of the identity public key, and a pin is valid only when `fp == key[0:16]`, so one fingerprint cannot carry two keys. A pin is never swapped: a `mutual-verified` pin refuses a different key outright, and `markInviteVerified` refuses one while any non-failed pin exists. When an agent rotates or recovers its identity (Instar `identity-recovery`), it has a new fingerprint, and to us it is an unpaired stranger: nothing carries over, sends and credentials to it follow the unpinned rules, and the only way to trust it is a fresh pairing. The old pin stays as it was, bound to the old key, and keeps refusing anything not signed by that key. `threadline_pair_status` flags an unpinned agent that claims the display name of a pinned one ("claims the name of <peer>, different key, not paired"), so the person sees a rotation rather than a stranger with a familiar name. Removing the old pin is an explicit person act (`threadline_pair_cancel` on the pin). Instar's one-identity-across-machines keeps one key across an agent's machines, so it does not trigger this.

**D9. Instar always encrypts ordinary chat to a mutual-verified peer, using the pinned key.** Today Instar 1.3.1352 encrypts ordinary chat only when the relay hands it the peer's X25519 key. After this step, for a peer that is `mutual-verified` through an invite pairing, Instar encrypts every ordinary message to the X25519 key derived from the PINNED identity key, regardless of what the relay offers, and never sends that peer plaintext. If the envelope cannot be built (no pinned key, a key that fails `isX25519BoundToIdentity`, any encryption error), the send is refused with the reason; it never falls back to plaintext. If the peer cannot decrypt, that is the peer's refusal (D6), surfaced to Instar as a failed delivery, and Instar does not retry in plaintext. On a multi-machine agent, a send forwarded from a standby machine is encrypted with the same pinned key, read from the replicated trust store; a standby without the pin refuses rather than sending plaintext. This changes Instar's behaviour, so it ships as its own rollout step (§7 step 5) behind this spec.

**D10. `threadline-core` is published on its own to npm, from `main` only.** It is a separate package (`threadline-core`, public, MIT), published by `.github/workflows/publish-threadline-core.yml`:
- **Trigger:** a push to `main` that touches `packages/threadline-core/**`, or a manual `workflow_dispatch` restricted to `refs/heads/main`. Never `pull_request`, so a fork or PR cannot publish. Commits whose message contains `[skip ci]` are skipped.
- **Who can cause a publish:** only someone who can land a commit on `main` (branch protection plus review) or run a workflow with repo write access.
- **Tokens:** `NPM_TOKEN` (automation token for the `threadline-core` package) for `npm publish`; `RELEASE_TOKEN` only to push the version-bump commit; `id-token: write` for provenance.
- **Provenance:** `npm publish --provenance --access public`, so every version links to the workflow run and commit that built it.
- **Version:** the job builds and runs the package's tests first. If `package.json` equals the published version it bumps the patch and commits the bump with `[skip ci]`; otherwise it publishes `package.json`'s version as is. The first publish is `0.1.0` and is permanent.
- **Order:** a `threadline-mcp` release that depends on `threadline-core` waits until that version is on npm.

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

`identity.json` (existing), `pairing-invites.json` (the store from Instar, same semantics), `pinned-keys.json` (fp → identity key, state, verifiedAt, pairingId, encryptedSeen), and `threadline/pairing-audit.jsonl` (pairing events, refusals, credential sends and receipts; bounded and rotated at 1 MB; never a secret or K). `threadline_pair_status` names the audit file, and `threadline_inbox` shows the newest pairing events as plain `pairing` lines. The existing contacts file keeps its `trust` label, but it no longer counts for anything security-relevant. Only `pinned-keys.json` does.

## 6. Threats (what changes outside Instar)

- **The model is not the operator.** Elicitation is the boundary: the agent can call `threadline_pair_open`, but only the person can answer it. In the D5 fallback, the boundary is cooperative, and that is said plainly.
- **The invite in context.** The recipient side keeps it out (D4). The inviter side cannot (the person needs the text). Single use, a short TTL and binding limit the damage, and so does the second-accept alarm.
- **Downgrade and injection by the relay.** We never send plaintext to a pinned peer (D6, D9), and plaintext that arrives under a pinned fingerprint is never attributed to that peer, and is refused once the peer has spoken encrypted (D6). Before pairing there is no encryption, and the tool text says so.
- **Key rotation and look-alikes.** A new key is a new agent (D8). The risk is a person re-pairing with a stranger who borrowed a familiar name; status says "claims the name of <peer>, different key", and the pairing screens say the names are claimed, not checked.
- **Mixed versions.** An old `threadline-mcp` cannot pair. It only sees plaintext from agents that have no pinned key for it, which is today's behaviour.

## 7. Rollout

1. `packages/threadline-core`, with its own unit tests ported from Instar's (invite, store, flow, envelope compatibility vectors generated by today's `MessageEncryptor`).
2. `threadline-mcp` 0.5.0 on it: the tools in §4, encryption (D6), the gate (D7). An E2E with an in-process relay: a `threadline-mcp` agent pairs with an Instar agent built by `bootstrapThreadline`, then a credential goes both ways.
3. Instar switches its imports to `threadline-core` in a behaviour-identical PR. Its existing pairing tests are the check.
4. A person walks the flow in Claude Desktop with `threadline-mcp`, pairing with an Instar agent (the completion criterion, as §8.5 was for Instar).
5. Instar encrypts ordinary chat to mutual-verified peers with the pinned key (D9). Tests: a paired send is encrypted even when the relay offers no X25519 key; a send with no buildable envelope is refused, never plaintext; a standby-forwarded send uses the pinned key; a standby without the pin refuses. The E2E from step 2 gains a check that the standalone receives no plaintext from the Instar agent after pairing.

## 8. Questions for review

1. Is elicitation support in the hosts we care about (Claude Desktop, Claude Code) reliable enough to make D5 the rare case?

## 9. Later

- **Pre-pairing encryption (`e2e-v1`).** Encrypting to a relay-presented key before pairing would protect against passive reading by the relay operator, not against the relay itself. It needs a capability flag on the relay card and is deferred; nothing in v1 depends on it.
