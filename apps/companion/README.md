# GUS Companion — iOS + Apple Watch (v0.1 scaffold)

> **SUPERSEDED in v0.15.0 (the "front door", redo R4).** The
> unified GUS iPhone app now lives in **`apps/ios/`** (project
> `GUS.xcodeproj`, bundle `com.startekenterprises.gus`): one
> app, the R1 identity sign-in instead of pairing, and live
> voice calls as the front door. This companion is frozen —
> no new features, no new builds (the `hosts/ios-app/build-ipa.sh`
> defaults still point here only until the R4 app takes over
> the script's variables). The source stays in the tree for
> reference; do not build on it.

> **DEPRECATED in v0.13.0 (the "One GUS" redo, R1).** The redo's
> ruling (2026-11-18): the companion is retired — one GUS app for
> Mac/iOS/etc. replaces it, and devices sign in with the GUS
> identity itself instead of pairing. The QR pairing flow this
> app used is **deleted** from the control plane in v0.13.0
> (grant mint/exchange endpoints gone); an installed companion
> keeps working exactly as before on its **operator-token** path
> (manual panel address + token in Settings — that path is
> untouched and remains the way to use this app). The source
> stays in the tree until the redo's phone increment (R4) ships
> its replacement; physical deletion lands then. Do not build
> new features here.

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
- **Settings** — pairing first (below), with the manual panel
  address + operator token kept as a fallback (credential in the
  Keychain only), visible save confirmation, and a connection
  test that saves the form before it tests what you typed.
- **Watch** — live/stopped + mode + waiting count, Stop/Resume,
  and approve/deny from the wrist.

## Build it

1. Open `GUSCompanion.xcodeproj` in Xcode (26 on the iMac).
2. Signing is pre-set on both targets — the STARTEK team with
   automatic signing (bundle ids
   `com.startekenterprises.gus.companion` and
   `…companion.watchapp`). Change the team only if you're
   building under a different one.
3. Run on the iPhone; the Watch app embeds automatically.
4. Connect it: use the manual path — panel address
   (your Mac — its Tailscale name is the reliable route, e.g.
   `https://imac.<tailnet>:8731`) and the operator token from
   `~/.gus/state/panel-token`, saved in the app's Settings.
   (The v0.12.0 QR pairing flow was removed in v0.13.0 — see the
   deprecation note at the top. A phone already holding a device
   credential from v0.12.0 keeps working: the registry still
   honors it, and it stays listed and revocable on the Mac.)

## Transport & security notes

- The panel is operator-grade: it can approve actions and stop
  the agent. Reach it over Tailscale or an SSH tunnel — never
  expose it to the open internet. The credential is a bearer
  credential; it lives in the Keychain on the phone and is sent
  as `Authorization: Bearer …`, the panel's documented API auth.
- A paired device's credential is deliberately narrower than
  the operator token: the panel confines it to this app's
  surface (status, jobs, approvals, kill switch, Governor
  mode). Revoke a phone any time from the Mac's Settings →
  Devices — its credential stops working immediately.
- The companion holds none of GUS's vault secrets. Losing the
  phone loses a credential: revoke that device on the Mac (a
  paired phone), or rotate `panel-token` and restart the
  control plane (a manually-tokened one).

## Honest status

Source-complete scaffold, authored 2026-11-06. **First build
2026-11-16** (Xcode 26.2, the operator's iMac): compiled clean
with zero Swift errors, installed and launched on the iPhone 17
Pro simulator (iOS 26.1). Three scaffold fixes landed with that
build: the hand-written project never set a Base SDK, so Xcode
defaulted both targets to macOS — `SDKROOT` is now committed
(`iphoneos` / `watchos`); the STARTEK team is committed as
`DEVELOPMENT_TEAM` so signing works out of the box; and the
Watch target carries `SKIP_INSTALL = YES` — without it the
archive action installed `GUSWatch.app` beside the iPhone app
in `Products/Applications`, which made Xcode classify the
archive as a Generic Xcode Archive with no .ipa distribution
flow. Still
unproven: the run on a physical iPhone + Watch, and the panel
connection test from the app (needs the Tailscale address +
token in Settings, step 4 above).

## Roadmap

- **Call GUS** — the voice channel (Phase 9 direction): talk to
  GUS, hear approvals read back, confirm by phrase; a spoken
  kill phrase. Transcript-boundary scanning per the design note.
- WatchConnectivity token sync from the phone (today the watch
  reads the shared Keychain when iCloud Keychain is on).
- Approval push notifications (needs an APNs path that respects
  the local-first posture — likely via the operator's own Mac).
