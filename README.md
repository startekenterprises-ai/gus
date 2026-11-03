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
secret refusal.

**Phase 1 (vault & egress) is built**: the Vault Broker (encrypted at
rest, no read API — secrets are referenced by name and used only via
injection) and the egress proxy (allowlist, outbound screening, auth
injection at the edge, response scrubbing, per-call receipts), with a
sandbox `fetch` tool executed by the control plane through the proxy.
The Phase 1 gate is the credential red-team drill: a canary secret
survives direct vault asks, non-allowlisted fetches, echo/redirect/body
smuggling, state scraping, and prompt-injected instructions in fetched
content — appearing nowhere outside the vault's ciphertext and the one
intended in-flight request.

**Phase 2 (Governor & approvals) is built**: the Governor complete —
per-task/per-day/per-month USD caps over a versioned price table
(operator-owned config the sandbox cannot write), enforced by
reservation against an append-only ledger that reconciles exactly
(reserves = settles + refunds) — and the Approval Engine: every tool
call classified in the control plane from tool + arguments, approvals
parked as durable control-plane state, bound to the hash of the exact
arguments, single-use, timeout = deny, resolvable only from the
channel (buttons or /approve /deny commands). The Phase 2 gate is two
drills: the **Yue drill** (a bulk delete parks with no confirm
instruction anywhere in context; STOP freezes a running loop; replay,
forgery, bare-text "approve", and timeout all execute nothing) and the
**runaway-cap drill** (a looping job is cut at the cap exactly, ledger
reconciled, next job unaffected).

**Phase 3 (boring updates) is built**: the Updater lives in the
control plane (the sandbox never updates itself). A release is a
versioned bundle with an Ed25519-signed manifest (local release key
for now, honestly labeled like the receipt stub); the flow is verify
signature + every file hash → snapshot operator config → stage into
the idle A/B slot → **canary replay**: the candidate runtime boots
alongside the live one and replays the recorded scenarios (chat
round-trip, workspace write+verify, allowlisted fetch, approval park)
→ only on a full pass does the version pointer flip, and the new
control plane must still confirm itself live before the update
settles. Updates never start while a job is running or an approval
is parked; they wait. The data rule is stated in one line: **code and
config roll back; data never does** — the append-only stores
(ledger, jobs, approvals, receipts, vault) are never copied or
restored by an update, only prefix-checked for integrity. Both
containers boot through a small non-versioned slot launcher whose
watchdog flips the pointer back if a promoted control plane dies
before confirming. The Phase 3 gate is the **bad-update drill**: a
real v0.3 → v0.4 update lands mid-job without interrupting it; a
tampered bundle is rejected before staging; a crashy release and a
subtly broken one (its write path returns wrong content, caught by
the digest post-condition) are rolled back before going live; a
crashy control plane is rolled back by the watchdog after promotion;
and store/vault/config integrity is verified byte-for-byte across
the whole drill. Model providers and real Agent-Shield receipts land
in Phase 4 per the foundation spec.

## Layout

```
packages/
  shared/          types, comm protocol, job model, S1 patterns, secret-guard
  gate/            receipts (Phase 0: local signing stub; Phase 4: Agent-Shield)
  control-plane/   Governor, Job Runner, comm server, channel host — OUTSIDE the sandbox
  runtime/         the agent loop — runs INSIDE the sandbox, owns no secrets
  channels/telegram/  first channel adapter (Bot API + offline fake-file transport)
  vault/           Vault Broker — encrypted secrets, no read API (Phase 1)
  egress/          egress proxy — allowlist, injection, screening (Phase 1)
  panel/           Phase 4 (see README)
  sandbox/         Dockerfiles + compose (control plane + agent sandbox)
test/
  unit/            secret-guard, Governor/Job Runner, vault + egress tests
  promise/         gate drills + resource-budget check (the Promise Suite)
skills/            skill format placeholder (scanner-gated installs, Phase 4)
```

## Run the drills

```sh
npm install && npm run build && npm test     # 61 unit tests
npm run pack                                  # assemble dist-bundle/
docker build -f packages/sandbox/Dockerfile.control -t gus-control:dev .
docker build -f packages/sandbox/Dockerfile.agent   -t gus-agent:dev .
bash test/promise/phase0-drill.sh             # the Phase 0 gate
bash test/promise/phase1-drill.sh             # the Phase 1 credential red-team
bash test/promise/phase2-drill.sh             # the Phase 2 Yue + runaway-cap drills
bash test/promise/phase3-drill.sh             # the Phase 3 bad-update drill
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
