# GUS Companion — iOS + Apple Watch (v0.1 scaffold)

The operator's pocket surface for their own GUS, specced in the
Phase 9 direction (2026-11-05): native approvals, the Governor
mode, and the kill switch — on the phone, and the two urgent ones
on the wrist.

## What it does

- **Status** — version, live/stopped, Shield state, provider,
  approvals waiting, spend today/month, the **Governor mode**
  (Enforcing/Permissive, flippable from the phone), and the
  panel's "Settings on file" readout.
- **Approvals** — pending parked actions with Approve (exactly
  this) / Deny. Resolution goes through the panel API, which
  resolves through the same hash-bound approval engine as the
  Telegram buttons and the panel itself: this app can authorize
  exactly what GUS parked, never a widened or reworded variant.
- **Jobs** — recent jobs and their outcomes.
- **Settings** — panel address + operator token (token in the
  Keychain only), with visible save confirmation and a one-tap
  connection test.
- **Watch** — live/stopped + mode + waiting count, Stop/Resume,
  and approve/deny from the wrist.

## Build it

1. Open `GUSCompanion.xcodeproj` in Xcode (26 on the iMac).
2. Select both targets → Signing & Capabilities → pick the
   STARTEK team (the apps use automatic signing; bundle ids
   `com.startekenterprises.gus.companion` and
   `…companion.watchapp`).
3. Run on the iPhone; the Watch app embeds automatically.
4. In the app's Settings: panel address (your Mac — its Tailscale
   name is the reliable route, e.g. `http://imac.<tailnet>:8731`)
   and the operator token from `~/.gus/state/panel-token`.

## Transport & security notes

- The panel is operator-grade: it can approve actions and stop
  the agent. Reach it over Tailscale or an SSH tunnel — never
  expose it to the open internet. The token is a bearer
  credential; it lives in the Keychain on the phone and is sent
  as `Authorization: Bearer …`, the panel's documented API auth.
- The companion holds none of GUS's vault secrets. Losing the
  phone loses a token, which is rotated by replacing
  `panel-token` and restarting the control plane.

## Honest status

Source-complete scaffold, authored 2026-11-06. It has **not yet
been compiled** — there was no Mac toolchain available to the
build session that wrote it, and the repo's macOS CI runners are
currently unavailable. First open in Xcode may surface small
project-format or Swift nits; the API client is a faithful mirror
of `packages/panel` (types + routes), so the fixes should be
cosmetic. Report the first build's errors back and they'll be
fixed in the next version.

## Roadmap

- **Call GUS** — the voice channel (Phase 9 direction): talk to
  GUS, hear approvals read back, confirm by phrase; a spoken
  kill phrase. Transcript-boundary scanning per the design note.
- WatchConnectivity token sync from the phone (today the watch
  reads the shared Keychain when iCloud Keychain is on).
- Approval push notifications (needs an APNs path that respects
  the local-first posture — likely via the operator's own Mac).
