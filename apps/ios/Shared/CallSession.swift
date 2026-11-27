import AVFoundation
import Foundation
import ShieldKit
import Speech

// The live call (v0.15.0, R4) — a REAL call, never push-to-talk
// (Glenn's ruling, 2026-11-19): tap Call, talk, interrupt GUS
// mid-sentence and it stops and listens. This class owns the
// phone side of the panel's voice-session protocol (v0.9.1,
// the same one the Mac app speaks):
//
//   start      → POST /api/voice/session/start — the core
//                resolves the call's speech modes by probe.
//   hearing    → sttMode "local": this phone's Speech
//                recognizer (on-device whenever the system
//                allows) streams partials for the live strip;
//                finals go up as session transcripts. sttMode
//                "endpoint": mic buffers convert to PCM16 and
//                stream to the core as audio chunks.
//   speaking   → the playback pump polls next-audio in seq
//                order: audio segments play as audio; text
//                segments (built-in TTS mode) are spoken by the
//                resolved SpeechEngine — Kokoro, the call's only
//                built-in voice (the Apple fallback voice was
//                removed in v0.15.4, Glenn's ruling).
//   barge-in   → a final/partial transcript while GUS is
//                speaking cuts local playback AND posts the
//                session interrupt, so unfetched sentences are
//                dropped unsaid on the core too.
//   end        → POST /api/voice/session/end; the audio
//                session deactivates.
//
// The on-device transport (chunk 2) runs behind this same
// state machine: same recognizer, same phases, same speech
// seams, same barge-in — only where a turn is answered
// differs. In on-device mode (the default for calls) the
// phone's own LocalBrain answers and the resolved SpeechEngine
// speaks, with no core session at all: the call works in
// airplane mode. Core mode is byte-for-byte the chunk-1
// behavior above.

/// Where a call's brain lives. On-device is the default (the
/// spec: on-device mode is the default for calls and the demo);
/// Core hands the call to the operator's GUS core exactly as
/// chunk 1 built it. Persisted; Settings carries the picker.
enum CallMode: String, CaseIterable, Identifiable {
    case onDevice
    case core

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .onDevice: return "On-device — brain and voice on this iPhone"
        case .core: return "Core — brain on your GUS core"
        }
    }

    static var preferred: CallMode {
        get {
            let raw = UserDefaults.standard.string(forKey: "gus.call.mode") ?? ""
            return CallMode(rawValue: raw) ?? .onDevice
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "gus.call.mode") }
    }
}

/// A user turn held by Agent Shield (v0.15.7): the scanned
/// text and the rule that caught it, for the call screen's
/// override prompt. The receipt is already written by the time
/// this exists — the prompt is the operator's one-time decision
/// about THIS turn, not a re-scan.
struct ShieldQuarantine {
    let text: String
    let ruleID: String
}

@MainActor
final class CallSession: NSObject, ObservableObject {
    enum Phase { case idle, connecting, live, ended }

    @Published private(set) var phase: Phase = .idle
    /// The core's word for the moment: listening | thinking |
    /// speaking | ended — drives the call screen's status line.
    @Published private(set) var corePhase: String = ""
    @Published private(set) var liveTranscript: String = ""
    @Published private(set) var turns: [VoiceSessionState.Turn] = []
    @Published private(set) var isMuted: Bool = false
    /// Output route: speaker (the default — calls start on
    /// speaker) or earpiece, toggled from the call screen.
    @Published private(set) var isSpeakerOn: Bool = true
    @Published private(set) var gusSpeaking: Bool = false
    /// Kokoro's playback amplitude, 0...1 — the call
    /// screen's avatar moves its mouth with this (v0.15.5).
    /// Fed once per utterance by the speech engine, from
    /// the samples it is already playing; zero whenever
    /// GUS is not speaking. Nothing in the hearing path
    /// (recognizer, watchdog, echo guard) ever reads it.
    @Published private(set) var voiceLevel: Float = 0
    /// Which transport this call is running (CallView captions
    /// it, so the operator can SEE where the brain lives).
    @Published private(set) var callMode: CallMode = CallMode.preferred
    /// A note about the voice, when there is one: the core's
    /// speech notice, or the local note that Kokoro is still
    /// getting ready (it prepares itself; the first sentence
    /// of a first call waits for it — there is no fallback
    /// voice to borrow in the meantime).
    @Published private(set) var speechNotice: String?
    /// A user turn Shield quarantined (v0.15.7): held before
    /// the brain ever saw it, waiting on the operator's
    /// one-time override or drop on the call screen. While a
    /// turn is held, new finals wait — the held turn takes
    /// precedence. Always nil when Shield is off, in Strict
    /// (quarantine is block there), and in Permissive (nothing
    /// is ever held).
    @Published var pendingShieldQuarantine: ShieldQuarantine?
    @Published var errorText: String?

    private let client = GUSClient.shared
    private var sessionId: String?
    private var sttMode: String = "local"

    // On-device transport (chunk 2): the local brain, its
    // in-flight answer, and the sentence pump that speaks the
    // answer while it is still generating.
    private enum Transport { case core, local }
    private var transport: Transport = .core
    private var localBrain: LocalBrain?
    private var localAnswerTask: Task<Void, Never>?
    private var localPumpTask: Task<Void, Never>?
    private var localSentenceQueue: [String] = []
    private var localGenerationDone = true
    private var localCompletedReply: String?
    private var localTurnCounter = 0
    // Synthesize-ahead lineup (v0.17.1; two deep since
    // v0.17.4): the Shield verdicts for the next sentences
    // in the local queue, scanned early — while an earlier
    // sentence is still playing — so their synthesis can
    // run ahead of playback instead of inside the silent
    // gap after it. The lineup always describes a PREFIX of
    // the queue, in order: entry i is the verdict for queue
    // sentence i, and the pump consumes the front entry
    // when it pops that sentence. One scan, one receipt per
    // sentence, always before its synthesis and speech. A
    // sentence recorded blocked here is never prepared; the
    // pump speaks the canned line for it at pop time,
    // exactly as a pop-time block is handled.
    private var preparedLineup: [(text: String, blocked: Bool)] = []
    private let preparedLineupDepth = 2
    private var speaker: SpeechEngine = SpeechEngineResolver.resolve()
    private var pollTask: Task<Void, Never>?
    private var playbackTask: Task<Void, Never>?
    private var lastSeq: Int = 0

    // Hearing (local recognizer).
    private let audioEngine = AVAudioEngine()
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionGeneration: Int = 0
    // End-of-speech watchdog (v0.15.2): with on-device
    // recognition the system withholds `isFinal` until the
    // audio request ends — in a live call that can mean never
    // (field report 2026-11-20: perfect live transcripts, zero
    // completed turns, no reply in any mode, because a turn
    // only dispatches on a final). A partial that has stopped
    // changing for a beat IS the end of the utterance: the
    // watchdog dispatches it as the final and restarts the
    // recognizer (the generation guard drops the stale task's
    // own late final, so nothing double-fires).
    private var lastPartialText = ""
    private var lastPartialChangeAt = Date()
    private var watchdogTask: Task<Void, Never>?
    // Echo guard (v0.15.3): on speaker, the recognizer hears
    // GUS's own voice. Unguarded, the echo reads as barge-in
    // (cutting the reply mid-sentence) and then, frozen as a
    // partial, as a fresh turn — GUS answering himself, the
    // cut-and-repeat loop in the 2026-11-20 field report.
    // Partials that match what is being spoken, or what was
    // spoken in the last two seconds, are echo and are
    // ignored entirely: never barge-in, never a turn.
    private var speakingText = ""
    private var lastSpokenText = ""
    private var lastSpokenAt = Date.distantPast
    // System voice processing (v0.18.0): enabled on the call
    // engine's input node in startHearing, before the tap is
    // installed — the Voice Processing I/O unit's echo
    // cancellation, noise suppression and automatic gain.
    // Playback shares this same engine (the session hands it
    // to the speech engine in startCall), which is what gives
    // the canceller its reference: it subtracts the engine's
    // own output from the mic. Set once per engine; the
    // setting survives the engine's stops and restarts.
    private var voiceProcessingEnabled = false
    // Barge-in debounce (v0.18.0): the first partial heard
    // while GUS is speaking is only a CANDIDATE cut — see
    // bargeInConfirmed. Residual echo and recognizer
    // fragments arrive as lone partials; a person talking
    // over GUS sustains theirs.
    private var bargeCandidateText = ""
    private var bargeCandidateAt = Date.distantPast

    // Hearing (endpoint mode): mic buffers → PCM16 chunks.
    private var pcmConverter: AVAudioConverter?
    private var pendingPCM = Data()
    private static let pcmTargetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)

    // Speaking (audio segments).
    private var audioPlayer: AVAudioPlayer?
    private var segmentContinuation: CheckedContinuation<Void, Never>?
    // Playback failures this call (v0.22.0): speakText counts
    // what VoiceFailureLog gained while a sentence was being
    // spoken; at two, the call screen says so in plain words
    // instead of letting the call run silent to its end.
    private var playbackFailuresThisCall = 0

    // MARK: - Lifecycle

    func startCall() {
        guard phase == .idle || phase == .ended else { return }
        phase = .connecting
        errorText = nil
        liveTranscript = ""
        turns = []
        lastSeq = 0
        playbackFailuresThisCall = 0
        callMode = CallMode.preferred
        // The call's ONE audio engine (v0.18.0): this session's
        // hearing engine is handed to the speech engine, so
        // Kokoro playback and the microphone share an engine —
        // the precondition for system echo cancellation (see
        // the voice-processing note at the properties).
        speaker = SpeechEngineResolver.resolve(callAudioEngine: audioEngine)
        // The avatar's mouth (v0.15.5): the engine reports
        // the level of the samples it plays; hop to the main
        // actor and publish. Once per utterance — never per
        // frame, and the hearing paths never see it.
        speaker.onLevelChange = { [weak self] level in
            Task { @MainActor in self?.voiceLevel = level }
        }
        // Synthesize-ahead (v0.17.1; two deep since
        // v0.17.4): when a sentence starts playing, top the
        // lineup up behind it, so playback stops starving
        // between sentences. In Core mode the lineup is a
        // no-op (there is no local sentence queue; the core's
        // pump is unchanged).
        speaker.onPlaybackStarted = { [weak self] in
            Task { @MainActor in self?.prepareNextLocalSentence() }
        }
        speechNotice = nil
        // Kokoro prepares itself: warm-up starts on its own
        // when the signed-in shell opens, and a call that
        // arrives before it finishes kicks it here. There is
        // no other built-in voice to borrow while it gets
        // ready (Glenn, 2026-11-20 — the Apple fallback voice
        // is gone), so the notice says the voice is getting
        // ready, and the first sentence simply waits for it:
        // KokoroRuntime.synthesize joins the warm-up.
        if !KokoroRuntime.shared.isReady {
            KokoroRuntime.shared.warmUp()
            speechNotice = "Getting your voice ready — Kokoro prepares itself once, then it's just ready."
        }
        if callMode == .onDevice {
            Task { await connectLocal() }
        } else {
            Task { await connect() }
        }
    }

    /// Permissions + the call's audio session — identical for
    /// both transports; a call that cannot hear or be heard
    /// fails here, in words, not mid-sentence.
    private func prepareCallAudio() async -> Bool {
        let speechStatus = await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
        }
        guard speechStatus == .authorized else {
            fail("Speech recognition isn't allowed for GUS — enable it in Settings → GUS → Speech Recognition, then call again.")
            return false
        }
        let micGranted = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            AVAudioSession.sharedInstance().requestRecordPermission { c.resume(returning: $0) }
        }
        guard micGranted else {
            fail("The microphone isn't allowed for GUS — enable it in Settings → GUS → Microphone, then call again.")
            return false
        }
        do {
            let session = AVAudioSession.sharedInstance()
            // Mode .default, NOT .voiceChat (v0.18.0, the quiet-
            // call fix): .voiceChat puts the session on the
            // voice-processing path, whose output gain is staged
            // for handset voice chat — through the speaker it
            // caps the call well below what the same samples
            // play at in .default, which is why the v0.15.4 gain
            // stage (samples peak-normalized to 0.89, near full
            // scale) still sounded soft and why the speaker
            // toggle barely changed anything. And .voiceChat
            // never gave this app echo cancellation in return:
            // AVAudioEngine clients get AEC from the ENGINE's
            // voice processing (startHearing enables it), which
            // is specified against the .default mode. Full-
            // volume speaker output from .default; echo
            // cancellation from the engine. Both, not either.
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            // Speaker means speaker (v0.22.0): .defaultToSpeaker
            // is a preference the system can quietly drop —
            // engaging the engine's voice processing puts the
            // session on the handset-voice path, and nothing in
            // the call ever reasserted the route, so output
            // could land in the receiver while every screen
            // said "speaker" (at arm's length: silence, with
            // the level meter still moving). Assert the port
            // outright when speaker is on; startHearing
            // reasserts it at every hearing start, and the
            // route the system reports is written to the voice
            // log, so a field report can see where sound went.
            if isSpeakerOn {
                try? session.overrideOutputAudioPort(.speaker)
            }
            VoiceFailureLog.shared.recordInfo("Call route: \(session.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ", ")) — speaker \(isSpeakerOn ? "on" : "off").")
        } catch {
            fail("The call's audio couldn't be set up: \(error.localizedDescription)")
            return false
        }
        return true
    }

    private func connect() async {
        guard await prepareCallAudio() else { return }
        transport = .core
        do {
            let state = try await client.voiceSessionStart()
            guard state.ok, let id = state.sessionId else {
                fail(state.detail)
                return
            }
            sessionId = id
            sttMode = state.sttMode ?? "local"
            if let notice = state.speechNotice { speechNotice = notice }
            corePhase = state.phase ?? "listening"
            phase = .live
            startHearing()
            startWatchdog()
            pollTask = Task { [weak self] in await self?.pollLoop() }
            playbackTask = Task { [weak self] in await self?.playbackLoop() }
        } catch {
            fail(error.localizedDescription)
        }
    }

    /// On-device connect: no core session, no network at all.
    /// The brain loads once and stays loaded across calls (a
    /// 2.5 GB model is not re-read per call); a missing or
    /// unloadable brain fails the call loudly, in words, with
    /// the way out named.
    private func connectLocal() async {
        guard await prepareCallAudio() else { return }
        transport = .local
        if localBrain == nil {
            // The ACTIVE brain (v0.21.0): the person's library
            // pick when it's on the phone, else the standard
            // brain, else any downloaded brain — resolution is
            // presence-aware, so a deleted pick falls back
            // instead of dead-ending the call.
            guard let entry = ActiveBrain.resolved() else {
                fail("The on-device brain isn't downloaded yet — get it in Settings → On-device models, or switch calls to Core mode in Settings.")
                return
            }
            localBrain = LocalBrain(modelURL: ModelStore.fileURL(for: entry))
            guard localBrain != nil else {
                fail("The on-device brain wouldn't load — try deleting and re-downloading it in Settings → On-device models.")
                return
            }
        }
        sttMode = "local"
        corePhase = "listening"
        phase = .live
        startHearing()
        startWatchdog()
    }

    func endCall() {
        guard phase == .live || phase == .connecting else { return }
        phase = .ended
        pendingShieldQuarantine = nil
        watchdogTask?.cancel(); watchdogTask = nil
        pollTask?.cancel(); pollTask = nil
        playbackTask?.cancel(); playbackTask = nil
        if transport == .local { interruptLocalAnswer() }
        stopHearing()
        cutSpeech()
        // The shared call engine stops with the call (v0.18.0:
        // stopHearing no longer stops it — see there).
        if audioEngine.isRunning { audioEngine.stop() }
        voiceLevel = 0
        if let id = sessionId {
            Task { _ = try? await client.voiceSessionEnd(sessionId: id) }
        }
        sessionId = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func fail(_ message: String) {
        errorText = message
        voiceLevel = 0
        pendingShieldQuarantine = nil
        phase = .ended
        watchdogTask?.cancel(); watchdogTask = nil
        if audioEngine.isRunning { audioEngine.stop() }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Hearing

    private func startHearing() {
        guard phase == .live, !isMuted else { return }
        // Route reassertion (v0.22.0): hearing restarts ride
        // session reactivations and route changes that can
        // reset the output port — the speaker choice is
        // restated here so it survives them (see
        // prepareCallAudio for why the category option alone
        // was never enough).
        if isSpeakerOn {
            try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.speaker)
        }
        recognitionGeneration += 1
        let generation = recognitionGeneration
        let input = audioEngine.inputNode
        input.removeTap(onBus: 0)
        // Voice processing BEFORE the format is read (v0.18.0):
        // enabling it swaps the input to the Voice Processing
        // I/O unit, whose output format is the one the tap must
        // use. It can only be set while the engine is stopped —
        // a call's first startHearing always runs stopped, and
        // the setting then persists for the engine's life, so
        // restarts during playback simply find it already on.
        // A failure here is not fatal: unprocessed input still
        // works, defended by the echo guard and the barge-in
        // debounce exactly as before v0.18.0.
        if !voiceProcessingEnabled, !audioEngine.isRunning {
            do {
                try input.setVoiceProcessingEnabled(true)
                voiceProcessingEnabled = true
            } catch {
                // Fall through with unprocessed input — but
                // SAY so (v0.22.0): through v0.21.0 this catch
                // was empty, so no field report could ever tell
                // whether voice processing had engaged, which
                // playback path that left the call on, or why
                // the echo canceller was absent.
                VoiceFailureLog.shared.recordInfo("Voice processing couldn't be enabled (\(error.localizedDescription)) — echo cancellation off for this call.")
            }
        }
        let format = input.outputFormat(forBus: 0)

        if sttMode == "local" {
            guard let recognizer = speechRecognizer, recognizer.isAvailable else { return }
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition {
                request.requiresOnDeviceRecognition = true
            }
            recognitionRequest = request
            recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                guard let self else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    let isFinal = result.isFinal
                    Task { @MainActor in
                        guard generation == self.recognitionGeneration else { return }
                        self.handleTranscript(text, isFinal: isFinal)
                    }
                }
                if error != nil || (result?.isFinal ?? false) {
                    Task { @MainActor in
                        guard generation == self.recognitionGeneration else { return }
                        self.restartHearing()
                    }
                }
            }
        } else if let target = Self.pcmTargetFormat {
            pcmConverter = AVAudioConverter(from: format, to: target)
        }

        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            if self.sttMode == "local" {
                self.recognitionRequest?.append(buffer)
            } else {
                self.accumulatePCM(buffer)
            }
        }
        audioEngine.prepare()
        try? audioEngine.start()
    }

    private func restartHearing() {
        stopHearing()
        guard phase == .live, !isMuted else { return }
        startHearing()
    }

    private func stopHearing() {
        recognitionGeneration += 1
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        // The engine is the call's SHARED engine (v0.18.0):
        // Kokoro playback runs on it too, so stopping hearing
        // takes the tap off but must NOT stop the engine — a
        // recognizer restart mid-reply would cut the voice
        // itself. With no tap and no connection, the input
        // node pulls no mic data (mute stays mute). The engine
        // stops at endCall / fail, when the call is over.
        audioEngine.inputNode.removeTap(onBus: 0)
        pendingPCM.removeAll()
    }

    func setMuted(_ muted: Bool) {
        isMuted = muted
        if muted {
            stopHearing()
        } else if phase == .live {
            startHearing()
        }
    }

    /// Speaker on/off from the call screen (field report,
    /// Glenn 2026-11-20: the call screen had no speaker
    /// button at all). Only the output port is overridden —
    /// the session stays exactly as prepareCallAudio set it,
    /// because its echo behavior comes from the engine's
    /// voice processing (v0.18.0), which the output-port
    /// override does not touch.
    func setSpeaker(_ on: Bool) {
        isSpeakerOn = on
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
    }

    /// Endpoint mode: convert a mic buffer to 16 kHz mono
    /// PCM16 and post ~100 ms chunks to the core. Runs on the
    /// audio tap's thread; the converter and accumulator are
    /// only touched there and in stopHearing.
    private func accumulatePCM(_ buffer: AVAudioPCMBuffer) {
        guard let converter = pcmConverter, let target = Self.pcmTargetFormat else { return }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, let channels = out.int16ChannelData else { return }
        pendingPCM.append(Data(bytes: channels[0], count: Int(out.frameLength) * 2))
        if pendingPCM.count >= 3200, let id = sessionId {
            let chunk = pendingPCM
            pendingPCM.removeAll()
            Task { _ = try? await client.voiceSessionAudio(sessionId: id, chunk: chunk) }
        }
    }

    private func handleTranscript(_ text: String, isFinal: Bool) {
        if isEcho(text) { return }
        liveTranscript = text
        if !isFinal, text != lastPartialText {
            lastPartialText = text
            lastPartialChangeAt = Date()
        }
        // Barge-in: the operator talking over a reply cuts it —
        // locally at once, and on the core so unfetched
        // sentences are dropped unsaid. On-device, the same cut
        // also stops the local brain mid-generation. Since
        // v0.18.0 the cut is DEBOUNCED for partials: a final
        // cuts at once (it is a complete utterance), but a
        // partial must be sustained (bargeInConfirmed) — one
        // stray partial is how residual echo and recognizer
        // fragments used to cut GUS mid-sentence even with the
        // echo guard and, before it, Glenn muting after every
        // sentence he spoke (2026-11-26 field report).
        if gusSpeaking && !text.isEmpty {
            if isFinal || bargeInConfirmed(text) {
                bargeCandidateText = ""
                cutSpeech()
                if transport == .local { interruptLocalAnswer() }
                if let id = sessionId {
                    Task { _ = try? await client.voiceSessionInterrupt(sessionId: id) }
                }
            }
        } else if !gusSpeaking {
            bargeCandidateText = ""
        }
        if isFinal {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            liveTranscript = ""
            lastPartialText = ""
            if !trimmed.isEmpty {
                if transport == .local {
                    answerLocally(trimmed)
                } else if sttMode == "local", let id = sessionId {
                    Task { _ = try? await client.voiceSessionTranscript(sessionId: id, text: trimmed) }
                }
            }
        }
    }

    /// Barge-in's confirmation (v0.18.0): is this partial a
    /// person sustaining speech over GUS, or a lone fragment?
    /// A cut is confirmed when a partial of at least two words
    /// is followed, at least 0.35 s after the first candidate,
    /// by another partial that grows the candidate or shares
    /// most of its words. A person talking over GUS keeps
    /// talking, so their partials sustain and the cut lands a
    /// beat later; a fragment — echo residue the word-overlap
    /// guard couldn't recognize, a recognizer stutter — stands
    /// alone and dies here. An unrelated new partial restarts
    /// the candidacy rather than confirming the old one.
    private func bargeInConfirmed(_ text: String) -> Bool {
        let words = Self.normalizedWords(text)
        guard words.count >= 2 else { return false }
        let now = Date()
        if !bargeCandidateText.isEmpty {
            let candidate = Self.normalizedWords(bargeCandidateText)
            if now.timeIntervalSince(bargeCandidateAt) >= 0.35,
               words.count > candidate.count
                || Self.wordOverlap(words, with: candidate) >= 0.5 {
                return true
            }
            if Self.wordOverlap(words, with: candidate) == 0 {
                bargeCandidateText = text
                bargeCandidateAt = now
            }
            return false
        }
        bargeCandidateText = text
        bargeCandidateAt = now
        return false
    }

    /// The end-of-speech watchdog (see the note at the
    /// recognizer properties): every quarter second, a live
    /// partial that has not changed for 1.4 s while the call
    /// is listening — not thinking, not speaking, no local
    /// generation in flight — is dispatched as the utterance's
    /// final, and the recognizer restarts clean. Barge-in is
    /// untouched: partials still cut speech the moment they
    /// land; this only supplies the final the system withholds.
    private func startWatchdog() {
        watchdogTask?.cancel()
        watchdogTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard let self, self.phase == .live, self.sttMode == "local" else { continue }
                let text = self.liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty,
                      text == self.lastPartialText,
                      Date().timeIntervalSince(self.lastPartialChangeAt) > 1.4,
                      self.corePhase == "listening",
                      !self.gusSpeaking,
                      self.transport == .core || self.localGenerationDone
                else { continue }
                self.lastPartialText = ""
                self.handleTranscript(text, isFinal: true)
                self.restartHearing()
            }
        }
    }

    // MARK: - On-device answers

    /// One on-device turn, through the Shield gate first
    /// (v0.15.7): the transcript is scanned BEFORE the brain
    /// sees it — a text scan at a turn boundary, never on the
    /// audio path. Block: the brain never sees the turn and a
    /// canned line is spoken instead. Quarantine (Standard
    /// posture): the turn is held for the operator's one-time
    /// override. Allow — and everything in Permissive, where
    /// the receipt keeps the would-be verdict: the turn
    /// proceeds exactly as before. Core-mode turns are not
    /// scanned here; the core runs its own Shield server-side.
    /// Shield OFF means no scan and no receipt at all.
    private func answerLocally(_ text: String) {
        guard localBrain != nil, phase == .live else { return }
        guard pendingShieldQuarantine == nil else { return }
        if ShieldSettings.enabled {
            let scan = ShieldScanner.scan(text, posture: ShieldSettings.posture)
            ShieldReceiptLog.shared.record(scan, direction: .user)
            switch scan.verdict {
            case .block:
                speakShieldBlockedTurn(for: text)
                return
            case .quarantine:
                pendingShieldQuarantine = ShieldQuarantine(
                    text: text, ruleID: scan.primaryRuleID)
                corePhase = "listening"
                return
            case .allow:
                break
            }
        }
        beginLocalAnswer(text)
    }

    /// The operator's one-time override: the held turn goes to
    /// the brain as-is. The receipt from the original scan
    /// already records the quarantine — overriding does not
    /// rewrite it, and it buys this turn only: the same words
    /// in a new turn are scanned fresh.
    func overrideShieldQuarantine() {
        guard let held = pendingShieldQuarantine else { return }
        pendingShieldQuarantine = nil
        guard phase == .live else { return }
        beginLocalAnswer(held.text)
    }

    /// Drop the held turn: it never reaches the brain, and
    /// nothing is spoken — the prompt on screen already said
    /// why it was held.
    func dropShieldQuarantine() {
        pendingShieldQuarantine = nil
    }

    /// A blocked user turn still gets a spoken answer — the
    /// canned line, through the normal pump and the normal
    /// Kokoro path — and the turn is recorded with the canned
    /// reply attached, so the call screen shows what GUS
    /// stopped and what he said about it.
    private func speakShieldBlockedTurn(for text: String) {
        let canned = "I stopped that — it matched a known injection pattern."
        localTurnCounter += 1
        let turnID = localTurnCounter
        turns.append(VoiceSessionState.Turn(
            index: turns.count, kind: "voice", detail: "",
            transcript: text, replyText: nil, interrupted: false))
        corePhase = "thinking"
        if localAnswerTask != nil {
            localBrain?.stop()
            localAnswerTask = nil
        }
        localSentenceQueue = [canned]
        preparedLineup = []
        localCompletedReply = canned
        localGenerationDone = true
        startLocalSpeechPump(turnID: turnID)
    }

    /// One on-device turn: the transcript is recorded at once,
    /// the brain streams its reply sentence by sentence into
    /// the pump, and the pump speaks them in order — thinking
    /// and speaking overlap, as they do on the core. A new
    /// turn supersedes an unfinished one: the old generation
    /// is stopped and awaited before the new one starts (the
    /// brain runs one generation at a time).
    private func beginLocalAnswer(_ text: String) {
        guard let brain = localBrain, phase == .live else { return }
        localTurnCounter += 1
        let turnID = localTurnCounter
        turns.append(VoiceSessionState.Turn(
            index: turns.count, kind: "voice", detail: "",
            transcript: text, replyText: nil, interrupted: false))
        corePhase = "thinking"
        localSentenceQueue = []
        preparedLineup = []
        localCompletedReply = nil
        localGenerationDone = false
        startLocalSpeechPump(turnID: turnID)
        let previous = localAnswerTask
        if previous != nil { brain.stop() }
        localAnswerTask = Task { [weak self] in
            await previous?.value
            let reply = await brain.respond(to: text) { sentence in
                Task { @MainActor in
                    guard let self, self.localTurnCounter == turnID else { return }
                    self.localSentenceQueue.append(sentence)
                    // Fill the lineup the moment a sentence
                    // exists (v0.17.1; two deep since
                    // v0.17.4): when the pump is between
                    // sentences this starts the synthesis now
                    // instead of after the next pop; while a
                    // sentence plays, this tops the lineup up
                    // behind it, alongside the playback-start
                    // hook.
                    self.prepareNextLocalSentence()
                }
            }
            // Sentence hops were submitted before this one, and
            // the main actor runs them in order — by the time
            // this lands, the queue holds the whole reply.
            Task { @MainActor in
                guard let self, self.localTurnCounter == turnID else { return }
                self.localCompletedReply = reply
                self.localGenerationDone = true
            }
        }
    }

    /// The speech pump: drains the sentence queue through the
    /// resolved speech engine, then closes the turn out —
    /// reply text attached, phase back to listening.
    private func startLocalSpeechPump(turnID: Int) {
        localPumpTask?.cancel()
        localPumpTask = Task { [weak self] in
            guard let self else { return }
            var spokeFirstSentence = false
            var shieldCannedSpoken = false
            while !Task.isCancelled, self.localTurnCounter == turnID, self.phase == .live {
                if self.localSentenceQueue.isEmpty {
                    if self.localGenerationDone { break }
                    try? await Task.sleep(nanoseconds: 80_000_000)
                    continue
                }
                let sentence = self.localSentenceQueue.removeFirst()
                // Shield on the way out (v0.15.7): the reply
                // sentence is scanned before the voice speaks
                // it. A blocked sentence is never spoken; one
                // canned line per turn says so, in its place.
                // The verdict normally comes from the
                // synthesize-ahead lineup (v0.17.1), which
                // scanned this sentence while the previous one
                // played; the pop consumes that verdict rather
                // than scanning twice — one scan, one receipt
                // per sentence either way. A sentence the
                // lineup never reached is scanned here, as
                // before.
                let sentenceBlocked: Bool
                if let head = self.preparedLineup.first, head.text == sentence {
                    sentenceBlocked = head.blocked
                    self.preparedLineup.removeFirst()
                } else {
                    sentenceBlocked = self.replySentenceBlocked(sentence)
                }
                if sentenceBlocked {
                    if !shieldCannedSpoken {
                        shieldCannedSpoken = true
                        self.corePhase = "speaking"
                        self.gusSpeaking = true
                        await self.speakText("I stopped part of that reply — it matched a known injection pattern.")
                        self.gusSpeaking = false
                    }
                    continue
                }
                self.corePhase = "speaking"
                self.gusSpeaking = true
                await self.speakText(sentence)
                self.gusSpeaking = false
                if !spokeFirstSentence {
                    spokeFirstSentence = true
                    // The voice plainly made it — retire the
                    // "getting your voice ready" note from
                    // call start.
                    if KokoroRuntime.shared.isReady { self.speechNotice = nil }
                }
            }
            guard self.localTurnCounter == turnID, self.phase == .live else { return }
            if let reply = self.localCompletedReply, let last = self.turns.indices.last {
                let t = self.turns[last]
                self.turns[last] = VoiceSessionState.Turn(
                    index: t.index, kind: t.kind, detail: t.detail,
                    transcript: t.transcript,
                    replyText: reply.isEmpty ? nil : reply,
                    interrupted: t.interrupted)
                self.localCompletedReply = nil
            }
            self.corePhase = "listening"
        }
    }

    /// Fill the synthesize-ahead lineup (v0.17.1; two deep
    /// since v0.17.4): scan the next unlined queue sentences
    /// — up to two waiting behind the one playing — and,
    /// for each allowed one, start its synthesis in the
    /// speech engine while the current sentence is still
    /// playing, so the next ones start speaking the moment
    /// their turn comes instead of after a full synthesis
    /// spent in silence. Called when a sentence starts
    /// playing and when a sentence lands in the queue. The
    /// lineup only ever extends the queue's unlined prefix,
    /// in order, so playback order is untouched; a blocked
    /// sentence is never synthesized — its recorded verdict
    /// waits in the lineup for the pump to act on at pop
    /// time, and the lineup fills in behind it, so one
    /// blocked sentence no longer drains the bench.
    private func prepareNextLocalSentence() {
        guard transport == .local, phase == .live else { return }
        while preparedLineup.count < preparedLineupDepth {
            let index = preparedLineup.count
            guard index < localSentenceQueue.count else { return }
            let next = localSentenceQueue[index]
            let blocked = replySentenceBlocked(next)
            preparedLineup.append((text: next, blocked: blocked))
            if !blocked {
                speaker.prepare(next)
            }
        }
    }

    /// Shield on the way out (v0.15.7): scan one reply
    /// sentence at the pump, before TTS — a turn-boundary text
    /// scan, milliseconds, never on the audio render path.
    /// Returns true only for a BLOCK verdict. A quarantined
    /// reply sentence is spoken anyway: for replies the
    /// receipt is the warning (fail-open-with-warning), and
    /// Strict posture has already mapped quarantine to block
    /// inside the scanner's posture mapping. Shield OFF: no
    /// scan, no receipt, never blocked.
    private func replySentenceBlocked(_ sentence: String) -> Bool {
        guard ShieldSettings.enabled else { return false }
        let scan = ShieldScanner.scan(sentence, posture: ShieldSettings.posture)
        ShieldReceiptLog.shared.record(scan, direction: .assistant)
        return scan.verdict == .block
    }

    /// Barge-in's local half: stop the brain, drop every
    /// unsaid sentence, mark the turn interrupted. (cutSpeech
    /// has already silenced the engine itself.)
    private func interruptLocalAnswer() {
        localTurnCounter += 1
        localAnswerTask?.cancel()
        localAnswerTask = nil
        localPumpTask?.cancel()
        localPumpTask = nil
        localBrain?.stop()
        localSentenceQueue = []
        preparedLineup = []
        localGenerationDone = true
        if let last = turns.indices.last {
            let t = turns[last]
            turns[last] = VoiceSessionState.Turn(
                index: t.index, kind: t.kind, detail: t.detail,
                transcript: t.transcript, replyText: t.replyText,
                interrupted: true)
        }
        if phase == .live { corePhase = "listening" }
    }

    // MARK: - Speaking

    private func pollLoop() async {
        while !Task.isCancelled, phase == .live, let id = sessionId {
            if let state = try? await client.voiceSessionState(sessionId: id) {
                turns = state.turns
                corePhase = state.phase ?? corePhase
                if let notice = state.speechNotice { speechNotice = notice }
                if !state.active { endCall(); return }
            }
            try? await Task.sleep(nanoseconds: 600_000_000)
        }
    }

    private func playbackLoop() async {
        while !Task.isCancelled, phase == .live, let id = sessionId {
            guard let segment = try? await client.voiceSessionNextAudio(sessionId: id, afterSeq: lastSeq),
                  let seq = segment.seq else {
                try? await Task.sleep(nanoseconds: 300_000_000)
                continue
            }
            lastSeq = seq
            gusSpeaking = true
            await playSegment(segment)
            gusSpeaking = false
        }
    }

    /// Speak one text segment through the resolved engine and
    /// wait for it to finish (or be cut) — shared by the core
    /// playback loop and the on-device sentence pump.
    private func speakText(_ text: String) async {
        speakingText = text
        // A new sentence starts with a clean barge-in slate
        // (v0.18.0): a candidate left over from the previous
        // sentence can never confirm against this one's first
        // partials.
        bargeCandidateText = ""
        let failuresBefore = VoiceFailureLog.shared.failureCount
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            segmentContinuation = c
            speaker.speak(text) { [weak self] in
                Task { @MainActor in self?.resumeSegment() }
            }
        }
        // Playback-failure surfacing (v0.22.0): if the voice
        // path recorded failures while this sentence was being
        // spoken, count them; at two in one call, the call
        // screen says so in plain words — with the actual
        // error — instead of pretending the sentences played.
        // One failure stays a log line (a single cut sentence
        // can have innocent causes); two is a broken path.
        let newFailures = VoiceFailureLog.shared.failureCount - failuresBefore
        if newFailures > 0 {
            playbackFailuresThisCall += newFailures
            if playbackFailuresThisCall >= 2 {
                speechNotice = "Voice playback failed: \(VoiceFailureLog.shared.latestFailure ?? "unknown error") The details are in Settings → About."
            }
        }
        lastSpokenText = text
        lastSpokenAt = Date()
        speakingText = ""
    }

    /// Is this transcript just the microphone hearing GUS?
    /// Word-overlap against the sentence being spoken (or, in
    /// the two seconds after, the sentence just spoken): real
    /// barge-in talks about something else and sails through;
    /// an echo is the same words coming back.
    private func isEcho(_ text: String) -> Bool {
        let heard = Self.normalizedWords(text)
        guard !heard.isEmpty else { return false }
        if !speakingText.isEmpty,
           Self.wordOverlap(heard, with: Self.normalizedWords(speakingText)) >= 0.8 {
            return true
        }
        if Date().timeIntervalSince(lastSpokenAt) < 2.0,
           !lastSpokenText.isEmpty, heard.count >= 2,
           Self.wordOverlap(heard, with: Self.normalizedWords(lastSpokenText)) >= 0.8 {
            return true
        }
        return false
    }

    private static func normalizedWords(_ text: String) -> [String] {
        text.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
    }

    /// Share of `words` that appear in `reference` — order-free,
    /// because a recognizer's echo rarely preserves phrasing.
    private static func wordOverlap(_ words: [String], with reference: [String]) -> Double {
        guard !words.isEmpty, !reference.isEmpty else { return 0 }
        let ref = Set(reference)
        let hits = words.filter { ref.contains($0) }.count
        return Double(hits) / Double(words.count)
    }

    private func playSegment(_ segment: VoiceAudioSegment) async {
        if let text = segment.text {
            await speakText(text)
            return
        }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            segmentContinuation = c
            if let base64 = segment.audioBase64,
               let data = Data(base64Encoded: base64),
               let player = try? AVAudioPlayer(data: data) {
                audioPlayer = player
                player.delegate = self
                player.play()
            } else {
                resumeSegment()
            }
        }
    }

    private func resumeSegment() {
        let continuation = segmentContinuation
        segmentContinuation = nil
        continuation?.resume()
    }

    /// Cut whatever is speaking right now — the local half of
    /// barge-in, and what End Call does to the voice.
    private func cutSpeech() {
        speaker.stopSpeaking()
        audioPlayer?.stop()
        audioPlayer = nil
        resumeSegment()
    }
}

// MARK: - AVAudioPlayerDelegate

extension CallSession: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.resumeSegment() }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in self.resumeSegment() }
    }
}
