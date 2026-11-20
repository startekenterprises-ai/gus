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

// MARK: - Sample playback

/// Plays Kokoro's float samples through an AVAudioEngine
/// player node, with the seam's exactly-once finish contract:
/// the completion fires when the buffer ends OR when stop()
/// cuts it — whichever first, and never twice. (Whether
/// AVAudioPlayerNode calls a stopped buffer's completion
/// handler has varied across iOS versions; this class does
/// not depend on the answer.)
final class KokoroPlayer {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var attached = false
    private var connectedFormat: AVAudioFormat?
    private let lock = NSLock()
    private var finish: (() -> Void)?
    private var playing = false

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

        if !attached {
            engine.attach(player)
            attached = true
        }
        if connectedFormat != format {
            if engine.isRunning { engine.stop() }
            engine.disconnectNodeOutput(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            connectedFormat = format
        }

        lock.lock()
        finish = onFinished
        playing = true
        lock.unlock()

        player.scheduleBuffer(buffer) { [weak self] in
            self?.fireFinish()
        }
        if !engine.isRunning {
            try engine.start()
        }
        player.play()
        onLevelChange?(level)
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
