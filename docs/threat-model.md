# Threat model (summary)

What GUS defends against, what it doesn't, and where the boundary
sits. The full reasoning lives in the foundation spec and the drill
evidence; this page is the short, public version. If a claim here ever
disagrees with the code or the drills, the code and drills win — tell
us.

## The core assumption

**The model is not trusted.** Not because models are malicious, but
because everything a model reads is untrusted input: a fetched page,
a file, an MCP server response, or a pasted chat message can carry
instructions written by someone else (prompt injection), and the
model's own memory of the rules can be silently trimmed by context
compaction. So in GUS, no safety property is allowed to depend on the
model behaving. Each one is enforced by a component the model cannot
reach.

## Assets

- Credentials (API keys, OAuth tokens) — held by the Vault Broker.
- Money (model spend) — metered by the Governor.
- The operator's data and machines (workspace files, accounts the
  agent acts on).
- The integrity of the record itself (ledger, receipts, approvals) —
  a security product whose logs lie is worse than none.

## Adversaries and what stops them

| Threat | Mechanism | Evidence |
|---|---|---|
| Prompt injection in fetched content / tool results tries to exfiltrate a credential | Egress allowlist + injection bindings: the credential can only ever travel, injected by the proxy, to its one bound destination; fetched content is Shield-scanned and vault-scrubbed before it reaches the model | Phase 1 credential red-team, attack (f); Phase 4 drill G3 |
| The agent asks for a secret directly, or scrapes state for one | There is no vault read API; the state volume is not mounted in the sandbox; the sandbox rootfs is read-only with all capabilities dropped | Phase 1 drill (a), (e); Phase 0 escape checks |
| A pasted secret in chat gets forwarded, stored, or logged | Secret-guard screens channel ingress and egress; a hit is refused, redacted in every store, and the user is warned to rotate | Phase 0 drill check 6 |
| The agent forgets "ask first" (compaction, long context) and acts destructively | Classification and approval live in the control plane's policy store, not in the model's context; approvals are hash-bound to exact arguments and single-use | Phase 2 Yue drill (i), (iii) |
| A runaway loop burns the operator's budget | Governor caps (per-task/day/month) enforced by reservation *before* each call; the refusal is mechanical, not a request to the model | Phase 2 runaway-cap drill |
| The operator says stop and the agent keeps going | Kill switch is a persisted control-plane flag; every authorization checks it; in-flight spend freezes at the last settled call | Phase 2 Yue drill (ii) |
| A malicious or compromised skill / MCP server | Install-time scanner gate (secrets, SSRF surfaces, injection directives, dependency risks); a *do not install* verdict has no override; runtime tool calls and results still cross the Shield gate | Phase 4 drill G4 |
| A bad or tampered update replaces a working agent | Signed manifests (Ed25519) verified before staging; A/B slots; canary replay of the operator's own automations before promotion; automatic rollback; append-only data stores are never rolled back | Phase 3 bad-update drill (a), (b), (c) |
| DNS rebinding: an allowlisted name resolves to an internal address at connect time | Resolve once per hop, pin the socket to a resolved address, verify the socket's actual peer against the resolved set; mismatch discards the response unscreened | egress DNS-pinning unit tests (Phase 5) |
| The control plane crashes mid-job and work is silently lost or double-run | Durable job store; the boot sweep settles orphaned queued/running jobs failed-loudly with receipts; Governor orphan reservations are refunded at boot so caps never wedge | Boot-sweep drill (Phase 5); Governor unit tests |
| The Shield is down when a scan is required | Operator's recorded policy decides, stated at onboarding: fail-closed (default for tool calls) blocks the surface and mints no fake receipt; fail-open proceeds *flagged*, never pretending a scan happened | Phase 4 drill G5 |

## Out of scope — stated plainly

- **Detection is not perfect.** The Shield gate guarantees a check
  happened and left a receipt; it does not guarantee every malicious
  input is caught. Agent-Shield publishes its own benchmark limits;
  read a receipt as "no known-bad patterns detected," never as
  "proven safe." The architectural promises (caps, vault, approvals,
  updates) do not depend on the scanner being perfect — they depend on
  it being *present, enforced, and receipted*.
- **A compromised host is a compromised install.** If the operator's
  machine or Docker daemon is owned, the control plane's files —
  including the vault's encrypted store and its host key — are within
  reach. GUS's boundary is between the *agent* and the *operator's
  control system*, not against the operator's own adversary with host
  root. (Standard self-host hygiene applies: disk encryption, a
  dedicated box or VM.)
- **The operator is trusted.** Approvals, caps, and policy are the
  operator's to set. GUS makes the consequences mechanical; it does
  not second-guess the person who owns it. Social-engineering the
  operator into pressing Approve is out of scope for any approval
  system, including this one.
- **Channel platforms.** Telegram carries approvals and metadata
  only, because bot chats are not end-to-end encrypted — but a
  compromised Telegram account is a compromised approval surface.
  Protect it accordingly (Telegram 2FA). The kill switch also exists
  locally (panel, file flag) independent of Telegram.
- **v1 skill execution.** Third-party skill code is not executed in
  v1 (installed and scanned only), so skill-code sandboxing beyond
  the install gate is not yet a claim. When execution lands, it lands
  inside the same sandbox, behind the same gate — or it doesn't land.
