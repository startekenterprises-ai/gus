# Pre-publication secret audit — 2026-11-02 (Phase 5)

**Verdict: SAFE to publish the git history as it stands. No real
credential exists in any commit or in the working tree.**

Method: every blob of every commit (5 commits, 186 unique blobs) and
every file in the working tree including ignored files (342 files)
was scanned for key-shaped material: AWS/GitHub/OpenAI/Anthropic/
Google/Slack/Stripe key formats, PEM private-key blocks, JWTs,
Bearer values, Telegram bot-token shape, generic `key = "…"`
assignments, URL-embedded passwords — plus the two product-specific
shapes that matter here: live-format Agent-Shield keys
(`as_live_` + 36 hex) and the Phase 1 drill canary format. Every hit
was classified by hand:

| Hit class | Where | Classification |
|---|---|---|
| `AKIAIOSFODNN7EXAMPLE` | detector pattern docs, "clean skill" fixture, secret-guard tests | **Fixture.** The AWS documentation example key — the scanner's allowlisted example value. |
| `AKIAGUSTEST123456789` | Phase 0 drill, secret-guard/Governor/approval tests, drill inbound files | **Fixture.** The published synthetic Phase 0 test key (see the secret-guard demo). |
| `AKIAZZ…` (contains "test"), `FAKEgustest…`, `gus-drill-gateway-key-0001`, `test-token-123`, panel test apiKey | unit tests, onboarding drill | **Fixtures.** Invented in-test strings; several are deliberately shaped to trip the detectors they test. |
| `ghp_…`, `sk-…` in `test/fixtures/skills/planted-*` | planted skill + planted MCP config | **Fixtures, by design.** Detector bait; the planted skill's own text says the key is planted on purpose. They must stay realistic — that is their job. |
| `FAKE_SHIELD_KEY = "as_live_…"` in `phase4-gate-panel.test.ts` | unit test | **Fixture.** 23-char non-hex body; a real Shield key body is 36 hex chars. The real-format pattern (`as_live_[0-9a-f]{36}`) matches **zero** times in history and tree. |
| Drill Telegram token in `phase4-onboarding-drill.sh` | drill script | **Fixture.** 10 digits + 31 chars (a real bot token's hash part is 35); no Telegram bot has ever been registered for this project, so no real token exists to leak. |
| Bare `-----BEGIN RSA PRIVATE KEY-----` header | secret-guard test | **Fixture.** Header string only, as a detector input. No key material (no body) exists anywhere in the repo. |
| 64-hex strings | `*.tsbuildinfo`, dist outputs | **Not secrets.** TypeScript build-info file hashes; ignored files, never committed. |

The one real credential this project has ever minted — the drill
Shield keys — was checked specifically: `record-shield.mjs` writes a
fresh free-tier key only to a 0600 key-out file and recordings file
in the drill's /var/tmp state (outside the repo), the drill deletes
the recordings before its hygiene sweep, and the key itself lives
only in the drill vault's ciphertext. No recordings or key-out
artifact exists under the repo. Receipt ids in drill evidence are
public-verifiable by design and are not credentials.

**What a public push would expose today:** the tracked tree and
history above — fixtures only. Two standing guards added with this
audit: `.gitignore` now hard-blocks key material by shape (`*.key`,
`*.pem`, `*recordings*.json`, `vault.json`, `.env*`, state dirs) in
every directory, and this audit should be re-run (it takes ~2
seconds) before the first push and after any drill that handles a
live key.
