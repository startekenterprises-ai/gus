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
/// the female default Glenn picked, the male options he
/// asked for the same night, and two British voices for
/// range. The selection persists in UserDefaults; warm-up
/// preloads the selected voice's pack, and the SDK fetches
/// any other pack on demand (~0.5 MB) the first time that
/// voice is used.
struct KokoroVoice: Identifiable, Equatable, Hashable {
    let id: String
    let displayName: String

    static let all: [KokoroVoice] = [
        KokoroVoice(id: "af_heart", displayName: "Heart — female (default)"),
        KokoroVoice(id: "af_bella", displayName: "Bella — female"),
        KokoroVoice(id: "af_nicole", displayName: "Nicole — female"),
        KokoroVoice(id: "am_michael", displayName: "Michael — male"),
        KokoroVoice(id: "am_fenrir", displayName: "Fenrir — male"),
        KokoroVoice(id: "am_puck", displayName: "Puck — male"),
        KokoroVoice(id: "bf_emma", displayName: "Emma — British female"),
        KokoroVoice(id: "bm_george", displayName: "George — British male"),
    ]

    /// The simple level (v0.23.0): three voices up front —
    /// Heart (the default), Emma (a clearly different voice:
    /// British, where Heart is American), and Michael (the
    /// male voice). The full eight stay one disclosure away
    /// in Settings. Michael has been in the catalog since
    /// v0.15.4 and rides the same delivery as every voice:
    /// warm-up preloads the SELECTED voice's pack, and the
    /// SDK fetches any other pack on demand (~0.5 MB) the
    /// first time that voice speaks — no separate asset
    /// pipeline exists or is needed.
    static let curated: [KokoroVoice] = [
        KokoroVoice(id: "af_heart", displayName: "Heart — female (default)"),
        KokoroVoice(id: "bf_emma", displayName: "Emma — British female"),
        KokoroVoice(id: "am_michael", displayName: "Michael — male"),
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

    /// The operator's pick, persisted. Default: af_heart.
    static var selected: KokoroVoice {
        get {
            let raw = UserDefaults.standard.string(forKey: "gus.voice.kokoroVoice") ?? ""
            return all.first(where: { $0.id == raw }) ?? all[0]
        }
        set { UserDefaults.standard.set(newValue.id, forKey: "gus.voice.kokoroVoice") }
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
        try await awaitReady()
        guard let manager else {
            throw NSError(domain: "GUS.Kokoro", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Kokoro is not ready.",
            ])
        }
        await gate.acquire()
        do {
            let result = try await manager.synthesizeDetailed(text: text, voice: KokoroVoice.selected.id)
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
    private let engine: AVAudioEngine
    private let player = AVAudioPlayerNode()
    private var attached = false
    private var connectedFormat: AVAudioFormat?
    private let lock = NSLock()
    private var finish: (() -> Void)?
    private var playing = false

    /// The engine is the CALL's shared engine when one is
    /// handed in (v0.18.0): playback and the microphone must
    /// live on the SAME engine for the system's voice
    /// processing to cancel GUS's own voice out of the mic —
    /// the echo canceller subtracts the output of its own
    /// engine, so sound played through a private engine is
    /// uncancellable by construction. Constructions with no
    /// call behind them keep a private engine, as before.
    init(engine: AVAudioEngine = AVAudioEngine()) {
        self.engine = engine
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

    var isPlaying: Bool {
        lock.lock()
        defer { lock.unlock() }
        return playing
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

        if !attached {
            engine.attach(player)
            // Full scale, stated rather than assumed (v0.18.0):
            // nothing in the playback path turns the call down.
            engine.mainMixerNode.outputVolume = 1.0
            attached = true
        }
        if connectedFormat != playFormat {
            // The connection is made WITHOUT stopping the
            // engine (v0.22.0 — the second silent-call fix).
            // Through v0.19.0 this branch stopped the call's
            // shared engine — live recognizer tap installed,
            // voice-processing unit engaged — and restarted it
            // with try engine.start(). That restart is the one
            // fragile operation both silent builds share and
            // the singing pre-0.18.0 code never performed: its
            // private engine was stopped at connect time and
            // started exactly once, with nothing else attached.
            // A disconnect/connect on a running engine is
            // applied by AVAudioEngine dynamically, and the
            // mic tap lives on the input node, untouched here.
            // The engine is only ever started below, when it
            // is not running at all (the player's private
            // engine, or a call whose hearing never started
            // it) — never stopped and restarted mid-call.
            engine.disconnectNodeOutput(player)
            engine.connect(player, to: engine.mainMixerNode, format: playFormat)
            connectedFormat = playFormat
            onDiagnostic?("Playback path: voice processing \(voiceProcessing ? "on" : "off"), samples \(Self.describe(format)) → playing \(Self.describe(playFormat)), engine \(engine.isRunning ? "running" : "stopped").")
        }

        lock.lock()
        finish = onFinished
        playing = true
        lock.unlock()

        player.scheduleBuffer(playBuffer) { [weak self] in
            self?.fireFinish()
        }
        if !engine.isRunning {
            try engine.start()
        }
        player.play()
        onLevelChange?(level)
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
        if player.isPlaying { player.stop() }
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
