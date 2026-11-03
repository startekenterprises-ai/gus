# Contributing to GUS

Thanks for looking. GUS is a small, deliberately boring codebase with
one non-negotiable rule, stated up front because it decides most
review conversations:

## The Promise Suite rule

`test/promise/` is the Promise Suite — one named drill per product
promise (sandbox escape checks, the credential red-team, the Yue
drill, the runaway-cap drill, the bad-update drill, the Shield-gate
and onboarding drills, the boot-sweep drill). CI runs it on every
release candidate.

**A change that requires skipping, loosening, or mocking a Promise
Suite test cannot ship.** If you believe a promise test is wrong, the
PR that changes the *test* is a separate, labeled event — it changes
the product's public commitments, and it is reviewed that way, by a
maintainer, never bundled with the feature that happens to fail it.

Everything else is ordinary open-source work:

## Getting set up

```sh
npm install
npm test                    # build + 90 unit tests
npm run build && npm run pack
docker build -f packages/sandbox/Dockerfile.control -t gus-control:dev .
docker build -f packages/sandbox/Dockerfile.agent   -t gus-agent:dev .
bash test/promise/phase0-drill.sh   # and the rest — see README
```

Node ≥ 22, TypeScript throughout (one language, one runtime — that's
a design rule, not a preference). The repo is an npm-workspaces
monorepo: `packages/shared` (types + comm protocol), `gate`,
`vault`, `egress`, `control-plane`, `runtime`,
`channels/telegram`, `panel`, `sandbox`.

## Where things belong

- **Safety logic never goes in `packages/runtime`.** The runtime is
  the untrusted side of the wall. Governor, vault, approvals,
  updater, gate — all control plane.
- **No new way to return a secret.** There is no vault read API on
  purpose; a PR that adds one will be declined on sight. Secrets move
  by injection at the egress proxy or not at all.
- **Receipts stay content-free.** Hashes and ids only. If a log line
  wants the content, it gets the redaction.
- **Honest labels.** Stubs say they're stubs (the local receipt
  issuer is stamped `gus-local-stub`; recorded-replay drill modes say
  so in their evidence). Public claims must be provable from the
  drills; if a number can't be re-run, it doesn't go in the README.

## Tests

- Unit tests for logic (`test/unit/`, run by `npm test`).
- A promise-level change needs a drill: either extend the phase drill
  that proves the promise, or add a check to the relevant one.
- Resource budget is a test too: `npm run check:budget` (≤ 1 GB
  steady-state for the full stack) must stay green.

## Pull requests

- One topic per PR; keep the diff reviewable.
- Say which promise (if any) your change touches, and what you ran.
- New dependencies need a reason in the PR description — the supply
  chain is part of the threat model.
- By contributing you agree your work is licensed under Apache-2.0
  (see `LICENSE`/`NOTICE`). The name "GUS" is not part of the grant —
  see `TRADEMARK.md`; forks must rebrand.

## Security issues

Don't file them as issues. See `SECURITY.md` for the disclosure
process — reports about the safety mechanisms themselves are the
most valuable contributions this project can receive.
