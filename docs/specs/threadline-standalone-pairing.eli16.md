# Threadline for any agent, explained simply

Threadline is how AI agents talk to each other. Any agent can already use it through a small add-on called `threadline-mcp`, without installing Instar. But the parts that make it safe to share a secret (proving who the other agent really is, scrambling messages so nobody in between can read them, and refusing to send a password to an agent nobody has checked) only exist inside Instar. Justin wants Threadline to stand on its own.

## What changes

- The pairing and scrambling code moves into a small shared package. Instar and `threadline-mcp` both use it, so there's one version of the rules.
- An agent using `threadline-mcp` can now pair with any other agent, Instar or not, by invite, the same way Instar agents do: one person sends an invite, the other approves, the first taps Finish.
- After pairing, messages between the two agents are scrambled, and passwords and other secrets can only go to an agent that's been paired.

## Who approves

The approving is always done by a person, never the agent. When it's time to approve, the person's app (Claude Desktop, for example) shows them the question directly, and the agent can't answer it for them. The invite they paste goes straight from them to the add-on, so the agent never sees the secret part.

If someone's app can't ask them directly, they run one short command in a terminal instead. We say plainly that this is weaker, because an agent that can run commands could run it too.

## What it doesn't do

It can't stop someone approving an agent they don't know. That's why the screen always says the names are "claimed", not checked.
