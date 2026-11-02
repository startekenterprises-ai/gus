# Security policy

GUS is a security product; we hold ourselves to the standard we sell.

## Reporting a vulnerability

Email the maintainers via the StarTek security contact published at
https://agent-shield.startekenterprises.com/security. Do not open a public
issue for an undisclosed vulnerability. We follow coordinated disclosure:
acknowledge, fix, then publish — the same process we used for our own
CVE-class disclosures in the MCP ecosystem.

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
