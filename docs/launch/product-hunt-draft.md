# ⚠️ DRAFT — DO NOT POST ⚠️

> Product Hunt launch copy, prepared in advance. Posting is Glenn's
> call, on Glenn's timing. Nothing here has been submitted anywhere.

**Name:** GUS (working name — pending trademark clearance)

**Tagline:** The AI agent that can't spend past your cap, read your
keys, or forget to ask

**Topics:** Open Source · Artificial Intelligence · Security ·
Developer Tools

**Description:**

GUS is an open-source AI agent built backwards from how today's
agents fail: updates that break the install, runaway token bills,
credentials in the model's context, safety instructions lost to
context compaction, jobs that "succeed" silently.

The fix is architectural. The agent loop runs in a sandbox with no
network and no secrets. The Governor (hard dollar caps + ledger +
kill switch), the Vault (credentials with no read API — the agent
can use a key, never see it), the Approval Engine (destructive
actions park for your tap, bound to the exact arguments), and the
Updater (every release is rehearsed against your automations and
rolls back if anything fails) all run outside the sandbox, where the
model can't reach them.

Every job ends verified-done, failed-loudly, or needs-approval —
with a signed receipt. Every message and tool call passes the
Agent-Shield scan gate. Paste a password into the chat and GUS
refuses it and tells you to rotate it.

All seven safety promises are in the Apache-2.0 core, each proved by
a public, runnable test (the Promise Suite). The hosted tier sells
operation, never safety.

**First comment (maker):**

Hi PH — I'm Glenn, I run StarTek. We got here by auditing everyone
else first: we scanned 37,683 skills and MCP servers from the public
registries and published what survived hand-validation
(agent-shield.startekenterprises.com/corpus-audit). GUS is the agent
we built from those findings. The tests I'm proudest of have names:
the Yue drill (an agent that "forgot" to ask first can't act — the
rule isn't in its context), the runaway-cap drill (stops at $0.484
of a $0.50 cap), and the credential red-team (six extraction
attempts, zero leaks). Happy to answer anything — including the
limitations section of the README, which we wrote as carefully as
the features.

**Media checklist:** secret-guard demo clip (script:
docs/launch/secret-guard-demo.md) · panel screenshot (ledger +
approvals) · corpus-audit headline graphic · Promise Suite drill
terminal capture.
