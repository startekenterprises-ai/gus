import AVFoundation
import FluidAudio
import Foundation

// Kokoro on-device (v0.15.0 chunk 2) — the real engine behind
// SpeechEngine.swift's .kokoro seam.
//
// Runtime choice, recorded: the original plan was ONNX
// Runtime Mobile via SPM, but Microsoft's onnxruntime GitHub
// repositories vanished on 2026-11-18 (404s, release downloads
// blocked) — that package cannot even resolve today. Kokoro
// therefore runs on CoreML through FluidAudio (Apache-2.0,
// pinned exact in the project): their KokoroAne pipeline is
// the same Kokoro-82M weights (hexgrad/Kokoro-82M, Apache-2.0)
// converted to a seven-stage CoreML chain for the Neural
// Engine, with a REAL English G2P — a BART seq2seq phonemizer
// plus the Misaki lexicon — which is the part a hand-rolled
// port would have done worst. The SDK downloads its assets
// from FluidInference/kokoro-82m-coreml on first use and
// verifies every file against its own pinned content hashes
// (inventoried in apps/ios/Models/manifest.json).
//
// The legacy chain (not ANE-v3) is used deliberately: v3
// requires iOS 18; this app's floor is iOS 17, and the legacy
// chain is the one shipping apps run.
//
// THE VOICE (v0.15.4, Glenn's directions live on 2026-11-20):
// Kokoro prepares ITSELF — warm-up starts automatically when
// the signed-in shell opens, no "Prepare voice" tap — and
// there is no other built-in voice behind it: the Apple
// fallback voice is REMOVED, full stop. A call that arrives
// before the voice is ready WAITS for it (synthesize joins
// the warm-up) instead of borrowing a voice Glenn called
// "the default cheesy computer voice lady". The operator
// picks WHICH Kokoro voice below — af_heart, the female
// default Glenn likes, plus male and British options; a
// non-default voice's pack is ~0.5 MB and the SDK fetches it
// on demand the first time that voice speaks.
//
// HONEST GATING: `isReady` becomes true only after the SDK's
// initialize() has actually completed — assets downloaded,
// hashes verified, models loaded. Every failure lands in
// .failed with the error in words, on screen.

// MARK: - The voice catalog

/// Which Kokoro voice speaks. Kokoro ships many; these are
/// the curated few the Settings picker offers (v0.15.4) —
/// the male default (v0.33.0 — see `selected`), the female
/// voice that was the default through v0.32.0, and British
/// options for range. The selection persists in
/// UserDefaults; warm-up preloads the selected voice's
/// pack, and the SDK fetches any other pack on demand
/// (~0.5 MB) the first time that voice is used.
struct KokoroVoice: Identifiable, Equatable, Hashable {
    let id: String
    let displayName: String

    /// The short spoken name — the first word of the
    /// display name ("Heart", "Michael") — for lines the
    /// voice itself speaks (the v0.33.0 preview's
    /// self-introduction).
    var shortName: String {
        displayName.components(separatedBy: " ").first ?? displayName
    }

    static let all: [KokoroVoice] = [
        KokoroVoice(id: "af_heart", displayName: "Heart — female"),
        KokoroVoice(id: "af_bella", displayName: "Bella — female"),
        KokoroVoice(id: "af_nicole", displayName: "Nicole — female"),
        KokoroVoice(id: "am_michael", displayName: "Michael — male (default)"),
        KokoroVoice(id: "am_fenrir", displayName: "Fenrir — male"),
        KokoroVoice(id: "am_puck", displayName: "Puck — male"),
        KokoroVoice(id: "bf_emma", displayName: "Emma — British female"),
        KokoroVoice(id: "bm_george", displayName: "George — British male"),
    ]

    /// The simple level (v0.23.0): three voices up front —
    /// Heart (the female voice), Emma (a clearly different
    /// voice: British, where Heart is American), and Michael
    /// (the male voice, and the default since v0.33.0). The
    /// full eight stay one disclosure away in Settings.
    /// Michael has been in the catalog since v0.15.4 and
    /// rides the same delivery as every voice: warm-up
    /// preloads the SELECTED voice's pack, and the SDK
    /// fetches any other pack on demand (~0.5 MB) the
    /// first time that voice speaks — no separate asset
    /// pipeline exists or is needed.
    static let curated: [KokoroVoice] = [
        KokoroVoice(id: "af_heart", displayName: "Heart — female"),
        KokoroVoice(id: "bf_emma", displayName: "Emma — British female"),
        KokoroVoice(id: "am_michael", displayName: "Michael — male (default)"),
    ]

    /// The simple picker's options: the curated three, plus
    /// the current pick when it isn't one of them — a voice
    /// chosen from the full list stays the selection and
    /// stays visible up front, never silently reset by the
    /// restructure (the Mac picker's custom-entry rule,
    /// applied to the simple level).
    static func simpleOptions(current: KokoroVoice) -> [KokoroVoice] {
        var options = curated
        if !options.contains(current) { options.append(current) }
        return options
    }

    /// The operator's pick, persisted. Default: am_michael
    /// (v0.33.0). Through v0.32.0 the no-pick default was
    /// af_heart — the female voice Glenn chose in v0.15.4,
    /// before GUS had a face. Since v0.32.0 the no-persona
    /// state IS Gus (his name, the boy's face), and Glenn's
    /// verdict on that pairing was plain: a boy's face with
    /// a woman's voice is a mismatch. The default is the
    /// warm male voice now; Heart stays in the catalog one
    /// tap away, and any pick already saved on a phone is
    /// untouched — only the never-picked fallback moved.
    static var selected: KokoroVoice {
        get {
            let raw = UserDefaults.standard.string(forKey: "gus.voice.kokoroVoice") ?? ""
            return all.first(where: { $0.id == raw })
                ?? all.first(where: { $0.id == "am_michael" })
                ?? all[0]
        }
        set { UserDefaults.standard.set(newValue.id, forKey: "gus.voice.kokoroVoice") }
    }
}

/// One persona's own voice (v0.33.0): the operator may give
/// any persona any catalog voice (the Personas tab's voice
/// card), and the assignment persists per persona, keyed by
/// the starter's stable id. Absent an assignment, the
/// starter's shipped voiceID is the persona's voice — this
/// store only ever holds the operator's own overrides, so a
/// future build's rebalanced defaults still reach everyone
/// who never overrode them. A stored id that is no longer
/// in the catalog reads as no assignment, never as a voice
/// the engine doesn't have.
enum PersonaVoiceAssignment {
    private static func key(forPersona id: String) -> String {
        "gus.voice.persona.\(id)"
    }

    static func voiceID(forPersona id: String) -> String? {
        let raw = UserDefaults.standard.string(forKey: key(forPersona: id)) ?? ""
        return KokoroVoice.all.contains(where: { $0.id == raw }) ? raw : nil
    }

    static func setVoiceID(_ voiceID: String?, forPersona id: String) {
        if let voiceID, KokoroVoice.all.contains(where: { $0.id == voiceID }) {
            UserDefaults.standard.set(voiceID, forKey: key(forPersona: id))
        } else {
            UserDefaults.standard.removeObject(forKey: key(forPersona: id))
        }
    }
}

/// How fast Kokoro speaks (v0.42.0) — one global pick,
/// not per-persona: speed is the LISTENER's preference,
/// not a persona trait (Claude's Voice settings sheet,
/// from Glenn's screenshots, keeps its Speed beside the
/// voice and model the same way). The pick rides the
/// SDK's own speed parameter —
/// `KokoroAneManager.synthesizeDetailed(text:voice:speed:)`,
/// whose default is `KokoroAneConstants.defaultSpeed`
/// (1.0) — so the model itself predicts shorter or
/// longer phoneme durations: the voice's pitch is its
/// own at every speed, never resampled audio. The SDK
/// declares no clamp for the parameter; the steps below
/// sit well inside Kokoro's sane band, and any stored
/// value is snapped to the nearest step on read, so the
/// engine only ever hears one of these five.
enum KokoroSpeed {
    static let steps: [Double] = [0.8, 0.9, 1.0, 1.1, 1.25]
    static let defaultStep: Double = 1.0

    /// The operator's pick, persisted at gus.voice.speed.
    /// An unwritten key reads as 1.0 — Normal, the speed
    /// every build through v0.41.1 spoke at.
    static var selected: Double {
        get {
            let raw = UserDefaults.standard.object(forKey: "gus.voice.speed") as? Double
            return snapped(raw ?? defaultStep)
        }
        set { UserDefaults.standard.set(snapped(newValue), forKey: "gus.voice.speed") }
    }

    /// The nearest offered step — the read and write
    /// both pass through here, so a value no picker
    /// offers can neither be stored nor reach the SDK.
    static func snapped(_ value: Double) -> Double {
        steps.min(by: { abs($0 - value) < abs($1 - value) }) ?? defaultStep
    }

    /// The picker's label for a step: 1.0× is "Normal"
    /// (Claude's word for its own default); the rest
    /// carry their number.
    static func displayName(for step: Double) -> String {
        step == defaultStep
            ? "Normal (1.0×)"
            : String(format: "%g×", step)
    }
}

final class KokoroRuntime: ObservableObject {
    static let shared = KokoroRuntime()

    enum State: Equatable {
        case idle
        case warming
        case ready
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    private var manager: KokoroAneManager?
    private var warmTask: Task<Void, Never>?
    private let gate = SynthGate()

    var isReady: Bool { state == .ready }

    /// Begin (or join) warm-up: download + verify + load.
    /// Safe to call repeatedly; only the first call works.
    func warmUp() {
        if state == .ready || warmTask != nil { return }
        state = .warming
        warmTask = Task { [weak self] in
            guard let self else { return }
            let manager = KokoroAneManager()
            do {
                // Preload the operator's chosen voice pack
                // with the rest of preparation, so picking a
                // voice in Settings never costs a first-sentence
                // download later.
                try await manager.initialize(preloadVoices: [KokoroVoice.selected.id])
                self.manager = manager
                self.state = .ready
            } catch {
                self.state = .failed("Kokoro couldn't start: \(error.localizedDescription)")
            }
            self.warmTask = nil
        }
    }

    /// Synthesize one sentence to 24 kHz mono float samples,
    /// in the operator's selected voice. Serialized through
    /// the gate: the manager is never asked for two utterances
    /// at once (a barged-in sentence may still be finishing
    /// when the next begins).
    func synthesize(_ text: String) async throws -> (samples: [Float], sampleRate: Double) {
        try await synthesize(text, voice: KokoroVoice.selected.id)
    }

    /// The same synthesis in a NAMED voice (v0.33.0) — the
    /// voice preview's path. It is the app's real synthesis,
    /// not a sample clip: same manager, same one-at-a-time
    /// gate, same on-demand pack fetch (a voice whose pack
    /// isn't on the phone yet is fetched by the SDK inside
    /// this call, which is why a first preview can take a
    /// moment — the button shows the wait, honestly). What
    /// the operator hears in a preview is what a call in
    /// that voice would sound like, because it is the same
    /// code making the sound.
    func synthesize(_ text: String, voice voiceID: String) async throws -> (samples: [Float], sampleRate: Double) {
        try await awaitReady()
        guard let manager else {
            throw NSError(domain: "GUS.Kokoro", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Kokoro is not ready.",
            ])
        }
        await gate.acquire()
        do {
            // v0.42.0: the speed pick is read HERE, at
            // each synthesis — this one call is the
            // funnel every spoken sentence passes
            // through (call sentences on both playback
            // engines, and the Settings/Personas voice
            // previews alike), so a change in Settings
            // lands on the NEXT sentence, even mid-call,
            // and a preview always sounds at call speed.
            let result = try await manager.synthesizeDetailed(
                text: text, voice: voiceID, speed: Float(KokoroSpeed.selected))
            await gate.release()
            return (result.samples, Double(result.sampleRate))
        } catch {
            await gate.release()
            throw error
        }
    }

    /// Join the self-preparation instead of failing (v0.15.4):
    /// with the fallback voice gone, "not ready" at the first
    /// sentence of a first call means WAIT — warm-up starts
    /// here if nobody started it, and this polls until the
    /// runtime is ready (bounded at ~180 s: the one-time asset
    /// download on a slow connection), failed, or the caller
    /// is cancelled (barge-in). Throws only on a real failure
    /// or the bound. A wait that ends in failure does NOT trip
    /// noteSynthesisFailure: that only acts on a runtime that
    /// reached .ready, and this one never did.
    private func awaitReady() async throws {
        if state == .idle { warmUp() }
        let deadline = Date().addingTimeInterval(180)
        while true {
            switch state {
            case .ready:
                return
            case .failed(let message):
                throw NSError(domain: "GUS.Kokoro", code: 4, userInfo: [
                    NSLocalizedDescriptionKey: message,
                ])
            case .idle, .warming:
                break
            }
            if Task.isCancelled { throw CancellationError() }
            if Date() > deadline {
                throw NSError(domain: "GUS.Kokoro", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: "Kokoro took too long to get ready.",
                ])
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
    }

    /// A synthesis failure mid-call marks the runtime failed,
    /// so the next sentence surfaces the failure in words
    /// instead of retrying a broken engine sentence after
    /// sentence.
    func noteSynthesisFailure(_ error: Error) {
        if state == .ready {
            state = .failed("Kokoro stopped working: \(error.localizedDescription)")
        }
    }
}

/// A one-at-a-time async gate for synthesis calls.
private actor SynthGate {
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if !busy {
            busy = true
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        if waiters.isEmpty {
            busy = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}

// MARK: - Voice failure log

/// The voice path's memory (v0.22.0): a tiny in-app record of
/// what the playback path did and how it failed — the fix for
/// two builds of silent calls that left no evidence anywhere.
/// Before this, a playback error was caught, the sentence was
/// finished as if spoken, and the only trace sat in a Settings
/// row nobody opens mid-call. Now every playback failure is
/// recorded here WITH its error; the first connection of a
/// call records the path it took (voice processing on or off,
/// the formats involved, the route); the call screen speaks
/// up after repeated failures; and Settings → About shows the
/// last lines verbatim — so a field report can carry the
/// reason instead of "still silent." In-memory only, capped;
/// no framework, no file.
final class VoiceFailureLog {
    static let shared = VoiceFailureLog()

    private let lock = NSLock()
    private var lines: [String] = []
    private var failures = 0
    private var lastFailure: String?

    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    /// A path note: what the voice path did, for the record.
    func recordInfo(_ line: String) {
        append(line)
    }

    /// A failure: counted, kept as the latest, and recorded.
    func recordFailure(_ line: String) {
        lock.lock()
        failures += 1
        lastFailure = line
        lock.unlock()
        append(line)
    }

    var failureCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return failures
    }

    var latestFailure: String? {
        lock.lock()
        defer { lock.unlock() }
        return lastFailure
    }

    var recentLines: [String] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }

    private func append(_ line: String) {
        lock.lock()
        lines.append("\(Self.clock.string(from: Date()))  \(line)")
        if lines.count > 30 { lines.removeFirst(lines.count - 30) }
        lock.unlock()
    }
}

// MARK: - Sample playback

/// Plays Kokoro's float samples through an AVAudioEngine
/// player node, with the seam's exactly-once finish contract:
/// the completion fires when the buffer ends OR when stop()
/// cuts it — whichever first, and never twice. (Whether
/// AVAudioPlayerNode calls a stopped buffer's completion
/// handler has varied across iOS versions; this class does
/// not depend on the answer.)
final class KokoroPlayer {
    // Two playback graphs (v0.29.1 — the prime that chooses
    // between them is primeCallAudio, below). The SHARED
    // graph is the call's engine, handed in at init:
    // microphone and playback on one engine, so the system's
    // voice processing can cancel GUS's own voice (v0.18.0).
    // The FALLBACK graph is a private engine this player
    // owns outright — the pre-0.18.0 topology, the last one
    // heard on Glenn's phone — created only when a call's
    // prime proves the shared graph cannot cycle its player
    // (the field failure two builds documented: "player did
    // not see an IO cycle" on every play(), every structural
    // check green). Which graph is active is decided once
    // per call, at prime time, and never changes mid-call;
    // `engine` / `player` / `attached` / `connectedFormat`
    // always name the ACTIVE graph's state, so the whole
    // playback path — ensurePlayable, startPlayback, stop —
    // runs unchanged on whichever graph the call landed on.
    private let sharedEngine: AVAudioEngine
    private let sharedPlayer = AVAudioPlayerNode()
    private var fallbackEngine: AVAudioEngine?
    private let fallbackPlayer = AVAudioPlayerNode()
    private var fallbackActive = false
    private var sharedAttached = false
    private var fallbackAttached = false
    private var sharedConnectedFormat: AVAudioFormat?
    private var fallbackConnectedFormat: AVAudioFormat?

    private var engine: AVAudioEngine {
        fallbackActive ? (fallbackEngine ?? sharedEngine) : sharedEngine
    }
    private var player: AVAudioPlayerNode {
        fallbackActive ? fallbackPlayer : sharedPlayer
    }
    private var attached: Bool {
        get { fallbackActive ? fallbackAttached : sharedAttached }
        set {
            if fallbackActive { fallbackAttached = newValue }
            else { sharedAttached = newValue }
        }
    }
    private var connectedFormat: AVAudioFormat? {
        get { fallbackActive ? fallbackConnectedFormat : sharedConnectedFormat }
        set {
            if fallbackActive { fallbackConnectedFormat = newValue }
            else { sharedConnectedFormat = newValue }
        }
    }
    private let lock = NSLock()
    private var finish: (() -> Void)?
    private var playing = false
    /// Serializes the graph sequence in playSamples (connect
    /// → verify → schedule → play) against stop(): the two
    /// must never interleave, because a graph operation
    /// landing between playSamples' state checks and its
    /// play() reopens exactly the window the v0.27.0
    /// playable-state guarantee exists to close (see
    /// playSamples). Never held across playback itself —
    /// only across the setup sequence.
    private let playLock = NSLock()

    /// The engine is the CALL's shared engine when one is
    /// handed in (v0.18.0): playback and the microphone must
    /// live on the SAME engine for the system's voice
    /// processing to cancel GUS's own voice out of the mic —
    /// the echo canceller subtracts the output of its own
    /// engine, so sound played through a private engine is
    /// uncancellable by construction. Constructions with no
    /// call behind them keep a private engine, as before.
    /// (v0.29.1: the private FALLBACK engine above is the
    /// one deliberate exception — a call lands on it only
    /// when the shared graph's prime fails, accepting
    /// uncancellable playback over no playback; see
    /// primeCallAudio.)
    init(engine: AVAudioEngine = AVAudioEngine()) {
        self.sharedEngine = engine
    }

    deinit {
        // The fallback engine is this player's own property:
        // stop it with the player. The shared engine belongs
        // to the call session, which stops it at endCall —
        // never here.
        if let fallbackEngine, fallbackEngine.isRunning { fallbackEngine.stop() }
    }

    /// Playback amplitude for the call screen's avatar
    /// (v0.15.5, "the face"): fired once per buffer with the
    /// buffer's 0...1 level when it starts playing, and once
    /// with 0 when it ends or is cut — the mouth follows the
    /// first, and settles on the second. Set before playback
    /// begins; fired on scheduling/completion threads, so
    /// the consumer hops actors itself. This is the ONLY
    /// addition the animation makes to the audio path: one
    /// pass over samples already in memory, at schedule
    /// time — nothing per frame, nothing on the render path,
    /// and the call never waits on it (Glenn's hard rule:
    /// the face must not slow the call).
    var onLevelChange: ((Float) -> Void)?

    /// The playback path's one note per connection (v0.22.0):
    /// fired when the player (re)connects, carrying the path
    /// it took — voice processing on or off, the sample
    /// format it was handed, the format it will play, and
    /// whether the engine was running. The speech engine
    /// wires this into VoiceFailureLog, so a silent call's
    /// report shows the path instead of nothing. Failures
    /// themselves travel as thrown errors (the speech
    /// engine's stage-2 catch records them); this is context.
    var onDiagnostic: ((String) -> Void)?

    /// A play() the containment shim had to catch (v0.27.2):
    /// fired with the NSException's name and reason, Apple's
    /// own words, the moment the shim returns them — whether
    /// or not the one permitted rebuild then saves the
    /// sentence. The speech engine wires this into
    /// VoiceFailureLog as a FAILURE (not an info line), so
    /// Settings → About carries the reason the audio layer
    /// objected, which two crash-only field reports never
    /// could. See startPlayback and GUSPlayShim.h.
    var onPlaybackException: ((String) -> Void)?

    var isPlaying: Bool {
        lock.lock()
        defer { lock.unlock() }
        return playing
    }

    /// The call-start proof (v0.29.1) — the restructure two
    /// builds of field evidence forced. On v0.27.3 and again
    /// on v0.28.1, Glenn's Settings → About log showed EVERY
    /// play() on the shared voice-processing engine raising
    /// "player did not see an IO cycle" — persistently,
    /// across v0.28.1's settling retries (120/300/600 ms), a
    /// full reconnect, and live-format re-derivation, spread
    /// over ~16 s of attempts, with every structural check
    /// green (attached, connected per the engine's own
    /// connection points, mixer → output connected, engine
    /// running, formats converted 24 kHz mono → 44.1 kHz
    /// stereo). Timing theories are falsified: on that
    /// graph the render cycle simply never reaches this
    /// player, and patching the leg a third time is not the
    /// move. So a call no longer discovers the failure
    /// sentence by sentence — it proves the graph once, up
    /// front, and falls back to a topology that has already
    /// made sound on this phone.
    ///
    /// The sequence, at call setup (audio session
    /// configured, voice processing enabled, nothing playing
    /// yet, recognizer not yet (re)started):
    ///   (a) cycle the shared engine once — stop → prepare
    ///       → start. This is call setup, not the mid-call
    ///       engine stop v0.22.0 banned: no sentence exists
    ///       yet, and hearing starts after the prime.
    ///   (b) connect the player through the ordinary
    ///       ensurePlayable proof and play a quarter second
    ///       of SILENCE through the containment shim.
    ///       Silence is the payload: the prime is not a
    ///       sentence, so it deliberately bypasses
    ///       playSamples' all-zero-samples failure (code 8)
    ///       by never going through playSamples.
    ///
    /// The outcome decides the call's playback graph, once,
    /// for the whole call — no mid-call flapping:
    ///   prime plays → the call rides the shared graph with
    ///     exactly the v0.28.1 behavior, and the log says
    ///     "Call audio primed on the shared engine".
    ///   prime raises — or the graph cannot even be proven —
    ///     → the call's playback moves to the private
    ///     fallback engine, and the log says so with the
    ///     prime's error verbatim. The shared engine keeps
    ///     the microphone and the recognizer untouched;
    ///     only playback moves, and the shared audio
    ///     session's speaker routing covers both engines.
    ///     Echo on this path rests on the call's existing
    ///     guards (CallSession's echo word-overlap check and
    ///     barge-in sustained-partial debounce): the system
    ///     canceller has no reference for a private engine's
    ///     output, by construction.
    ///
    /// Called once per call, before the first sentence, and
    /// serialized under playLock like every graph sequence
    /// here. A player normally lives for exactly one call
    /// (the session resolves a fresh speech engine per
    /// call); a stale fallback from an earlier prime on the
    /// same player is torn down first regardless, so the
    /// decision is always this call's own.
    func primeCallAudio() {
        playLock.lock()
        defer { playLock.unlock() }
        // A previous prime's fallback (defensive — see the
        // note above): stop and drop its engine, reset its
        // graph state, and decide fresh on the shared graph.
        if let stale = fallbackEngine, stale.isRunning { stale.stop() }
        fallbackEngine = nil
        fallbackActive = false
        fallbackAttached = false
        fallbackConnectedFormat = nil

        let voiceProcessing = sharedEngine.inputNode.isVoiceProcessingEnabled
        // The live play format, derived exactly as
        // playSamples derives it for a sentence: the graph's
        // own output format on a voice-processing engine,
        // Kokoro's native 24 kHz mono otherwise.
        guard let nativeFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)
        else {
            // Cannot even name the format a sentence would
            // play in (a platform constant — not expected to
            // be reachable): the shared graph is unprovable,
            // so the call falls back rather than discovering
            // it sentence by sentence.
            activateFallback()
            onDiagnostic?("Call audio: private playback engine (shared-graph prime failed: the native play format couldn't be built)")
            return
        }
        var playFormat = nativeFormat
        if voiceProcessing {
            let graphFormat = sharedEngine.mainMixerNode.outputFormat(forBus: 0)
            if graphFormat.sampleRate > 0 { playFormat = graphFormat }
        }

        // (a) Cycle the shared engine once: stop → prepare
        // → start (the start itself happens inside
        // ensurePlayable's proof, in its v0.28.1
        // start-before-connect order — a start failure
        // surfaces there as the prime's failure).
        if sharedEngine.isRunning { sharedEngine.stop() }
        sharedEngine.prepare()

        // (b) Prove the graph, connect the player, and play
        // the silence through the shim. The accessors name
        // the SHARED graph throughout: the fallback is not
        // active unless and until this prime fails.
        var primeError: String?
        do {
            try ensurePlayable(playFormat: playFormat, voiceProcessing: voiceProcessing, sourceFormat: playFormat)
            if let silence = Self.silentBuffer(format: playFormat) {
                sharedPlayer.scheduleBuffer(silence, completionHandler: nil)
                primeError = GUSAudioPlayerPlayCatching(sharedPlayer)
                if primeError != nil { sharedPlayer.reset() }
            } else {
                primeError = "the prime's silent buffer couldn't be built"
            }
        } catch {
            primeError = error.localizedDescription
        }

        if let primeError {
            activateFallback()
            onDiagnostic?("Call audio: private playback engine (shared-graph prime failed: \(primeError))")
        } else {
            onDiagnostic?("Call audio primed on the shared engine")
        }
    }

    /// Engage the private playback graph for this call
    /// (v0.29.1): create its engine on first use and flip the
    /// active-graph accessors to it. Called under playLock
    /// from primeCallAudio only — the decision is made once,
    /// at call setup, and never revisited mid-call. The
    /// fallback graph's own proof happens lazily, inside the
    /// first sentence's ensurePlayable, exactly as the
    /// pre-0.18.0 private-engine path always ran; its play()
    /// calls go through the same containment shim, and the
    /// same in-call failure contract applies there.
    private func activateFallback() {
        if fallbackEngine == nil { fallbackEngine = AVAudioEngine() }
        fallbackActive = true
    }

    /// A quarter second of digital silence at a format
    /// (v0.29.1): the prime's payload. An AVAudioPCMBuffer's
    /// memory is zero-initialized, so a buffer with its
    /// frame length set and nothing written IS silence in
    /// any PCM format — which is the entire point here (see
    /// primeCallAudio on why this never goes through
    /// playSamples' all-zero-samples check).
    private static func silentBuffer(format: AVAudioFormat, seconds: Double = 0.25) -> AVAudioPCMBuffer? {
        let frames = AVAudioFrameCount(max(1.0, (format.sampleRate * seconds).rounded()))
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        buffer.frameLength = frames
        return buffer
    }

    func playSamples(_ samples: [Float], sampleRate: Double, onFinished: @escaping () -> Void) throws {
        // Gain stage (field report, Glenn 2026-11-20: Kokoro
        // on the phone is REALLY soft, with no gain anywhere
        // in the path). Kokoro's raw samples peak well below
        // full scale, so peak-normalize quiet material UP
        // toward 0.89 — headroom kept, so no clipping — with
        // the boost capped at 6x. Material already at or above
        // the ceiling plays untouched: only ever up, never down.
        var peak: Float = 0
        for sample in samples { peak = max(peak, abs(sample)) }
        var gained = samples
        if peak > 0, peak < 0.89 {
            let gain = min(0.89 / peak, 6.0)
            gained = samples.map { $0 * gain }
        }
        // The avatar's level (v0.15.5): the RMS of the very
        // samples about to play — one pass over data already
        // in memory, computed here at schedule time. Sentence
        // RMS after the gain stage lands around 0.1–0.25, so
        // ×3.5 puts ordinary speech mid-scale with headroom;
        // the exact feel is eyeballed on Glenn's phone.
        var sumSquares: Float = 0
        for sample in gained { sumSquares += sample * sample }
        let rms = gained.isEmpty ? Float(0) : (sumSquares / Float(gained.count)).squareRoot()
        let level = min(1, rms * 3.5)
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
            let buffer = AVAudioPCMBuffer(
                pcmFormat: format, frameCapacity: AVAudioFrameCount(gained.count)),
            let channel = buffer.floatChannelData?[0]
        else {
            throw NSError(domain: "GUS.Kokoro", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Couldn't build a playable audio buffer.",
            ])
        }
        buffer.frameLength = AVAudioFrameCount(gained.count)
        gained.withUnsafeBufferPointer { src in
            if let base = src.baseAddress {
                channel.update(from: base, count: gained.count)
            }
        }

        // Silence is a failure, not a sentence (v0.22.0): if
        // synthesis handed over all-zero samples — a voice
        // pack that failed to load on a fresh install is the
        // shape to fear — scheduling them would "play"
        // perfectly and say nothing, indistinguishable from
        // success in every signal the call watches. Name it
        // and throw it, so it lands in the failure log.
        guard peak > 0 else {
            throw NSError(domain: "GUS.Kokoro", code: 8, userInfo: [
                NSLocalizedDescriptionKey: "The voice produced silence instead of speech — its samples were all zero.",
            ])
        }

        // The format this engine can actually render (v0.19.0 —
        // the first silent-call fix). Since v0.18.0 playback
        // rides the call's shared engine, whose input node has
        // voice processing enabled (CallSession.startHearing):
        // the Voice Processing I/O unit then owns the engine's
        // input AND output and fixes the whole graph's I/O
        // format. A player connection at Kokoro's native
        // 24 kHz does not match that format, so the graph
        // cannot render it. Before v0.18.0 the identical
        // connection sang because the player's PRIVATE engine
        // had no voice processing and the standard output path
        // sample-rate-converts at the mixer. So: on a
        // voice-processing engine, convert the samples to the
        // graph's own output format and connect with THAT —
        // playback still rides the same engine through the
        // same output unit, so the echo canceller keeps its
        // reference; only the format the samples are handed
        // over in changes. Any other engine (private, or voice
        // processing failed to enable) keeps the proven
        // native-format path untouched.
        var playBuffer = buffer
        var playFormat = format
        let voiceProcessing = engine.inputNode.isVoiceProcessingEnabled
        if voiceProcessing {
            let graphFormat = engine.mainMixerNode.outputFormat(forBus: 0)
            if graphFormat.sampleRate > 0, graphFormat != format {
                playBuffer = try Self.convertBuffer(buffer, to: graphFormat)
                playFormat = graphFormat
            }
        }

        // The playable-state guarantee (v0.27.0 — the crash
        // fix). The field crash (GUS-2026-11-27-025146.ips,
        // app 0.25.0): EXC_CRASH / SIGABRT — an NSException
        // raised inside AVAudioPlayerNodeImpl::StartImpl,
        // reached from -[AVAudioPlayerNode play], on the
        // sentence pump's thread, just after the operator's
        // first speech final, when the first reply sentence
        // reached play(). StartImpl raises when the node is
        // not in a playable state at that instant — not
        // connected into the graph, or the engine not
        // running. The v0.22.0 no-stop reconnect opened
        // exactly that window: disconnect/connect on the
        // running shared engine, then schedule/play on the
        // ASSUMPTION the graph had settled — bookkeeping
        // (connectedFormat) stood in for the graph's actual
        // state, and nothing re-checked either the connection
        // or the engine between the reconnect and play(). An
        // NSException is not a Swift error: no do/catch in
        // this path can see it, which is why the v0.22.0
        // failure log never recorded the crash — prevention
        // by state guarantee is the only fix. So the whole
        // sequence below runs serialized (playLock, against
        // stop()), and play() is reached only after
        // ensurePlayable has PROVEN, in order, immediately
        // beforehand: attached → connected into the graph
        // (read back from the engine, not from bookkeeping)
        // → engine running. A state that cannot be proven is
        // a thrown error — the speech engine's stage-2 catch
        // logs it and finishes the sentence — never a play()
        // into an unproven graph.
        //
        // v0.27.2 — the guarantee above was necessary and NOT
        // sufficient. The identical crash recurred on 0.27.1
        // (GUS-2026-11-27-100032.ips): same StartImpl raise,
        // same thread, with ensurePlayable's proof passing
        // immediately before the call. The engine's reported
        // state can pass every check while StartImpl still
        // raises — the graph state under voice processing is
        // the suspect area, but the micro-cause is unproven
        // and this comment does not claim one. What is proven
        // is the shape of the only possible fix: Swift cannot
        // catch an NSException, so the bare play() call itself
        // had to go. play() is now reached only through the
        // Objective-C containment shim (startPlayback below,
        // GUSPlayShim.h), which returns a raise as data; the
        // proof remains, as defense in depth and because its
        // throws still name an unplayable state in words — but
        // containment, not prevention, is what ends the crash.
        playLock.lock()
        do {
            try ensurePlayable(playFormat: playFormat, voiceProcessing: voiceProcessing, sourceFormat: format)
        } catch {
            playLock.unlock()
            throw error
        }

        lock.lock()
        finish = onFinished
        playing = true
        lock.unlock()

        player.scheduleBuffer(playBuffer) { [weak self] in
            self?.fireFinish()
        }
        do {
            try startPlayback(playBuffer: playBuffer, playFormat: playFormat, voiceProcessing: voiceProcessing, sourceFormat: format, sourceBuffer: buffer)
        } catch {
            playLock.unlock()
            throw error
        }
        playLock.unlock()
        onLevelChange?(level)
    }

    /// Start the scheduled buffer playing — through the
    /// Objective-C containment shim (GUSPlayShim), never a
    /// bare player.play(). Called under playLock, with the
    /// buffer already scheduled and ensurePlayable's proof
    /// fresh. A clean play returns at once. On a caught
    /// exception, in order:
    ///
    /// 1. TELEMETRY — the exception's name and reason go out
    ///    verbatim via onPlaybackException (the speech engine
    ///    records it in VoiceFailureLog), whether or not the
    ///    sentence is then saved. This is the diagnostic the
    ///    crash-only reports never carried.
    /// 2. SETTLING (v0.28.1) — if the exception is the field-
    ///    captured "player did not see an IO cycle" (Glenn's
    ///    About log, v0.27.3: every sentence, every structural
    ///    check green), the player simply hasn't been through
    ///    a render cycle yet — nothing about the graph is
    ///    wrong, so nothing is rebuilt or flushed. The shim
    ///    play is retried after short increasing waits
    ///    (~120/300/600 ms, ~1 s worst case) on the existing
    ///    connection, giving the voice-processing graph's IO
    ///    cycle time to actually run through the player. A
    ///    success here is the whole recovery: the already-
    ///    scheduled buffer plays and fires its own finish.
    ///    Any OTHER exception skips the waits entirely, as
    ///    does an IO-cycle raise that outlasts them.
    /// 3. RECOVERY — exactly ONE rebuild: the player's queued
    ///    buffer is flushed (reset), the connection is forced
    ///    through ensurePlayable again — on a format re-
    ///    derived from the LIVE graph at that moment rather
    ///    than the sentence's captured one (v0.28.1: the VP
    ///    unit may have renegotiated the graph format between
    ///    synthesis and playback; when it has, the buffer is
    ///    re-converted from the source samples to match) —
    ///    the buffer is re-scheduled, and the shim play is
    ///    retried ONCE.
    /// 4. GIVE-UP — a second catch, or a rebuild whose own
    ///    proof throws, clears the pending finish WITHOUT
    ///    firing it and throws, so the speech engine's stage-2
    ///    catch records the failure and finishes the sentence
    ///    — the same contract ensurePlayable's throws already
    ///    had. The app never aborts, and this never loops:
    ///    settling waits, one rebuild, one retry, then the
    ///    sentence is over.
    private func startPlayback(playBuffer: AVAudioPCMBuffer, playFormat: AVAudioFormat, voiceProcessing: Bool, sourceFormat: AVAudioFormat, sourceBuffer: AVAudioPCMBuffer) throws {
        guard let caught = GUSAudioPlayerPlayCatching(player) else { return }
        onPlaybackException?("play() raised \(caught)")
        // SETTLING (v0.28.1) — step 2 in the doc comment
        // above. The waits run on the sentence pump's thread
        // under playLock: bounded (~1 s worst case, and only
        // on a sentence whose first play already failed), and
        // a stop() queues behind them rather than interleaving
        // with a half-recovered graph.
        if caught.contains("did not see an IO cycle") {
            let waits: [TimeInterval] = [0.12, 0.30, 0.60]
            var settled = false
            for (index, wait) in waits.enumerated() {
                Thread.sleep(forTimeInterval: wait)
                guard let retryCaught = GUSAudioPlayerPlayCatching(player) else {
                    onDiagnostic?("play() succeeded on settling retry \(index + 1) of \(waits.count) — the player saw its IO cycle after a \(Int((wait * 1000).rounded())) ms wait.")
                    settled = true
                    break
                }
                onPlaybackException?("play() raised on settling retry \(index + 1): \(retryCaught)")
                // Waiting only cures the IO-cycle state; a
                // different failure ends the settling early
                // and falls through to the rebuild.
                if !retryCaught.contains("did not see an IO cycle") { break }
            }
            if settled { return }
        }
        // Flush whatever the failed start left queued: a
        // stale buffer rendering under a later sentence would
        // speak the wrong words, and a queue whose state the
        // raise just called into question cannot be trusted.
        // reset() discards scheduled buffers without firing
        // their completions, so the pending finish below is
        // still this sentence's to fire — exactly once, by
        // whichever buffer actually plays.
        player.reset()
        do {
            connectedFormat = nil
            // Re-derive the format from the LIVE graph
            // (v0.28.1): the sentence's captured playFormat
            // was read at synthesis time, and the voice-
            // processing unit may have renegotiated the
            // graph's format since. When it has, reconnect on
            // the live format and re-convert the source
            // samples to match; when it hasn't, the captured
            // buffer is reused untouched.
            var rebuildBuffer = playBuffer
            var rebuildFormat = playFormat
            if voiceProcessing {
                let liveFormat = engine.mainMixerNode.outputFormat(forBus: 0)
                if liveFormat.sampleRate > 0, liveFormat != playFormat {
                    rebuildBuffer = try Self.convertBuffer(sourceBuffer, to: liveFormat)
                    rebuildFormat = liveFormat
                    onDiagnostic?("Rebuild re-derived the play format from the live graph: \(Self.describe(playFormat)) → \(Self.describe(liveFormat)).")
                }
            }
            try ensurePlayable(playFormat: rebuildFormat, voiceProcessing: voiceProcessing, sourceFormat: sourceFormat)
            player.scheduleBuffer(rebuildBuffer) { [weak self] in
                self?.fireFinish()
            }
        } catch {
            clearPendingFinish()
            throw error
        }
        if let caughtAgain = GUSAudioPlayerPlayCatching(player) {
            onPlaybackException?("play() raised again after one reconnect: \(caughtAgain)")
            player.reset()
            clearPendingFinish()
            throw NSError(domain: "GUS.Kokoro", code: 13, userInfo: [
                NSLocalizedDescriptionKey: "The voice's player wouldn't start even after its connection was rebuilt (\(caughtAgain)) — this sentence can't be played.",
            ])
        }
    }

    /// Drop the pending finish WITHOUT firing it, and mark
    /// playback stopped. Used when playback is about to throw
    /// after `finish` was already set: the speech engine's
    /// stage-2 catch finishes the sentence itself, and a
    /// stored callback firing later (a late buffer
    /// completion, a stop()) would finish it a second time.
    private func clearPendingFinish() {
        lock.lock()
        finish = nil
        playing = false
        lock.unlock()
    }

    /// Establish — and then prove — the state play()
    /// requires, in the order play() will depend on it:
    /// attached, connected into the graph, engine running.
    /// Called under playLock from playSamples, immediately
    /// before the buffer is scheduled and played; the final
    /// guards re-read the connection from the ENGINE (its
    /// own connection points, the same ground truth StartImpl
    /// checks) and the engine's running state, after any
    /// reconnect or start this call performed. Throws rather
    /// than letting play() proceed on an unproven state.
    /// Since v0.27.2 the connection proof walks the FULL
    /// chain — player → mixer → the engine's output node —
    /// where v0.27.0 proved only the player's own hop; the
    /// mixer's hop is established here too when the engine
    /// no longer shows it. (The proof is defense in depth
    /// now, not the crash fix — containment is; see
    /// playSamples.)
    private func ensurePlayable(playFormat: AVAudioFormat, voiceProcessing: Bool, sourceFormat: AVAudioFormat) throws {
        if !attached {
            engine.attach(player)
            // Full scale, stated rather than assumed (v0.18.0):
            // nothing in the playback path turns the call down.
            engine.mainMixerNode.outputVolume = 1.0
            attached = true
        }
        // Start BEFORE connecting (v0.28.1): through v0.28.0
        // the connect below was made into a stopped engine and
        // the engine started after — so the connection was
        // born into a graph that had never rendered, and the
        // field error that produced was exact about it:
        // "player did not see an IO cycle" (Glenn's About log,
        // v0.27.3 — every sentence, with every check below
        // passing). A connection made into an already-cycling
        // graph is the state play() expects; the start moves
        // here so that is the only order this function builds.
        // The running guard at the end still re-proves it.
        if !engine.isRunning {
            try engine.start()
        }
        // Connect once, and keep the connection stable across
        // sentences: a (re)connect happens only when the
        // format actually changed or the engine no longer
        // shows this player connected to the mixer — the
        // graph's word, not just our connectedFormat note.
        // The connection is still made WITHOUT stopping the
        // engine (v0.22.0's intent stands: stopping the shared
        // engine mid-call was the fragile operation both
        // silent builds shared) — what v0.27.0 adds is that
        // the reconnect must now prove itself below, before
        // anything is scheduled or played into it.
        if connectedFormat != playFormat || !isPlayerConnected {
            engine.disconnectNodeOutput(player)
            engine.connect(player, to: engine.mainMixerNode, format: playFormat)
            connectedFormat = playFormat
            onDiagnostic?("Playback path: voice processing \(voiceProcessing ? "on" : "off"), samples \(Self.describe(sourceFormat)) → playing \(Self.describe(playFormat)), engine \(engine.isRunning ? "running" : "stopped").")
        }
        // The rest of the chain (v0.27.2): the mixer's own
        // hop to the output node. The engine normally keeps
        // its main mixer connected to the output itself, so
        // this is a proof, not a construction — but a graph
        // the voice-processing unit has had its hands on is
        // exactly where an assumption deserves a check, and
        // if the hop is missing the standard connection is
        // restored. The format is left to the engine (nil):
        // the mixer's output format is whatever the graph's
        // format is, and naming one here could only disagree
        // with it.
        if !isMixerConnectedToOutput {
            engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)
        }
        guard isPlayerConnected else {
            throw NSError(domain: "GUS.Kokoro", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "The voice's player isn't connected into the call's audio — this sentence can't be played.",
            ])
        }
        guard engine.isRunning else {
            throw NSError(domain: "GUS.Kokoro", code: 11, userInfo: [
                NSLocalizedDescriptionKey: "The call's audio engine isn't running — this sentence can't be played.",
            ])
        }
        guard isMixerConnectedToOutput else {
            throw NSError(domain: "GUS.Kokoro", code: 12, userInfo: [
                NSLocalizedDescriptionKey: "The call's audio mixer isn't connected to the output — this sentence can't be played.",
            ])
        }
    }

    /// The connection as the engine itself reports it: this
    /// player, output bus 0, landing on the main mixer. This
    /// is the ground truth AVAudioPlayerNode's StartImpl
    /// checks when play() is called — so it is what
    /// ensurePlayable verifies, never our own bookkeeping
    /// about what we connected earlier.
    private var isPlayerConnected: Bool {
        engine.outputConnectionPoints(for: player, outputBus: 0)
            .contains { $0.node === engine.mainMixerNode }
    }

    /// The mixer's hop, read the same way from the same
    /// ground truth: the main mixer, output bus 0, landing
    /// on the engine's output node (v0.27.2 — the proof now
    /// walks the whole chain a played buffer travels).
    private var isMixerConnectedToOutput: Bool {
        engine.outputConnectionPoints(for: engine.mainMixerNode, outputBus: 0)
            .contains { $0.node === engine.outputNode }
    }

    /// A format in one short line, for the playback path's
    /// diagnostic record (v0.22.0).
    private static func describe(_ format: AVAudioFormat) -> String {
        "\(Int(format.sampleRate)) Hz, \(format.channelCount) ch"
    }

    /// One-shot sample-rate/channel conversion of a whole
    /// buffer (v0.19.0): Kokoro's 24 kHz mono floats into the
    /// shared engine's graph format, so the player can connect
    /// at a format the voice-processing output can render.
    /// The input buffer is handed over exactly once, then the
    /// stream is ended — the sentence is finite by design.
    private static func convertBuffer(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
        guard let converter = AVAudioConverter(from: buffer.format, to: format) else {
            throw NSError(domain: "GUS.Kokoro", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "Couldn't build an audio converter for the call's format.",
            ])
        }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
            throw NSError(domain: "GUS.Kokoro", code: 6, userInfo: [
                NSLocalizedDescriptionKey: "Couldn't build a converted audio buffer.",
            ])
        }
        var supplied = false
        var conversionError: NSError?
        let status = converter.convert(to: out, error: &conversionError) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .endOfStream
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if let conversionError { throw conversionError }
        guard status != .error else {
            throw NSError(domain: "GUS.Kokoro", code: 7, userInfo: [
                NSLocalizedDescriptionKey: "Audio conversion for the call failed.",
            ])
        }
        // An empty conversion is a failure, not a sentence
        // (v0.22.0): through v0.21.0 the converted buffer's
        // frame count was never checked, so a conversion that
        // produced zero frames would have been scheduled,
        // "finished" instantly, and counted as speech — one
        // more way to be silent with every signal green.
        guard out.frameLength > 0 else {
            throw NSError(domain: "GUS.Kokoro", code: 9, userInfo: [
                NSLocalizedDescriptionKey: "Audio conversion produced no samples (\(buffer.frameLength) frames in at \(Int(buffer.format.sampleRate)) Hz, 0 out at \(Int(format.sampleRate)) Hz).",
            ])
        }
        return out
    }

    func stop() {
        // Serialized with playSamples' graph sequence
        // (v0.27.0): a stop must never land between
        // ensurePlayable's verification and play() — that
        // interleave is the window the playable-state
        // guarantee closes.
        playLock.lock()
        if player.isPlaying { player.stop() }
        playLock.unlock()
        fireFinish()
    }

    private func fireFinish() {
        lock.lock()
        let callback = finish
        finish = nil
        playing = false
        lock.unlock()
        // The mouth settles as the buffer ends — emitted
        // only on the real (exactly-once) finish, and BEFORE
        // the callback, so a next sentence's level can never
        // be zeroed by this buffer's ending.
        if callback != nil { onLevelChange?(0) }
        callback?()
    }
}

// MARK: - Voice previews

/// The voice audition (v0.33.0, Glenn's ask): a play button
/// beside every voice in Settings and in the Personas tab
/// speaks a few words in that voice, on the spot — so a
/// voice is chosen by ear, not by entering a call, hearing
/// it, backing out, and trying the next. The preview NEVER
/// changes any selection: it synthesizes through the
/// runtime's named-voice path (the real engine — a first
/// preview of an unfetched voice includes its pack fetch,
/// which is the wait the button shows) and plays through
/// its OWN KokoroPlayer on its OWN private engine.
///
/// Why it cannot disturb a call: the call's playback rides
/// the call session's shared voice-processing engine (or
/// that player's own fallback), and this player is a
/// separate instance with a separate engine that no call
/// code ever touches — the only shared resource is the
/// synthesis manager, which the runtime's gate already
/// serializes. On top of the structural separation, the
/// preview is simply not offered while a call is live
/// (CallSession.isAnyCallLive — the buttons hide, and
/// toggle() refuses), and starting one sets the audio
/// session to plain playback, a state a call's own setup
/// (prepareCallAudio) fully reconfigures when it starts.
final class VoicePreviewPlayer: ObservableObject {
    static let shared = VoicePreviewPlayer()

    /// The voice currently being prepared or played, if any.
    @Published private(set) var activeVoiceID: String?
    /// True while the active preview is still synthesizing
    /// (or fetching its voice pack) — the button's spinner.
    @Published private(set) var isPreparing = false
    /// The last preview failure, in words, for the host
    /// view to show under its list. Cleared on the next try.
    @Published private(set) var lastError: String?

    private let player = KokoroPlayer()
    private var task: Task<Void, Never>?
    private var generation = 0

    /// Play this voice's line, or stop it if it's the one
    /// already sounding. Switching voices mid-preview stops
    /// the old one first — one audition at a time.
    func toggle(voice: KokoroVoice, line: String) {
        if activeVoiceID == voice.id {
            stop()
            return
        }
        guard !CallSession.isAnyCallLive else { return }
        stop()
        lastError = nil
        activeVoiceID = voice.id
        isPreparing = true
        generation += 1
        let gen = generation
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await KokoroRuntime.shared.synthesize(line, voice: voice.id)
                guard gen == self.generation else { return }
                // Plain playback for a few spoken words.
                // No call is live (checked above), and a
                // call that starts later reconfigures the
                // session for itself from the ground up.
                let session = AVAudioSession.sharedInstance()
                try? session.setCategory(.playback, mode: .default)
                try? session.setActive(true)
                self.publish { self.isPreparing = false }
                try self.player.playSamples(result.samples, sampleRate: result.sampleRate) { [weak self] in
                    guard let self, gen == self.generation else { return }
                    self.publish {
                        self.activeVoiceID = nil
                        self.isPreparing = false
                    }
                }
            } catch {
                guard gen == self.generation else { return }
                VoiceFailureLog.shared.recordInfo("Voice preview (\(voice.id)) failed: \(error.localizedDescription)")
                self.publish {
                    self.activeVoiceID = nil
                    self.isPreparing = false
                    self.lastError = "That voice couldn't speak just now: \(error.localizedDescription)"
                }
            }
        }
    }

    /// Silence the audition and forget it. A late synthesis
    /// or buffer completion from the stopped preview is
    /// generation-stale and lands nowhere.
    func stop() {
        generation += 1
        task?.cancel()
        task = nil
        player.stop()
        if activeVoiceID != nil || isPreparing {
            publish {
                self.activeVoiceID = nil
                self.isPreparing = false
            }
        }
    }

    /// Published state is read by views, so it is written on
    /// the main queue — synthesis and playback complete on
    /// their own threads.
    private func publish(_ change: @escaping () -> Void) {
        if Thread.isMainThread {
            change()
        } else {
            DispatchQueue.main.async(execute: change)
        }
    }
}
