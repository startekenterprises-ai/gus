import AVFoundation
import Foundation

// The call's speech-out seam (v0.15.0, R4 — spec: voice
// architecture). Two engines behind one protocol:
//
//   .kokoro      — THE voice (v0.15.4). Kokoro on-device (open
//                  weights, 82M): near-human, free, nothing
//                  leaves the phone. CoreML through FluidAudio
//                  (see KokoroTTS.swift for why not ONNX
//                  Runtime — Microsoft's repos vanished
//                  2026-11-18). It prepares itself: warm-up
//                  starts on its own when the app opens, and a
//                  sentence that arrives early waits for it.
//                  There is NO fallback voice behind it — the
//                  Apple voice that used to catch a cold
//                  Kokoro is removed (Glenn, 2026-11-20: the
//                  "default cheesy computer voice lady" is
//                  not GUS's voice, and the silent swap hid
//                  the one setup tap that mattered).
//   .studioVoice — the OPT-IN. ElevenLabs-class cloud fidelity
//                  for operators who choose it, clearly labeled
//                  cloud + paid wherever it appears. Not
//                  configured in this build; picking it today
//                  still resolves to Kokoro.
//
// Everything GUS says on the phone passes the core's spoken-form
// layer before it reaches this seam (v0.14.7) — plain speech, no
// jargon, no token talk — in Core mode. On-device mode will apply
// the same rules locally when the local engine lands.

enum SpeechEngineKind: String, CaseIterable, Identifiable {
    case kokoro
    case studioVoice

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .kokoro: return "Kokoro — on this iPhone"
        case .studioVoice: return "Studio Voice — cloud, paid (opt-in)"
        }
    }

    /// The operator's preference, persisted. Default: Kokoro.
    /// (A persisted "apple" from a pre-0.15.4 build no longer
    /// parses and degrades to .kokoro — the intended landing.)
    static var preferred: SpeechEngineKind {
        get {
            let raw = UserDefaults.standard.string(forKey: "gus.voice.engine") ?? ""
            return SpeechEngineKind(rawValue: raw) ?? .kokoro
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "gus.voice.engine") }
    }
}

protocol SpeechEngine: AnyObject {
    var kind: SpeechEngineKind { get }
    /// Can this engine actually speak right now? Kokoro answers
    /// with its runtime's real readiness; the resolver uses it
    /// to honor a configured opt-in (Studio). Kokoro itself is
    /// always the resolution when nothing else can speak — its
    /// speak() waits out the warm-up rather than answering
    /// false into silence.
    var isAvailable: Bool { get }
    var isSpeaking: Bool { get }
    /// Playback amplitude, 0...1, for the call screen's
    /// animated avatar (v0.15.5): an engine that plays real
    /// samples reports the level of each utterance as it
    /// starts and returns it to 0 as it ends; an engine
    /// with nothing to report leaves this unset. Purely a
    /// view concern — resolution and speech never depend
    /// on it.
    var onLevelChange: ((Float) -> Void)? { get set }
    /// Fired when a sentence's audio actually starts playing
    /// (v0.17.1) — the call session lines up the next
    /// sentence's synthesis on this signal, because at that
    /// moment the current sentence's synthesis is done and
    /// the synthesizer is free. Never fired for a sentence
    /// that was cut before it made sound.
    var onPlaybackStarted: (() -> Void)? { get set }
    /// Begin synthesizing a sentence before its turn to play
    /// (v0.17.1 synthesize-ahead; the lineup deepened to two
    /// in v0.17.4): the samples wait in the engine until
    /// speak() asks for this exact text, which then starts
    /// playing with no synthesis wait. The session may line
    /// up the next TWO sentences behind the one playing —
    /// each prepare() call is one lineup entry, in speaking
    /// order. Preparing never makes sound on its own, and a
    /// sentence the call session has not cleared to speak is
    /// never prepared — the session scans first, exactly as
    /// it always has.
    func prepare(_ text: String)
    /// Prove the call's playback graph before the first
    /// sentence, and settle which graph this call speaks
    /// through (v0.29.1 — see KokoroPlayer.primeCallAudio
    /// for the field evidence): the session calls this once
    /// at call setup, after the audio session is configured
    /// and voice processing is enabled, before hearing
    /// starts. An engine with no playback graph of its own
    /// to prove (Studio) does nothing.
    func primeCallAudio()
    /// Speak one sentence; onFinished fires exactly once —
    /// when the sentence ends OR is cut by stopSpeaking().
    func speak(_ text: String, onFinished: @escaping () -> Void)
    func stopSpeaking()
}

// MARK: - Kokoro (default; on-device CoreML — KokoroTTS.swift)

/// One utterance synthesized ahead of playback (v0.17.1):
/// Kokoro's samples for a sentence, waiting for speak() to
/// ask for that sentence by its exact text.
struct PreparedSpeech {
    let samples: [Float]
    let sampleRate: Double
}

final class KokoroSpeechEngine: SpeechEngine {
    let kind: SpeechEngineKind = .kokoro

    private let player: KokoroPlayer

    /// The call's shared audio engine, when the session hands
    /// one in (v0.18.0 — see KokoroPlayer's note): playback
    /// rides the same engine that captures the microphone, so
    /// the system's echo canceller can hear what it must
    /// subtract. No engine handed in: the player makes its
    /// own, exactly as before.
    init(engine: AVAudioEngine = AVAudioEngine()) {
        player = KokoroPlayer(engine: engine)
        // Playback diagnostics (v0.22.0): the player's
        // per-connection path note lands in the shared voice
        // log — the record the call screen and Settings →
        // About read when a call goes silent.
        player.onDiagnostic = { line in VoiceFailureLog.shared.recordInfo(line) }
        // Caught play() exceptions (v0.27.2): the containment
        // shim's catches are FAILURES in the log, with the
        // exception's name and reason verbatim — the words
        // Settings → About was missing through two crashes.
        player.onPlaybackException = { line in VoiceFailureLog.shared.recordFailure(line) }
    }
    private let lock = NSLock()
    private var generation = 0
    private var pendingFinish: (() -> Void)?
    private var synthTask: Task<Void, Never>?

    /// Playback-start hook (v0.17.1): fired from speak()'s
    /// task the moment a sentence's samples are scheduled
    /// and playing — see the protocol note.
    var onPlaybackStarted: (() -> Void)?

    // Synthesize-ahead lineup (v0.17.1, two deep since
    // v0.17.4): up to two prepared utterances waiting behind
    // the one playing, each keyed by its exact text, in the
    // order the session lined them up. speak() consumes the
    // oldest entry for its text; stopSpeaking() discards
    // them all, so a barged-in lineup can never make sound
    // afterwards.
    private var preparedLineup: [(text: String, task: Task<PreparedSpeech, Error>)] = []
    private let preparedLineupLimit = 2

    /// The avatar's level, straight from the player: the
    /// player owns the samples, so it owns the level.
    var onLevelChange: ((Float) -> Void)? {
        get { player.onLevelChange }
        set { player.onLevelChange = newValue }
    }

    /// Available ONLY when the runtime is genuinely ready —
    /// assets downloaded, hash-verified by the SDK, models
    /// loaded. Anything less and a sentence waits for the
    /// warm-up instead (KokoroTTS.swift's awaitReady) — there
    /// is no other voice to hand it to.
    var isAvailable: Bool { KokoroRuntime.shared.isReady }
    var isSpeaking: Bool { player.isPlaying || synthTask != nil }

    /// The call-start audio proof (v0.29.1): the player's
    /// prime settles — once, for the whole call — whether
    /// speech rides the call's shared voice-processing
    /// engine or the player's private fallback engine. The
    /// outcome lands in the voice log either way (the
    /// player's onDiagnostic wiring above).
    func primeCallAudio() {
        player.primeCallAudio()
    }

    /// Start synthesizing `text` into the ahead lineup (see
    /// the protocol note). Each call adds one entry — the
    /// session lines each sentence up exactly once, in
    /// speaking order — and a call past the lineup's depth
    /// is ignored: two sentences behind the one playing is
    /// the whole lineup. Synthesis still passes the runtime's
    /// one-at-a-time gate, so a lineup never asks the manager
    /// for two utterances at once — the entries synthesize
    /// in order while earlier sentences PLAY, which is the
    /// whole point: playback used to wait out this exact
    /// latency in silence between every pair of sentences.
    func prepare(_ text: String) {
        lock.lock()
        guard preparedLineup.count < preparedLineupLimit else {
            lock.unlock()
            return
        }
        let task = Task {
            let result = try await KokoroRuntime.shared.synthesize(text)
            return PreparedSpeech(samples: result.samples, sampleRate: result.sampleRate)
        }
        preparedLineup.append((text: text, task: task))
        lock.unlock()
    }

    func speak(_ text: String, onFinished: @escaping () -> Void) {
        lock.lock()
        generation += 1
        let gen = generation
        pendingFinish = onFinished
        // Consume the synthesize-ahead lineup's oldest entry
        // for this exact sentence when one is waiting: its
        // samples are ready, or its synthesis is still in
        // flight and this task joins it instead of
        // synthesizing the same words twice. Entries for
        // other sentences stay lined up behind this one.
        var preparation: Task<PreparedSpeech, Error>?
        if let index = preparedLineup.firstIndex(where: { $0.text == text }) {
            preparation = preparedLineup[index].task
            preparedLineup.remove(at: index)
        }
        lock.unlock()

        synthTask = Task { [weak self] in
            guard let self else { return }
            // Stage 1 — synthesis. A failure here is the
            // runtime's business, as it has always been: it
            // marks Kokoro failed, so the failure surfaces in
            // words (Settings shows it) instead of the engine
            // being retried sentence after sentence.
            let speech: PreparedSpeech
            do {
                if let preparation {
                    speech = try await preparation.value
                } else {
                    let result = try await KokoroRuntime.shared.synthesize(text)
                    speech = PreparedSpeech(samples: result.samples, sampleRate: result.sampleRate)
                }
            } catch {
                // A barge-in cancel is not an engine failure —
                // never let it mark the runtime broken.
                if !(error is CancellationError), !Task.isCancelled {
                    KokoroRuntime.shared.noteSynthesisFailure(error)
                }
                self.finish(gen)
                return
            }
            guard self.isCurrent(gen) else { return }
            // Stage 2 — playback (v0.22.0). A failure here is
            // NOT a synthesis failure, and through v0.21.0 it
            // was treated as one: playSamples' throw landed in
            // the same catch as synthesis, noteSynthesisFailure
            // poisoned the runtime, and every later sentence's
            // synthesis then threw instantly in awaitReady —
            // one playback hiccup silenced the whole call while
            // the text kept flowing, with the reason visible
            // nowhere. Now a playback failure is recorded with
            // its error and this sentence finishes; the runtime
            // stays healthy, and the next sentence plays — or
            // fails logged, never silently.
            do {
                try self.player.playSamples(speech.samples, sampleRate: speech.sampleRate) { [weak self] in
                    self?.finish(gen)
                }
            } catch {
                VoiceFailureLog.shared.recordFailure("Playback failed: \(error.localizedDescription)")
                self.finish(gen)
                return
            }
            // The sentence is making sound — tell the
            // session, so it can line up the next one.
            self.onPlaybackStarted?()
        }
    }

    func stopSpeaking() {
        lock.lock()
        generation += 1
        let gen = generation
        let staleLineup = preparedLineup
        preparedLineup = []
        lock.unlock()
        // The whole lineup dies with the speech (barge-in):
        // every prepared or in-flight synthesis is cancelled,
        // so nothing lined up can make sound afterwards.
        for entry in staleLineup { entry.task.cancel() }
        synthTask?.cancel()
        synthTask = nil
        player.stop()
        finish(gen)
    }

    private func isCurrent(_ gen: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return gen == generation
    }

    /// The seam's exactly-once contract, generation-scoped: a
    /// cut sentence's late completion can never fire the NEXT
    /// sentence's callback.
    private func finish(_ gen: Int) {
        lock.lock()
        guard gen == generation, let callback = pendingFinish else {
            lock.unlock()
            return
        }
        pendingFinish = nil
        synthTask = nil
        lock.unlock()
        callback()
    }
}

// MARK: - Studio Voice (opt-in cloud; not configured)

final class StudioVoiceEngine: SpeechEngine {
    let kind: SpeechEngineKind = .studioVoice
    // Opt-in only, and only once the operator configures their
    // own cloud key in a later chunk. Never the default.
    var isAvailable: Bool { false }
    var isSpeaking: Bool { false }
    /// Nothing plays in this build, so there is no level to
    /// report — the avatar's mouth simply stays settled.
    var onLevelChange: ((Float) -> Void)?
    /// Nothing plays in this build, so no playback ever
    /// starts and there is nothing to prepare ahead.
    var onPlaybackStarted: (() -> Void)?
    func prepare(_ text: String) {}
    /// Nothing plays in this build, so there is no playback
    /// graph to prime.
    func primeCallAudio() {}
    func speak(_ text: String, onFinished: @escaping () -> Void) { onFinished() }
    func stopSpeaking() {}
}

// MARK: - Resolution

/// Resolves the operator's preferred engine. Kokoro is the
/// floor: the preferred engine wins only when it can actually
/// speak (today that means a configured Studio Voice), and
/// everything else resolves to the Kokoro engine — whose
/// speak() waits out the self-preparation rather than
/// borrowing another voice. Resolution never fails and never
/// returns a fallback voice, because there isn't one.
enum SpeechEngineResolver {
    static func resolve(_ preferred: SpeechEngineKind = .preferred,
                        callAudioEngine: AVAudioEngine? = nil) -> SpeechEngine {
        if preferred != .kokoro {
            let optIn = StudioVoiceEngine()
            if optIn.kind == preferred, optIn.isAvailable { return optIn }
        }
        return KokoroSpeechEngine(engine: callAudioEngine ?? AVAudioEngine())
    }
}
