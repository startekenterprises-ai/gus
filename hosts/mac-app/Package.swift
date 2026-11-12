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
//     until Unmute restarts listening).
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
