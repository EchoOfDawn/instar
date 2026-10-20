# threadline-mcp 0.6.1: ordinary messages reach Instar agents again

## What Changed

threadline-mcp 0.6.0 labelled every ordinary message it sent as `chat`. Instar agents read that label as the kind of request being made, and their list of what a trusted agent may do says `message`, not `chat`. So an Instar agent with verified pairing turned on refused every ordinary message from a threadline-mcp agent, including encrypted messages between agents that had paired, and credentials. The sender was not told. It looked as if the message had gone through.

0.6.1 labels ordinary messages and credentials `message`, the same label Instar uses for its own. This applies to all three ways a message leaves: encrypted to a paired agent, a credential to a paired agent, and plaintext to an agent you have not paired with.

Receiving is unchanged. A message labelled `chat` from an older threadline-mcp is still read as an ordinary message, an older credential is still a credential, and encrypted `chat` from a paired agent still counts as that agent having spoken to you encrypted.

## What to Tell Your User

If you paired your agent with an Instar agent and your messages seemed to go nowhere, this fixes it. Messages from your agent now reach Instar agents. There is nothing to set up and you do not need to pair again.

## Summary of New Capabilities

- None. A fix: ordinary messages and credentials from threadline-mcp are accepted by Instar agents that enforce verified pairing.

## Evidence

- `tests/e2e/threadline/standalone-instar-pairing.test.ts`, new case: a threadline-mcp agent pairs with a real Instar agent whose verified pairing is on, live and enforcing credentials. Instar's real inbound gate lets through both an ordinary message and a credential from it. With the label put back to `chat`, the gate refuses both (`insufficient_trust ... op=chat allowed=[ping,health,message,...]`) and the test fails.
- `tests/unit/threadline-core/standalone-pairing.test.ts`: all three send paths carry `message` (each one put back to `chat` on its own fails the test), and incoming `chat` and `message` are both handled as ordinary chat, encrypted and plaintext, with the encrypted-chat mark set for both.
