# Launch post — DRAFT (do not publish; launch timing is Glenn's call)

> Working draft for the GUS announcement (blog + social). Built on
> the two launch hooks from the foundation spec (A4): the corpus
> audit headline and the secret-guard demo. All numbers below are
> from published or drill-verifiable sources — check before posting.

---

**We scanned 37,683 agent skills and MCP servers. Then we built the
agent that acts like it.**

When we published our audit of the agent ecosystem — every skill in
ClawHub's top 300 and a full walk of the Official MCP Registry — the
findings that survived hand-validation were not exotic. Three
published servers accept connections on all interfaces with no
authentication. Three install themselves with `curl | sh`. Twelve
publish their author's home LAN address to the world. And an entire
category of tools asks for your API keys in plaintext, in the chat,
by design.

The incumbents' support forums tell the same story from the other
side: updates that break a working install, token bills with no
ceiling, credentials the agent can read, instructions the agent
forgets. So we built the agent those complaints describe by
negation.

**GUS** is an open-source agent with a split personality, on purpose.
The part that talks to models lives in a sandbox with no network and
no secrets. The parts that keep it honest — a spend Governor with
hard dollar caps, a credential Vault with *no read API*, an Approval
Engine the model can't talk its way past, an Updater that rehearses
every release against your own automations before it goes live — live
outside, where the model can't reach them.

Seven promises, each one a mechanism and a public test:

1. Boring updates — a bad release rolls itself back. (In our drill,
   the subtly broken one is caught by a hash check, not by hope.)
2. A hard spend ceiling — in the runaway drill, the loop stops at
   $0.484 of a $0.50 cap. Not "the model was asked to stop." Stopped.
3. Credentials the agent can use but never read.
4. Approval as a system property — compaction can't forget it,
   because it was never in the context. We named the test the Yue
   drill, after the agent that deleted 200+ emails when its "ask
   first" instruction was compacted away.
5. No silent failure — every job ends verified-done, failed-loudly,
   or needs-approval, with a signed receipt. Even a crash leaves a
   receipt, not a mystery.
6. Five-minute onboarding — five actions in our drill, no terminal
   after install.
7. Every message, tool call, and tool result passes Agent-Shield —
   and if you paste a password into the chat, GUS refuses it and
   tells you to rotate it. [demo: docs/launch/secret-guard-demo.md —
   run it yourself in two minutes]

Safety is never the upsell: all of it is in the open-source core
(Apache-2.0). The hosted tier, when it opens, sells someone running
it for you — never a safer version of it.

What GUS doesn't do, yet: it installs third-party skills behind the
scanner but doesn't execute their code in v1; a receipt means "no
known-bad patterns detected," not "proven safe"; and the name is a
working name until trademark clearance lands. We publish the
limitations in the README, next to the promises — next to the tests
that prove the promises.

Repo: [link] · The audit: https://agent-shield.startekenterprises.com/corpus-audit
· Threat model: docs/threat-model.md

---

*Posting notes (internal): lead social variants — (a) the corpus
number + "so we built the agent that acts like it"; (b) the
secret-guard demo clip (script in secret-guard-demo.md) with the
caption "Your agent should refuse your passwords." Do not post the
Show HN variant (standing rule: no HN until after the first paying
Agent-Shield customer). Verify every number against the live corpus
page and a fresh drill run on the day of posting.*
