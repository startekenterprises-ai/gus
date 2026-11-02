# GUS

**A secure open-source AI agent.** Secure by architecture, boring by
process, capped by default.

GUS is built backwards from how the current generation of open-source
agents actually fails — updates that break the install, runaway token
bills with no ceiling, credentials sitting in the model's context, safety
instructions silently dropped by context compaction, and jobs that report
success while delivering nothing. GUS's seven v1 promises attack exactly
those failure modes:

1. **Boring updates** — staged, auto-rollback, post-update verification.
2. **A hard spend ceiling, enforced outside the model** — per-task /
   per-day / per-month caps, a live ledger, and a kill switch the model
   cannot argue with.
3. **OS-level isolation by default** — the agent loop runs in a
   sandboxed container with no network and no host access; credentials
   never enter the agent's context.
4. **Approval as a system property** — enforced at the tool layer,
   outside the model's context, so compaction cannot erase it.
5. **No silent failure** — every job ends *verified-done*,
   *failed-loudly*, or parked *needs-approval*, with a signed receipt.
6. **Five-minute onboarding, no terminal required.**
7. **Agent-Shield on every path** — every tool call, skill install, and
   MCP connection passes the Agent-Shield gate; nothing bypasses it.
   Plus **secret-guard**: paste a password or API key into the chat and
   GUS flags it, refuses to forward, store, or ingest it, and tells you
   to rotate it. (It cannot unsend what other people in the chat already
   saw — no software can. It stops *itself* from propagating the secret.)

Safety is never the upsell: all seven promises ship in this open-source
core, forever. The hosted tier sells operation and assurance — updates,
backups, monitoring, support — never safety features. A self-hoster
gives up nothing functional, only their time, uptime, and support.

## Status

**Phase 0 (foundation) is built**: monorepo skeleton, sandboxed agent
loop, separate control plane (Governor + Job Runner), channel adapter
interface with a Telegram adapter (incl. an offline fake transport),
secret-guard wired at channel ingress/egress, and the Phase 0 gate
drill proving sandboxing, control-plane separation, kill switch, and
secret refusal. Model providers, the vault/egress broker, real
Agent-Shield receipts, approvals resolution, and updates land in
Phases 1–4 per the foundation spec.

## Layout

```
packages/
  shared/          types, comm protocol, job model, S1 patterns, secret-guard
  gate/            receipts (Phase 0: local signing stub; Phase 4: Agent-Shield)
  control-plane/   Governor, Job Runner, comm server, channel host — OUTSIDE the sandbox
  runtime/         the agent loop — runs INSIDE the sandbox, owns no secrets
  channels/telegram/  first channel adapter (Bot API + offline fake-file transport)
  vault/ egress/   Phase 1 (see READMEs)
  panel/           Phase 4 (see README)
  sandbox/         Dockerfiles + compose (control plane + agent sandbox)
test/
  unit/            secret-guard + Governor/Job Runner tests
  promise/         gate drills + resource-budget check (the Promise Suite)
skills/            skill format placeholder (scanner-gated installs, Phase 4)
```

## Run the Phase 0 drill

```sh
npm install && npm run build && npm test     # 13 unit tests
npm run pack                                  # assemble dist-bundle/
docker build -f packages/sandbox/Dockerfile.control -t gus-control:dev .
docker build -f packages/sandbox/Dockerfile.agent   -t gus-agent:dev .
bash test/promise/phase0-drill.sh             # the Phase 0 gate
npm run check:budget                          # ≤1 GB RAM budget, static + measured
```

On a host without a working Docker daemon the drill can drive the same
OCI images through podman (`PODMAN=podman bash test/promise/phase0-drill.sh`);
see `docs/LOCAL-DRILL.md` for the substitution notes from the Phase 0
dev environment.

## Channels

Channels are thin adapters over one interface (`packages/shared`:
`ChannelAdapter`). Telegram is the first adapter and remains the
approval/kill-switch surface even as more channels land — the safety
path never depends on someone else's platform. Note: **Telegram bot
chats are not end-to-end encrypted** — Telegram carries approvals and
metadata only; secrets never transit it.

## License

Apache-2.0 — see `LICENSE` and `NOTICE`. "GUS" and the product identity
are covered by `TRADEMARK.md`: forks are welcome, but must ship under
their own name. Security issues: see `SECURITY.md`.
