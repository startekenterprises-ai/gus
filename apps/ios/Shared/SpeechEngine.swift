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
    /// (v0.17.1 synthesize-ahead): the samples wait in the
    /// engine until speak() asks for this exact text, which
    /// then starts playing with no synthesis wait. Preparing
    /// never makes sound on its own, and a sentence the call
    /// session has not cleared to speak is never prepared —
    /// the session scans first, exactly as it always has.
    func prepare(_ text: String)
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

    private let player = KokoroPlayer()
    private let lock = NSLock()
    private var generation = 0
    private var pendingFinish: (() -> Void)?
    private var synthTask: Task<Void, Never>?

    /// Playback-start hook (v0.17.1): fired from speak()'s
    /// task the moment a sentence's samples are scheduled
    /// and playing — see the protocol note.
    var onPlaybackStarted: (() -> Void)?

    // Synthesize-ahead slot (v0.17.1): at most one prepared
    // utterance, keyed by its exact text. speak() consumes
    // it only for that text; stopSpeaking() discards it, so
    // a barged-in lineup can never make sound afterwards.
    private var prepareTask: Task<PreparedSpeech, Error>?
    private var preparedText: String?

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

    /// Start synthesizing `text` into the ahead slot (see
    /// the protocol note). A repeat call for the text already
    /// lined up is a no-op; a different text replaces the
    /// slot. Synthesis still passes the runtime's
    /// one-at-a-time gate, so a lineup never asks the manager
    /// for two utterances at once — it runs while the
    /// previous sentence PLAYS, which is the whole point:
    /// playback used to wait out this exact latency in
    /// silence between every pair of sentences.
    func prepare(_ text: String) {
        lock.lock()
        if preparedText == text, prepareTask != nil {
            lock.unlock()
            return
        }
        prepareTask?.cancel()
        preparedText = text
        prepareTask = Task {
            let result = try await KokoroRuntime.shared.synthesize(text)
            return PreparedSpeech(samples: result.samples, sampleRate: result.sampleRate)
        }
        lock.unlock()
    }

    func speak(_ text: String, onFinished: @escaping () -> Void) {
        lock.lock()
        generation += 1
        let gen = generation
        pendingFinish = onFinished
        // Consume the synthesize-ahead slot when it holds
        // this exact sentence: its samples are ready, or its
        // synthesis is still in flight and this task joins it
        // instead of synthesizing the same words twice.
        var preparation: Task<PreparedSpeech, Error>?
        if preparedText == text {
            preparation = prepareTask
            prepareTask = nil
            preparedText = nil
        }
        lock.unlock()

        synthTask = Task { [weak self] in
            guard let self else { return }
            do {
                let speech: PreparedSpeech
                if let preparation {
                    speech = try await preparation.value
                } else {
                    let result = try await KokoroRuntime.shared.synthesize(text)
                    speech = PreparedSpeech(samples: result.samples, sampleRate: result.sampleRate)
                }
                guard self.isCurrent(gen) else { return }
                try self.player.playSamples(speech.samples, sampleRate: speech.sampleRate) { [weak self] in
                    self?.finish(gen)
                }
                // The sentence is making sound — tell the
                // session, so it can line up the next one.
                self.onPlaybackStarted?()
            } catch {
                // A barge-in cancel is not an engine failure —
                // never let it mark the runtime broken.
                if !(error is CancellationError), !Task.isCancelled {
                    KokoroRuntime.shared.noteSynthesisFailure(error)
                }
                self.finish(gen)
            }
        }
    }

    func stopSpeaking() {
        lock.lock()
        generation += 1
        let gen = generation
        let stalePreparation = prepareTask
        prepareTask = nil
        preparedText = nil
        lock.unlock()
        stalePreparation?.cancel()
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
    static func resolve(_ preferred: SpeechEngineKind = .preferred) -> SpeechEngine {
        if preferred != .kokoro {
            let optIn = StudioVoiceEngine()
            if optIn.kind == preferred, optIn.isAvailable { return optIn }
        }
        return KokoroSpeechEngine()
    }
}
