# ⚠️ DRAFT — DO NOT POST ⚠️

> **Standing rule (Glenn): no Hacker News post until after the first
> paying Agent-Shield customer.** This draft exists so the copy is
> ready when that day comes. Posting is Glenn's call. Nothing here
> has been submitted anywhere.

**Title:** Show HN: GUS – an agent whose safety rules live outside the model

**URL:** [repo link]

**Text:**

Most agent safety is prompt-deep: "ask before deleting," "don't
exfiltrate secrets" — instructions that live in the same context
window that compaction trims and injected content competes with.
February's canonical example: an agent bulk-deleted 200+ emails
after "confirm before acting" was compacted away, then ignored stop
commands.

GUS (Apache-2.0) moves the rules out of the model's reach. The agent
loop runs in a container with `network_mode: none`, a read-only
rootfs, and no credentials. A separate control plane holds:

- a Governor: per-task/day/month dollar caps enforced by reservation
  against an append-only ledger, plus a persisted kill switch;
- a Vault Broker: secrets encrypted at rest, *no read API* — the
  egress proxy injects a credential in flight, bound to one
  destination/header, and scrubs it from responses;
- an Approval Engine: tool calls are classified from arguments;
  approvals are durable state, sha256-bound to the exact arguments,
  single-use, timeout = deny;
- an Updater: signed (Ed25519) A/B-slot releases, canaried against
  the operator's recorded automations before promotion, automatic
  rollback; data stores are append-only and never rolled back.

Every job settles verified-done (control-plane post-condition check,
not self-report), failed-loudly, or needs-approval, each with a
signed receipt. Every message/tool call/tool result crosses an
Agent-Shield scan gate; skill installs pass a local scanner with a
no-override "do not install" verdict. Jobs orphaned by a crash are
settled failed-loudly by a boot sweep.

Each promise has a public drill in test/promise/ (the "Promise
Suite"): credential red-team, Yue drill, runaway-cap drill,
bad-update drill, Shield-gate and onboarding drills, boot-sweep
drill. In the runaway drill a looping job is refused at $0.484 of a
$0.50 cap, ledger reconciled to the unit.

Honest limits, since HN will ask: skill code is installed/scanned
but not executed in v1; a receipt means "no known-bad patterns
detected" (the scanner's benchmarks, including its weak spots, are
published); the authoring VM had no container egress, so Phase 4's
Shield drill replays live-API responses captured for the exact
payloads (receipts verified live from the host) and container drills
ran via podman — a stock-Docker re-run is on the launch checklist;
"GUS" is a working name pending trademark clearance.

Context: we scanned 37,683 registry artifacts first
(agent-shield.startekenterprises.com/corpus-audit) — GUS is the
agent those findings argued for.
