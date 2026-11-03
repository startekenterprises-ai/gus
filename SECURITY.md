# Security policy

GUS is a security product; we hold ourselves to the standard we sell.

## Reporting a vulnerability

Email the maintainers via the StarTek security contact published at
https://agent-shield.startekenterprises.com/security. Do not open a public
issue for an undisclosed vulnerability. We follow coordinated disclosure:
acknowledge, fix, then publish — the same process we used for our own
CVE-class disclosures in the MCP ecosystem.

What to expect from us:

- **Acknowledgement within 2 business days.**
- A fix or a mitigation plan within 30 days for high-severity issues
  in the control plane (Governor, Vault, Approval Engine, Updater,
  egress proxy, Shield gate); faster when exploitation is plausible.
- Credit in the release notes and the published write-up, unless you
  ask to stay anonymous.
- No legal threats for good-faith research that stays within this
  policy: test against your own install, don't touch other people's
  agents or data, and give us the fix window before publishing.

Especially in scope — the reports we most want:

- Any path by which the sandboxed agent (or content it ingests) can
  read a vault secret, spend past a cap, execute an unapproved
  action, widen an approval to different arguments, escape the
  sandbox, or write to control-plane state.
- Any update path that can install an unsigned or altered release,
  or that can lose append-only data (ledger, jobs, approvals,
  receipts, vault) during a rollback.
- Any log, receipt, or store that persists a secret value or unscreened
  content — receipts are content-hash-only by design; a receipt that
  carries content is a bug.
- Any way to make a job end without one of the three terminal states,
  or to make a blocked action look verified-done.

## Architectural commitments (the short version)

- The agent loop runs in an OS sandbox. The Governor (spend caps, ledger,
  kill switch), the Vault Broker, the Approval Engine, and the Updater run
  as separate control-plane processes the agent cannot reach.
- Credentials are usable by the runtime but never readable by the agent:
  there is no API that returns a secret to the sandbox.
- Agent-Shield (by StarTek) gates every tool call, skill install, and MCP
  connection. There is no setting that turns the gate off.
- Secrets detected at any channel boundary are refused — never forwarded,
  stored, or written to logs (secret-guard; see README).
- Channel caveat, stated plainly: Telegram bot chats are not end-to-end
  encrypted. Telegram carries approvals and metadata only; secrets never
  transit it by design.
- A receipt means "no known-bad patterns detected" for the scan it
  records — never a guarantee that content is safe. The full threat
  model, including what is explicitly out of scope, is in
  `docs/threat-model.md`.

## Supported versions

GUS is pre-1.0. Security fixes land on the current release line; the
Updater's signed `stable` channel is the supported way to receive
them. Self-hosters who pin a version are responsible for watching the
changelog — boring updates only work if you let them happen.
