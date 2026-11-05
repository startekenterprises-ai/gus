# GUS on a resident Mac (Phase 7)

Phase 7 puts GUS on a Mac it can drive: the control plane and the
runtime run natively as launchd agents, and a new capability pack —
the **Mac-control pack** (`packages/control-plane/src/mac.ts`) — lets
the control plane observe and operate the desktop itself, under the
same governance as everything else in GUS. The idea is the scope's:
**the box is the sandbox.** The resident Mac is a dedicated, sacrificial
agent machine, which is what makes broad standing approvals rational
there: the blast radius is the box, and the box holds nothing precious.

> Status: the pack, the classifier model, the policy template, and
> these host artifacts are in the repo and unit-tested. Two things
> land in the install sitting, with the operator present: the native
> host bridge behind `MacHostAdapter` (accessibility/input on the
> real Mac), and the Telegram bot token. Until the bridge lands, the
> control plane wires an adapter that refuses every `mac_*`
> execution plainly — nothing pretends a desktop exists.
>
> Phase 8 update (2026-11-05): the bridge now exists in the repo —
> the Swift `GusMacHost` helper, the GUS.app shell, DMG packaging,
> and the Node `NativeMacHostAdapter` the control plane wires when
> the helper is present. See **docs/mac-app.md**. The Swift side is
> Mac-only and compiles/verifies in the install sitting; what
> remains of this section's "sitting's build" is that sitting.

## What runs where

| Piece | Process | Holds |
|---|---|---|
| Control plane | launchd agent `com.startekenterprises.gus.control-plane` | vault, Governor ledger, policy, approvals — and the Mac pack |
| Runtime (agent) | launchd agent `com.startekenterprises.gus.runtime` | no secrets, no policy path; asks the control plane over the comm socket |
| Heavy inference | remote | API providers (Gemini/Meta) and OMEN for local models — unchanged |

The runtime→control-plane asymmetry is unchanged: the runtime cannot
create, resolve, or forge an approval. The cloud agent that proposes
work to this Mac is a *proposer*, not a peer — jobs arrive as jobs,
execute under policy, and end verified-done, failed-loudly, or parked
for the operator's phone.

## Layout (defaults; `GUS_HOME` overrides)

```
~/.gus/
  state/            GUS_STATE_DIR — vault, governor.json, jobs,
                    approvals.jsonl, policy.json, gate.jsonl,
                    panel-token (all 0600/0700 where it matters)
  state/logs/       control-plane.log, runtime.log (see rotation)
  comm/gus.sock     the CP<->runtime unix socket
  workspace/        the runtime's own workspace jail root
~/Library/LaunchAgents/com.startekenterprises.gus.{control-plane,runtime}.plist
```

## Install

```sh
sh hosts/mac-resident/install.sh
```

The script checks Node ≥ 22, builds the repo, creates the layout,
seeds the policy (below) **only if none exists**, renders and loads
both launchd agents, and prints the remaining steps. Uninstall is
`sh hosts/mac-resident/uninstall.sh` — it unloads the agents and
deliberately keeps state; erasing state is one printed `rm` away and
stays the operator's explicit act.

**Start-at-login:** LaunchAgents in `~/Library/LaunchAgents` load at
login by construction; both plists set `RunAtLoad` + `KeepAlive`, so
GUS is up when the operator is, and back after a crash (the control
plane's boot sweep settles anything a crash left unsettled —
failed-loudly, receipted, never hanging).

**Log rotation:** launchd doesn't rotate; the agents append to
`state/logs/*.log`. Render `hosts/mac-resident/newsyslog-gus.conf`
into `/etc/newsyslog.d/gus.conf` (one sudo step, by hand) for
5 × ~10 MB compressed rotation.

**Before residency:** verify Time Machine is ON for the Mac
(`tmutil status`). The box is sacrificial; its records shouldn't be.

## The policy on this host — Nova defaults

`install.sh` seeds `<state>/policy.json` from
`docs/mac-policy-template.json` (the same object the code ships as
`NOVA_MAC_POLICY_TEMPLATE`; the unit suite asserts they agree). Edit
**`mac.workDirs`** to the real project directories before first use —
the placeholder names a home that doesn't exist, so the seeded
template approves no file or shell access at all until edited.

The model, on the existing PolicyStore machinery:

- **Always (proceeds, receipted, post-condition verified):**
  `mac.observe`; `mac.open_app`, `mac.focus_window`; `mac.fs.read` /
  `mac.fs.write` inside `mac.workDirs`; `mac.shell.run` for the
  template's allowlisted build/test commands run inside a work dir.
- **Once (parks for a phone approval, hash-bound to the exact
  arguments):** all input injection (`mac.click`, `mac.type`,
  `mac.key`, `mac.scroll`, `mac.picker.select`); fs paths outside the
  work dirs; shell that is non-allowlisted, chained past the
  allowlist, or uses redirection/substitution; installs; external
  publishing (`git push`); network shells and fetches outside the
  egress proxy; credential-adjacent shell (the keychain CLI).
- **Never / hard rules (in code, not policy-overridable):**
  `vault_read` stays hard-denied. Deletes park always — `rm` in a
  shell command is classified destructive and the allowlist can never
  cover it (the Yue rule). Governor caps stay $2/task · $10/day ·
  $100/month by default; policy deny rules ("Never") beat every
  Always above, as everywhere in GUS.

Two jail facts worth knowing: an approval authorizes an *action*, it
never widens the jail — a `mac.fs.write` outside the work dirs fails
loudly at execution even if it was approved (the operator's remedy is
editing `mac.workDirs`, not approving harder). `mac.picker.select` is
the one deliberate exception to the fs jail: choosing a file is its
whole job, and every selection is a Once whose approval names the
exact path.

## Approvals

Approvals ride the channel, as always: the setup wizard (panel,
http://127.0.0.1:8731) stores the Telegram bot token in the vault —
create the bot with BotFather in the install sitting. Secrets never
transit Telegram; approvals and receipts are metadata only.

## The host bridge (the sitting's build)

`MacService` executes through the `MacHostAdapter` interface
(observe / probe / click / type / key / scroll / openApp / focusWindow /
readFile / writeFile / shellRun / pickerSelect). The repo ships:

- `FakeMacHostAdapter` — an in-memory desktop the unit suite and
  drills run against; the service code path is identical.
- `UnavailableMacHostAdapter` — refuses plainly; still what hosts
  without the helper get.
- `NativeMacHostAdapter` (Phase 8, `mac-native.ts`) — what
  `main.ts` wires when the helper is present (`GUS_MAC_HOST=1` or
  the helper socket exists): desktop calls delegate over a unix
  socket to the native helper; files and shell execute locally.

The bridge itself is a small native helper on the resident Mac
(Accessibility API for observe/click/focus, synthetic events for
input, the file dialog for picker) implementing the same interface —
including the canonical action receipts (`macActionReceipt`) the
service verifies against, and honest probe state (front app, focused
window/element, picker selection). Phase 8 ships it as the Swift
`GusMacHost` inside GUS.app — full detail in docs/mac-app.md.

## Acceptance drill

With the operator hands-off and a phone in hand:

1. From the channel, send a job that re-runs a real desktop errand
   end-to-end (the reference errand: pick a file with the picker,
   open its app, make a small edit in a work dir, run the project's
   tests).
2. Always-class steps proceed with receipts; the picker selection
   and any shell outside the allowlist park and resolve from the
   phone.
3. Every executed action's job record shows its post-condition
   verified; a deliberately broken step (quit the app mid-job) ends
   failed-loudly, not silently.
4. Kill switch from the phone stops the resident agent mid-job.
