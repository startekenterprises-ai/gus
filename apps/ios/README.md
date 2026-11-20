# GUS — the unified iPhone app (v0.15.0, "the front door", redo R4)

The ONE GUS app for iPhone. It replaces the retired companion
(`apps/companion/` — frozen, do not build on it): no QR
pairing, no per-device credential. The phone signs in with
the **same R1 identity as the Mac** and its front door is a
**live voice call** — tap Call and talk; full-duplex, with
barge-in. There is no push-to-talk anywhere in this app, by
design (Glenn's ruling, 2026-11-19).

Spec: `~/workspace/goals/gus-secure-ai-agent/files/gus-r4-unified-ios-app-voice-2026-11-19.md`
(the R4 direction — milestones M1 live call → M2 self-pitch →
M3 see-what-he-did).

## What's here (chunk 1 — scaffolding)

- **Launch gate** — at launch the app asks the core for its
  identity session (`GET /api/identity/session`). A live
  session opens straight in (log in once, stay logged in);
  otherwise `LoginView` offers exactly what the identity seam
  can do — Continue (no-login local), username + password
  (local-password), hosted providers shown disabled with the
  reason — mirroring the Mac app's login screen.
- **Call tab** — the call screen + `CallSession`: AVAudioSession
  in `.playAndRecord` / `.voiceChat`, the Speech framework
  recognizer wired on-device, and the panel's voice-session
  protocol (start / state / next-audio / transcript / audio /
  interrupt / end — the same live-call protocol the Mac app
  speaks since v0.9.1). Barge-in cuts local playback and posts
  the session interrupt.
- **Speech engines** behind one seam (`Shared/SpeechEngine.swift`):
  **Kokoro** (on-device) is the default and the preference;
  **Studio Voice** (cloud, paid) is an opt-in stub; the
  **Apple voice** (AVSpeechSynthesizer, best installed voice)
  is the working fallback — and the call screen says when a
  fallback is what's actually speaking.
- **Chat tab** — an honest shell; typed chat lands with M3.
- **Activity tab** — recent jobs from `/api/jobs`, with the
  M3 note on its face: the receipts view must ride the panel's
  **incremental log cache** (never re-parse; watching never
  slows the voice path).
- **Settings tab** — core connection, voice engine choice,
  sign-out.

## Two layers, named honestly

Reaching the core and being signed in are different things
(see `Shared/GUSClient.swift`'s header):

1. **Transport** — the panel's bearer token. First run asks
   for the core's address (the Mac's Tailscale name, e.g.
   `https://your-mac.<tailnet>:8731`) and the panel token
   from `~/.gus/state/panel-token` on the Mac. The token
   lives in the iPhone's Keychain. Never expose the panel to
   the open internet.
2. **Identity** — the R1 sign-in above. The session lives in
   the core's state dir; its token never leaves the core.

## Build it

1. Open `GUS.xcodeproj` in Xcode (26 on the iMac).
2. Signing is pre-set — the STARTEK team with automatic
   signing, bundle id `com.startekenterprises.gus`.
3. Run on the iPhone, connect (address + token), sign in.
4. Scripted .ipa: `hosts/ios-app/build-ipa.sh` is
   parameterized — point its `GUS_IOS_PROJECT_DIR` /
   `GUS_IOS_PROJECT_PATH` / `GUS_IOS_SCHEME` variables here
   (`apps/ios`, `GUS.xcodeproj`, `GUS`) when this app takes
   over the release flow. Its icon step decodes
   `App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png.b64`
   (the icon rides the repo as base64 text, the established
   pattern; the decoded PNG is a build artifact).

## What's here (chunk 2 — the on-device call)

Everything in chunk 1, plus:

- **On-device mode (the default for calls)** — `CallSession`
  runs the whole call on the phone: the Speech recognizer
  hears, `LocalBrain` answers, the resolved speech engine
  speaks. No core session, no network — airplane-mode calls
  work. Core mode is unchanged chunk-1 behavior, one picker
  away (Settings → Call mode).
- **The brain** — `Shared/LocalBrain.swift`: llama.cpp via
  LLM.swift (pinned exact 3.0.3) running Qwen3-4B-Instruct-
  2507 Q4_K_M. Replies stream sentence-by-sentence into the
  speech engine, each sentence passed through `SpokenForm`
  (the Swift port of the core's v0.14.7 transform — same
  rules, same lines). A `<think>` guard keeps reasoning from
  ever being read aloud.
- **The voice** — Kokoro-82M on-device via FluidAudio (pinned
  exact 0.18.4), CoreML on the Neural Engine, real English
  G2P (BART phonemizer + Misaki lexicon), default voice
  af_heart. Runtime choice recorded in `Shared/KokoroTTS.swift`:
  ONNX Runtime's GitHub repos vanished 2026-11-18, so the
  ONNX route cannot resolve today; CoreML is the native one.
  The engine reports available ONLY after the SDK's
  initialize() completes (assets downloaded + hash-verified +
  loaded); every failure falls back to the Apple voice, loudly.
- **Model delivery** — weights are never in git. The manifest
  of record is `Models/manifest.json` (pinned URL + sha256 +
  size per file). The brain (~2.5 GB) is downloaded by the
  app's own `ModelLibrary` (Settings → On-device models):
  progress, sha256 verification before first use, clean
  failure and retry. Kokoro's assets (~294 MB) are downloaded
  and hash-verified by FluidAudio against its own pinned
  manifest; the manifest inventories them for the record.
- **Offline opening** — an install that has signed in before
  may open when the core is unreachable (`signedInOffline`),
  so the on-device call is reachable in airplane mode. A
  never-signed-in install still meets the launch gate.

## Honest status

**Chunk 2 authored Nova-side 2026-11-19; not yet compiled.**
Swift cannot build in the authoring environment — the first
compile is the iMac loop's, as with every GUS Swift surface,
and the two new SPM packages (FluidAudio, LLM.swift) make
that first build the real test of this chunk. Known soft
spots, stated before Glenn finds them: the FluidAudio API
surface used here (`KokoroAneManager`, `synthesizeDetailed`)
is taken from the project's current documentation at the
pinned version; LLM.swift's streaming `respond(to:with:)`
likewise from its pinned source. Stubs that remain, labeled
where they sit: Studio Voice (not configured, by design),
typed chat (M3), the self-pitch demo mode (M2).
