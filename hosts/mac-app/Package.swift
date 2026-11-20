// swift-tools-version: 5.9
//
// GUS.app + GusMacHost (Phase 8) — the native Mac side of GUS.
//
// Two executables, no third-party dependencies:
//   - GusMacHost: the long-lived helper behind the control plane's
//     MacHostAdapter seam. Newline-delimited JSON over a unix socket
//     (~/.gus/comm/mac-host.sock); Accessibility for observe/click/
//     focus, CGEvent for input, ScreenCaptureKit for screenshots.
//   - GUS: the desktop app (v0.7: a chat-first main window over the
//     local panel APIs, plus the menu-bar presence; v0.8: a native
//     Settings window and the first-run setup flow, over the same
//     panel APIs; v0.9: Call GUS — voice in the chat window, over
//     the panel's voice endpoints; v0.9.1: the call is a live
//     session — streamed microphone, sentence-by-sentence spoken
//     replies, barge-in — over the panel's voice session routes;
//     v0.9.2: the call shows its hearing (mic vs heard levels in
//     the in-call strip) and capture restarts itself once
//     without voice processing when a microphone yields nothing;
//     v0.9.3: the capture path is rebuilt — no voice processing,
//     the tap takes the microphone's native format and the
//     converter is built from the buffers that actually arrive,
//     the strip's mic number is the raw pre-conversion level,
//     and a preflight refuses to open a call on a silent
//     microphone instead of listening forever; v0.9.5 is a
//     control-plane-only release (the GitHub publish pack) — no
//     app changes; v0.9.6: voice, built in — when the call's
//     resolved STT mode is local the app transcribes with the
//     Speech framework (on-device where supported) and posts
//     transcripts to the session; when TTS resolves local it
//     speaks the session's text segments with
//     AVSpeechSynthesizer; endpoint calls behave as before;
//     v0.9.7: voice that answers — the recognizer reports
//     partials and the app ends a sentence's audio when the
//     words settle and the mic quiets (0.9.6 waited on finals
//     nothing ever triggered), the call opens with a spoken
//     greeting from the control plane, and a Dictation/Siri or
//     permission wall is met with an in-app prompt deep-linking
//     to the exact Settings panes; v0.9.8: voice, smoothed —
//     the top bar's Call button is the real shared
//     VoiceCallButton (through 0.9.7 it was a disabled Desktop-1
//     placeholder), and an in-call Mute button stops the
//     microphone feed whole — no recognizer appends, no chunks
//     posted, the partial discarded, the strip reading Muted —
//     until Unmute restarts listening); v0.9.9: voice you can
//     test — ONE Call button (the top bar's duplicate is gone),
//     Mute made large and labeled in the in-call strip,
//     Settings → Voice gains Test Connection buttons (the form's
//     unsaved values, probed via the control plane), a Test mic
//     and speaker check (live mic level, a test sentence through
//     the selected engine, and a built-in dictation trial with
//     a measured speed verdict for this Mac), and the
//     Shield-scan switch for spoken turns; v0.9.10: fast
//     voice scans — a spoken turn's Shield scan (switch on)
//     runs in the Shield's fast mode, deterministic patterns
//     only, so a reply is no longer gated on the full semantic
//     review's seconds; typed messages keep the full review,
//     and each turn record names the scan it got; v0.9.11:
//     voice, truthfully — provider failures name the backend
//     the config actually points at ("Meta (muse-spark-1.3)",
//     never a bare wrong vendor) and an empty reply is retried
//     once before it may fail a turn; the call strip shows the
//     Shield state as a chip next to Mute ("Shield: fast scan"
//     / "Shield: OFF", from the session state); and the
//     built-in ears are echo-gated — while GUS speaks (plus a
//     0.6 s tail) the recognizer is fed nothing and any partial
//     is discarded, so GUS never transcribes himself into a
//     turn (the price: no talking over GUS in a built-in call;
//     endpoint calls are untouched); v0.10.0: GUS remembers —
//     Memory Slice A: a read-only Context Pack of operator-owned
//     files (the state dir's context/ folder) is assembled per
//     job and injected into primary model calls — full pack on
//     the first hop, a compact digest after — under profiles
//     (operator-full; delegate-limited, which never includes
//     OPERATOR.md or the daily notes; voice-compact; and none
//     for approver-decision, canary, and update jobs); every
//     section passes the Shield's new context-pack surface and
//     a secret-guard before it may ride, each job record carries
//     a content-free context manifest, and the Poisoned-Memory
//     drill proves a remembered "pre-approved, caps unlimited"
//     line still parks for the one-time approval and dies at
//     the real caps; the control plane also writes a liveness
//     beat (liveness.json in the state dir, refreshed every
//     15 minutes, $0, no model call) so an outside watchdog can
//     tell a live GUS from a dead one; and the Mac app gets a
//     polish pass — the window shrinks to 440x420, the icon
//     rail gains Approvals, Updates, and a Menu entry, the one
//     Call button sits in the top bar next to Invite, and the
//     composer gains mic dictation and an up-arrow send;
//     v0.10.1: Voice, fast again — v0.10.0's Context Pack was
//     charging every voice turn for a sequential round of full
//     Shield scans over the whole pack (~55 s a turn); voice
//     jobs now assemble under the voice-compact profile, pack
//     section scans are cached by section hash (a cached block
//     verdict is never reused — blocks always re-scan — and
//     only real non-block scans are cached), cache misses scan
//     in parallel, and voice-compact scans run the gate's fast
//     mode, so a steady-state voice turn pays zero pack scans.
//     The Mac app also gains hover tooltips on every rail and
//     sidebar control, a Chats slide-out at the top-left, right
//     sidebar tabs (Activity / Approvals / Identity — Identity
//     shows the live memory status and carries the customizable
//     avatar image, the editable display name, and the TTS
//     voice picker for the endpoint speech engine), and a
//     working Invite button (system share sheet, clipboard
//     fallback); v0.10.2: Opens, truthfully — mac.open_app no
//     longer verifies a launch by the frontmost app alone
//     (2026-11-16: Safari opened behind Calculator and the job
//     failed loudly while Safari sat open); the Mac host's
//     probe now reports the running regular apps, and an open
//     verifies when the app is frontmost OR running, failing
//     only when it is neither. Helpers predating the probe
//     field keep the old front-app-only check; v0.11.0: the
//     polish bundle — the chat gains a live secure log under
//     the transcript (the Watch timeline's records narrated in
//     plain language by the reader: Shield scans, approvals,
//     actions, with filter chips, a search box that filters
//     AND highlights, visible by default and hideable from the
//     log's header or Settings → General; a permissive
//     let-through renders as ONE discreet flagged line with
//     the full detail and receipt one tap away, on the Jobs
//     record); the avatar + display name move into a fixed
//     header above the sidebar tabs (the Identity tab keeps
//     the editors); the window's default launch size is the
//     full three-pane size again (1180×760 — the 440×420
//     floor stays reachable, it is just not the default); and
//     the built-in speech engine gets its voice picker at
//     last — the voices installed on the Mac, enumerated
//     live, persisted app-side, and actually spoken by the
//     synthesizer in calls and tests, with Test voice buttons
//     beside both pickers (Identity tab, Settings → Voice);
//     v0.11.1: the chat's secure log is one-liners only — the
//     recorded detail and receipt ids move behind each line's
//     disclosure (tap to expand), and each line gains its
//     category chip; the app icon is Logo B, the clean
//     geometric G (the Commons resident poll's pick — the
//     logo now rotates per build until one sticks); the
//     Identity header's fallback avatar is a bundled GUS
//     character (Avatar A, the poll's other pick) instead of
//     the bare app icon, and Reset returns to it; and the
//     built-in voice picker gains a language filter (English
//     by default, remembered) with premium/enhanced voices
//     sorted first and labeled, the saved pick never stranded
//     by the filter; v0.12.0: the redo begins — iPhone Step 1
//     lands (QR pairing with single-use grants and per-device
//     revocable credentials, a Devices registry in Settings,
//     and the entitlement skeleton resolving to the self-hosted
//     edition), and the new design is baked into this app: the
//     chat is the conversation again (per-job settlement lines
//     no longer render in the transcript and the secure log
//     moved to the Jobs section — Chat keeps one slim live-
//     status strip with the newest line, which also removes
//     the 60-line live rendering that taxed the window), the
//     header avatar breathes with a soft glow (stronger while
//     a call is speaking; still under Reduce Motion), and the
//     app icon is the GUS character on a deep-navy rounded
//     tile — character-as-icon, no letterform.
//     It launches GusMacHost from inside the bundle (so
//     Accessibility / Screen Recording grants attach to
//     GUS.app), shows status, starts/stops the launchd agents, and
//     hosts the first-run permissions window.
//
// Deployment target macOS 14 (the resident iMac runs Sequoia via
// OpenCore; nothing here needs a macOS 15-only API).
//
// Build on a Mac with:  swift build -c release
// Package a DMG with:   ./build-dmg.sh
import PackageDescription

let package = Package(
    name: "GusMacApp",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "GusMacHost", targets: ["GusMacHost"]),
        .executable(name: "GUS", targets: ["GusApp"]),
    ],
    targets: [
        .executableTarget(name: "GusMacHost", path: "Sources/GusMacHost"),
        .executableTarget(name: "GusApp", path: "Sources/GusApp"),
    ]
)
