# GUS

**A secure open-source AI agent.** Secure by architecture, boring by
process, capped by default.

GUS is built backwards from how the current generation of open-source
agents actually fails: updates that break the install, runaway token
bills with no ceiling, credentials sitting inside the model's context,
safety instructions silently dropped when the conversation is
compacted, and jobs that report success while delivering nothing.

So GUS is split in two. The **agent loop** runs inside a sandboxed
container with no network and no secrets. Everything that keeps it
honest — the spend Governor, the credential Vault, the Approval
Engine, the Updater — runs in a **separate control plane the agent
cannot reach**. Nothing the model says, remembers, or forgets can
change how those components behave. That one decision is the product.

## The seven promises

Each promise is a mechanism, not a setting — and each one is proved by
a named, runnable test in `test/promise/` (the Promise Suite). If a
change ever requires loosening one of these tests, the release does
not ship.

1. **Boring updates.** Updates are signed, staged into an idle slot,
   and replayed against your own recorded automations *before* they go
   live; anything that fails is rolled back automatically — a bad
   update never replaces your working version. *Proved by the
   bad-update drill (Phase 3).*
2. **A hard spend ceiling, enforced outside the model.** Per-task,
   per-day, and per-month caps in dollars, a live append-only ledger,
   and a kill switch the model cannot argue with. When the cap is hit,
   the tool layer refuses — it doesn't ask the model to stop. *Proved
   by the runaway-cap drill (Phase 2).*
3. **Credentials the agent can use but never read.** Secrets live
   encrypted in the Vault Broker, outside the sandbox. There is no API
   that returns a secret. When a call needs one, the egress proxy
   injects it in flight, at the edge, for that one request. *Proved by
   the credential red-team drill (Phase 1).*
4. **Approval as a system property.** Destructive, bulk, and external
   actions are classified at the tool layer and parked for your
   approval — bound to the exact arguments, single-use, timeout means
   no. The requirement lives in the control plane, so context
   compaction cannot erase it. *Proved by the Yue drill (Phase 2)* —
   named for the February 2026 incident where an agent whose "confirm
   before acting" instruction was compacted away bulk-deleted 200+
   emails while ignoring stop commands.
5. **No silent failure.** Every job ends in exactly one of three
   states — **verified-done** (a control-plane post-condition check
   passed, not the agent's self-report), **failed-loudly** (you're
   told, in plain language), or **needs-approval** — and every ending
   issues a signed receipt. Even a crash is covered: jobs orphaned by
   a dead control plane are settled failed-loudly by the boot sweep on
   the next start. *Proved by every drill, plus the boot-sweep drill
   (Phase 5).*
6. **Five-minute onboarding, no terminal after install.** A
   five-step wizard in the web panel: connect the Shield, add your
   channel, pick a model provider, accept (or change) the starter
   caps, run your first job. Measured in the onboarding drill at
   **5 user actions**. *Proved by the onboarding drill (Phase 4).*
7. **Agent-Shield on every path.** Every inbound message, every tool
   call, and every tool result passes the Agent-Shield scan gate, and
   the signed receipt lands on the job. Skill installs and MCP configs
   pass the local scanner first — a *do not install* verdict has **no
   override**. Plus **secret-guard**: paste a password or API key into
   the chat and GUS flags it, refuses to forward, store, or ingest it,
   and tells you to rotate it. *Proved by the Shield-gate drill
   (Phase 4) and the Phase 0 drill.*

**Safety is never the upsell.** All seven promises ship in this
open-source core, forever. The hosted tier sells operation and
assurance — we run the updates, backups, monitoring, and support — not
safety features. A self-hoster gives up nothing functional: only their
time, uptime, and support.

## Quickstart

You need Docker. (Node ≥ 22 is only needed to build from source and
run the test suite, which the Docker build does for you.)

```sh
git clone <this repo> gus && cd gus
npm install && npm run build && npm run pack
docker compose -f packages/sandbox/docker-compose.yml up --build -d
```

That one compose command starts both halves: the control plane and
the sandboxed agent. Then open the operator panel at
**http://127.0.0.1:8731** (loopback only). The first boot writes an
operator token to the state volume — the control-plane log names the
file (`panel-token`); read it with
`docker compose -f packages/sandbox/docker-compose.yml exec control-plane cat /state/panel-token`
and paste it into the panel. The five-step wizard takes it from
there: no config files to edit, and every secret you enter goes
straight into the encrypted vault — never into the chat (see
*Limitations* on why).

Plain-English walkthrough: [docs/install.md](docs/install.md).

## Honest limitations

We publish what GUS does *not* do, in the same place as what it does:

- **Skills are installed, not executed.** In v1, third-party skills
  are scanner-gated and stored, but GUS does not yet run third-party
  skill code. The four built-in job types (daily digest, fetch &
  summarize, workspace files, reminders/heartbeat) are the working
  surface.
- **A receipt means "no known-bad patterns detected."** A signed
  receipt proves a scan happened, what it covered, and what it found
  — it is not a guarantee that content is safe. Agent-Shield's own
  published benchmarks are candid about detection limits; GUS markets
  the gate as *architecture* — every call is checked and receipted —
  never as "the scanner catches everything."
- **The drill evidence has two vehicle caveats, until it doesn't.**
  The gate drills were authored in a VM whose containers have no
  network egress, so (a) container drills ran the same OCI images
  through podman+crun instead of a Docker daemon, and (b) the Phase 4
  Shield drill replays responses captured from the *live* Agent-Shield
  API for the drill's exact payloads (the receipts earned are real
  and were verified against the live verify endpoint). A re-run on a
  stock Docker host retires both caveats and is on the launch
  checklist. The substitutions are documented per-phase in
  [docs/LOCAL-DRILL.md](docs/LOCAL-DRILL.md).
- **Telegram is not end-to-end encrypted.** Telegram bot chats are
  cloud chats. GUS therefore sends Telegram approvals and metadata
  only — secrets never transit it — and the same rule is why secrets
  are entered in the panel, not in chat. GUS's secret-guard also has
  an honest edge: if you paste a secret into a group chat, GUS stops
  *itself* from ingesting or propagating it and tells you to rotate
  it — it cannot unsend what other people already saw. No software
  can.
- **Working name.** "GUS" is a working name pending formal trademark
  clearance; see `TRADEMARK.md`.

## Privacy

GUS sends nothing home by default. There is an **opt-in, anonymous
install heartbeat** (off unless you set `GUS_HEARTBEAT=1` and a
counter URL): it sends exactly `{ version, mode: "self-host" }` — no
install id, no usage data, no content — so the project's adoption
kill-criterion (spec §5) can be measured without measuring *you*. You
can also point it at your own counter, or leave it off forever;
nothing else changes.

## Layout

```
packages/
  shared/            types, comm protocol, job model, S1 secret patterns, secret-guard
  gate/              receipts, the Agent-Shield client/gate, the skill scanner
  control-plane/     Governor · Job Runner · Approval Engine · Updater · onboarding — OUTSIDE the sandbox
  runtime/           the agent loop — INSIDE the sandbox, owns no secrets
  channels/telegram/ first channel adapter (Bot API + offline fake-file transport)
  vault/             Vault Broker — encrypted secrets, no read API
  egress/            egress proxy — allowlist, DNS pinning, injection at the edge, screening
  panel/             operator web panel: status, ledger, jobs, approvals, vault, skills, onboarding
  sandbox/           Dockerfiles + compose (control plane + agent sandbox, A/B slot launcher)
test/
  unit/              unit suite (90 tests)
  promise/           the gate drills — the Promise Suite
  fixtures/          planted malicious skills, drill worlds, recorded Shield responses tooling
skills/              first-party skill shelf (scanner-gated installs)
docs/                install guide, threat model, local-drill notes, launch drafts
```

Channels are thin adapters over one interface; Telegram is the first
and remains the approval/kill-switch surface even as more land (a
Teams adapter is planned second), so the safety path never depends on
a corporate tenant's availability.

## Run the Promise Suite

```sh
npm install && npm test                       # 90 unit tests
npm run build && npm run pack                 # assemble dist-bundle/ for the images
docker build -f packages/sandbox/Dockerfile.control -t gus-control:dev .
docker build -f packages/sandbox/Dockerfile.agent   -t gus-agent:dev .
bash test/promise/phase0-drill.sh             # sandbox + secret-guard gate
bash test/promise/phase1-drill.sh             # credential red-team
bash test/promise/phase2-drill.sh             # Yue drill + runaway-cap drill
bash test/promise/phase3-drill.sh             # bad-update drill
bash test/promise/phase4-drill.sh             # Shield-gate drill
bash test/promise/phase4-onboarding-drill.sh  # onboarding drill
bash test/promise/boot-sweep-drill.sh         # crash-recovery (boot sweep) drill
npm run check:budget                          # ≤ 1 GB steady-state budget, static + measured
```

On a host without a working Docker daemon the container drills can
drive the same OCI images through podman (`PODMAN=podman bash
test/promise/phase0-drill.sh`); see `docs/LOCAL-DRILL.md`.

## Status

The v1 foundation is **built and gate-drilled end to end**: skeleton
and sandbox (Phase 0), vault and egress (Phase 1), Governor and
approvals (Phase 2), boring updates (Phase 3), the Shield gate,
provider classes, panel and onboarding (Phase 4), and launch prep —
docs, CI, boot sweep, DNS pinning (Phase 5). What remains before a
public launch is a short checklist of decisions and verifications
that belong to the maintainer, not more foundation code. Per-phase
build detail and drill evidence live in `docs/LOCAL-DRILL.md` and the
`drill/` evidence logs.

## License

Apache-2.0 — see `LICENSE` and `NOTICE`. "GUS" and the product
identity are covered by `TRADEMARK.md`: forks are welcome, but must
ship under their own name. Security issues: see `SECURITY.md`.
Contributing: see `CONTRIBUTING.md`.
