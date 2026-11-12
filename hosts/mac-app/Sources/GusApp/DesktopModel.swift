import AppKit
import AVFoundation
import Foundation
import Speech

/// Cross-window requests, posted by views and observed by the app
/// delegate (windows) or this model (the setup sheet).
extension Notification.Name {
    static let gusOpenSettings = Notification.Name("gus.openSettings")
    static let gusCheckForUpdates = Notification.Name("gus.checkForUpdates")
    static let gusRunSetup = Notification.Name("gus.runSetup")
}

/// v0.9.7: why built-in listening can't start, presented as a
/// prompt with the fix one button away. macOS owns these
/// switches — no app may flip Dictation, Siri, or a privacy
/// grant on the user's behalf — so the prompt's buttons
/// deep-link to the exact Settings panes (the app's existing
/// x-apple.systempreferences convention, as in the Settings
/// grant rows) instead of leaving the reason in a dead-end
/// status line the operator has to go hunting from.
enum VoiceSpeechPrompt: Identifiable {
    /// Permission is granted but Apple's recognizer is
    /// unavailable — the Dictation/Siri-disabled signature
    /// (the 0.9.6 field call's dead end).
    case dictationDisabled
    /// Speech recognition permission was denied (or is
    /// restricted) for GUS.
    case accessDenied

    var id: String {
        switch self {
        case .dictationDisabled: return "dictation"
        case .accessDenied: return "denied"
        }
    }

    var title: String {
        switch self {
        case .dictationDisabled: return "Dictation and Siri are off"
        case .accessDenied: return "Speech Recognition is off for GUS"
        }
    }

    var message: String {
        switch self {
        case .dictationDisabled:
            return "Built-in listening runs on Apple's speech recognition, which macOS keeps off while Dictation and Siri are disabled. GUS can't flip those switches for you — these buttons open the exact Settings panes."
        case .accessDenied:
            return "GUS doesn't have permission to transcribe your voice on this Mac. Grant it under Privacy & Security → Speech Recognition, then try the call again."
        }
    }
}

/// The desktop window's store: a polling read model over the local
/// panel APIs, plus the three actions the window offers (send a
/// chat message, approve, deny). Nothing is cached to disk and
/// nothing is invented — when the panel is unreachable the views
/// say so, with empty data, rather than showing stale success.
///
/// Poll cadence mirrors the web panel (its chat view polls every
/// 2s): one 2.5s timer refreshes status, chat, jobs, and approvals,
/// so a parked job's card appears in the window about as fast as
/// it would on the operator's phone.
final class DesktopModel: ObservableObject {
    enum Section {
        case chat
        case jobs
        case gateways
    }

    @Published var section: Section = .chat
    @Published var reachable = false
    @Published var status: PanelStatus?
    @Published var chatMessages: [PanelChatMessage] = []
    @Published var chatJobs: [PanelJob] = []
    @Published var jobs: [PanelJob] = []
    @Published var approvals: [PanelApproval] = []
    @Published var approvalsHistory: [PanelApprovalHistoryEntry] = []
    /// v0.8: the wizard's step state — drives the first-run setup
    /// sheet (auto-presented once when a fresh install can't think
    /// yet) and is re-read after every setup action.
    @Published var onboarding: PanelOnboarding?
    @Published var setupPresented = false
    private var setupAutoShown = false
    @Published var composerText = ""
    /// v0.9.1 (Call GUS, live): an open call is a session in the
    /// control plane. The microphone streams only while
    /// voiceInCall — nothing listens outside a call the operator
    /// started. Turns render from the session state's own
    /// records (the poll below); the jobs behind them are
    /// ordinary jobs with ordinary receipts in the Jobs view.
    @Published var voiceInCall = false
    /// The server-reported phase: listening | thinking | speaking.
    @Published var voicePhase = "listening"
    @Published var voiceTurns: [PanelVoiceSessionTurn] = []
    @Published var voiceElapsedMs: Double = 0
    /// The last turn's measured stages, for the in-call strip:
    /// the local-vs-cloud speech evidence, in the open.
    @Published var voiceLatencyLine: String?
    /// v0.9.2: the in-call strip's hearing line — the server's
    /// ledger (what the session's VAD is receiving) next to the
    /// app's own mic level. v0.9.3: the app's number is the RAW
    /// level, measured in the tap from the buffers as the
    /// microphone delivered them, before any conversion — so
    /// the gap between the two isolates the converter: mic
    /// moving + heard flat means conversion is eating the
    /// audio; both flat means the microphone itself.
    @Published var voiceHearingLine: String?
    /// The app's latest raw microphone level (pre-conversion,
    /// from the tap handler), on the int16 scale like the
    /// server's numbers, so the two compare directly.
    private var voiceMicLevel = 0
    private var voiceSessionId: String?
    private var voiceBargeIn = true
    private var voiceLastSeq = 0
    // Capture: AVAudioEngine tap → converter → a PCM16 stash the
    // chunk timer drains in ~250 ms posts (never from the audio
    // thread itself). v0.9.3 shape: the tap is installed with NO
    // explicit format (buffers arrive in the input node's true
    // running format) and the converter is built lazily from the
    // first buffer that actually arrives — never from a format
    // queried before the engine started, which is how 0.9.1/
    // 0.9.2 could convert faithfully into silence.
    private var voiceEngine: AVAudioEngine?
    private var voiceConverter: AVAudioConverter?
    /// The input format the current converter was built from;
    /// a buffer in any other format rebuilds it.
    private var voiceConverterSourceFormat: AVAudioFormat?
    private let voiceTargetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private var voiceStash = Data()
    private let voiceStashLock = NSLock()
    private var voiceChunkTimer: Timer?
    private var voicePollTimer: Timer?
    private var voiceLoudStreak = 0
    // Capture evidence (v0.9.3), counted on the audio thread
    // under the stash lock and read on the main thread: frames
    // the converter produced vs buffers it dropped, buffers
    // whose RAW level crossed the audible floor, and the raw
    // peak since capture started. The preflight reads the peak
    // (~600 ms in: silence never opens a call); the converter
    // guard reads the deltas (raw sound arriving for 2 s while
    // the converter produces nothing ends the call, loudly).
    private var voiceConvertedFrames = 0
    private var voiceDroppedBuffers = 0
    private var voiceRawSpeechBuffers = 0
    private var voiceRawPeakLevel: Double = 0
    /// True between the Call tap and the call opening (or the
    /// attempt failing) — the preflight window, during which
    /// the Call button must not start a second attempt.
    private var voiceCallStarting = false
    private var voicePreflightTimer: Timer?
    private var voiceConvertGuardTimer: Timer?
    private var voiceGuardFramesMark = 0
    private var voiceGuardSpeechMark = 0
    private var voiceGuardTicks = 0
    /// The audible floor on the int16 scale: raw RMS above
    /// this is a microphone delivering sound, not a quiet room
    /// (ordinary speech reads in the low thousands; a silent
    /// room in the low tens).
    private static let voiceAudibleFloor: Double = 150
    // Playback: a queue of sentence segments through one player,
    // advanced by the chunk timer (no delegate — the timer asks
    // isPlaying, which is all the chaining needs).
    private var voicePlayer: AVAudioPlayer?
    private var voicePlayQueue: [Data] = []
    /// v0.9.6 (Voice, built in): the call's RESOLVED speech modes,
    /// from the session the control plane opened — "local" means
    /// this app is the ears and/or the mouth for the call. An
    /// older control plane resolves nothing, and the defaults
    /// here ("endpoint" both) keep its calls behaving exactly as
    /// they did before built-in existed.
    private var voiceSttMode = "endpoint"
    private var voiceTtsMode = "endpoint"
    // Built-in mouth: speak-text segments queue here and the
    // chunk timer feeds them to the synthesizer (the same
    // no-delegate chaining as the player above — the timer asks
    // isSpeaking). Barge-in stops the synthesizer and clears
    // this queue, exactly as it clears the player's.
    private var voiceSynthesizer = AVSpeechSynthesizer()
    private var voiceSpeakQueue: [String] = []
    // Built-in ears: the Speech-framework recognizer. The tap
    // appends the SAME native-format buffers it already receives
    // (read under the stash lock in the tap handler); each final
    // result is POSTed as a transcript and the task restarts —
    // a recognition task lives about a minute, a call can live
    // sixty. The generation counter keeps a cancelled task's
    // trailing callbacks from acting on a call that has moved on.
    private var voiceRecognizer: SFSpeechRecognizer?
    private var voiceRecognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var voiceRecognitionTask: SFSpeechRecognitionTask?
    private var voiceRecognitionGen = 0
    // v0.9.7 (Voice that answers): sentence-end tracking for
    // the built-in ears. Through 0.9.6 the recognizer reported
    // finals only and nothing ever ended a sentence's audio,
    // so finals essentially never arrived mid-call and no
    // transcript ever completed a turn — the call heard
    // everything and answered nothing. Now the recognizer
    // reports partials; the chunk timer watches the partial
    // (text + when it last changed) and the mic's own activity
    // (voiceLastLoudAt, written on the audio thread under the
    // stash lock like the other capture counters) and calls
    // endAudio() at a real sentence end, which forces the
    // final the pipeline waits on.
    private var voicePartialText = ""
    private var voicePartialLastChange = Date()
    private var voiceTaskStartedAt = Date()
    private var voiceEndAudioSent = false
    /// The generation whose task already posted a final: an
    /// error trailing that final is the task closing, not the
    /// call failing (see the recognition handler).
    private var voiceFinalGen = -1
    private var voiceLastLoudAt = Date.distantPast
    /// v0.9.7: the Settings prompt when built-in listening is
    /// walled off by macOS — ChatView presents it; its buttons
    /// deep-link to the panes GUS can't flip itself.
    @Published var voiceSpeechPrompt: VoiceSpeechPrompt?
    /// The last action's outcome, in the panel's own words (or the
    /// transport error). Shown under the composer / sidebar so a
    /// refusal is never silent.
    @Published var notice: String?
    /// Bumped by "New chat": ChatView watches it and focuses the
    /// composer. (The panel chat is one durable operator
    /// conversation; a new chat means a fresh turn in it.)
    @Published var composerFocusToken = 0

    private let client = PanelClient()
    private var timer: Timer?

    init() {
        refreshAll()
        timer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in
            self?.refreshAll()
        }
        NotificationCenter.default.addObserver(forName: .gusRunSetup, object: nil, queue: .main) { [weak self] _ in
            self?.setupPresented = true
        }
    }

    deinit {
        timer?.invalidate()
    }

    // MARK: Derived display state

    /// The sidebar's live status line: what GUS is doing right now,
    /// in the Governor's units.
    var statusLine: String {
        guard let status else {
            return reachable ? "…" : "Control plane not reachable"
        }
        if status.killed { return "Kill switch ON — stopped" }
        var parts = ["Running", status.governorMode]
        if status.pendingApprovals > 0 {
            parts.append("\(status.pendingApprovals) waiting for you")
        }
        parts.append("\(GusFormat.usd(status.spendTodayUsd)) today")
        return parts.joined(separator: " · ")
    }

    /// Pending approvals that belong to the chat conversation —
    /// rendered inline above the composer.
    var chatApprovals: [PanelApproval] {
        let ids = Set(chatJobs.map(\.id))
        return approvals.filter { ids.contains($0.jobId) }
    }

    // MARK: Actions

    func newChat() {
        section = .chat
        composerFocusToken += 1
    }

    func sendComposer() {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        composerText = ""
        client.post("/api/chat", jsonBody: ["text": text]) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let r):
                    self.notice = r.detail
                    if !r.ok { self.composerText = text } // refused: hand the words back
                case .failure(let e):
                    self.notice = "Could not reach the panel: \(e.localizedDescription)"
                    self.composerText = text
                }
                self.refreshChat()
            }
        }
    }

    // MARK: Voice — Call GUS, live (v0.9.1)

    /// The Call button: open a live call. The mic permission is
    /// asked first (the same gate as 0.9.0), then capture starts
    /// as a PREFLIGHT (v0.9.3): for ~600 ms the app only measures
    /// the raw microphone level — nothing is posted anywhere, no
    /// session exists, and the measured audio is discarded. Only
    /// a microphone that provably delivers sound opens a session
    /// and becomes a call. The order changed in v0.9.3 because
    /// the old one (session first, capture second) let a dead
    /// capture path present as a call "listening" forever; a
    /// silent mic now gets a plain refusal within about a
    /// second, before any session exists.
    func startVoiceCall() {
        guard !voiceInCall, !voiceCallStarting else { return }
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                guard granted else {
                    self.notice = "Microphone access is off for GUS — grant it in System Settings → Privacy & Security → Microphone, then try the call again."
                    return
                }
                self.voiceCallStarting = true
                guard self.beginVoiceCapture() else {
                    // beginVoiceCapture set the notice.
                    self.voiceCallStarting = false
                    return
                }
                self.voicePreflightTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: false) { [weak self] _ in
                    guard let self, self.voiceCallStarting else { return }
                    self.voiceStashLock.lock()
                    let peak = self.voiceRawPeakLevel
                    self.voiceStashLock.unlock()
                    guard peak > Self.voiceAudibleFloor else {
                        self.voiceCallStarting = false
                        self.stopVoiceCapture()
                        self.notice = "GUS is receiving silence from the microphone — the call wasn't started. Check that the input device in System Settings → Sound is the mic you're speaking into, and that no other app is holding it."
                        return
                    }
                    self.prepareVoiceSession()
                }
            }
        }
    }

    /// v0.9.7: the preflight heard sound — before any session
    /// opens, meet the macOS speech walls HERE, while there is
    /// still no call to kill. If the call will use the built-in
    /// ears (the configured STT engine, read through the same
    /// settings endpoint Settings uses), speech-recognition
    /// readiness is checked first: the system's own
    /// authorization popup when it has never asked, or the
    /// in-app prompt deep-linking to the Settings panes when a
    /// switch is off. An endpoint call skips this — its
    /// call-start probe is its check, and if the probe falls
    /// back to built-in, the same readiness gate runs inside
    /// startVoiceRecognition before the recognizer starts. A
    /// settings fetch that fails proves nothing either way:
    /// the session start's own loud refusals handle that world,
    /// so the call proceeds to it.
    private func prepareVoiceSession() {
        client.get("/api/voice/settings", as: PanelVoiceSettings.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.voiceCallStarting else { return }
                if case .success(let settings) = result,
                   settings.enabled,
                   (settings.sttEngine ?? "local") == "local" {
                    self.checkSpeechReadiness { ready in
                        guard self.voiceCallStarting else { return }
                        if ready {
                            self.openVoiceSession()
                        } else {
                            self.voiceCallStarting = false
                            self.stopVoiceCapture()
                            self.notice = "The call wasn't started: built-in listening is walled off in System Settings — the prompt has the switches, one tap away."
                        }
                    }
                } else {
                    self.openVoiceSession()
                }
            }
        }
    }

    /// v0.9.7: is Apple's speech recognition actually usable
    /// right now? Three walls, three handlings: notDetermined
    /// asks (the system popup is the meeting place — the app
    /// raises it rather than describing it); denied/restricted
    /// sets the prompt naming the Speech Recognition privacy
    /// pane; authorized-but-unavailable is the Dictation/Siri
    /// signature and sets that prompt. Only authorized AND
    /// available reports ready. Main thread only (it reads and
    /// sets published state).
    private func checkSpeechReadiness(completion: @escaping (Bool) -> Void) {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            completion(recognizerIsAvailable())
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if status == .authorized {
                        completion(self.recognizerIsAvailable())
                    } else {
                        self.voiceSpeechPrompt = .accessDenied
                        completion(false)
                    }
                }
            }
        default:
            voiceSpeechPrompt = .accessDenied
            completion(false)
        }
    }

    /// The Dictation/Siri wall, tested exactly the way the
    /// recognizer start tests it — no recognizer for the
    /// locale, or an unavailable one, while permission stands
    /// granted. Sets the prompt as its side effect: the caller
    /// only has to act on the bool.
    private func recognizerIsAvailable() -> Bool {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else {
            voiceSpeechPrompt = .dictationDisabled
            return false
        }
        return true
    }

    /// Deep-link to a System Settings pane — the app's existing
    /// x-apple.systempreferences convention (the Settings grant
    /// rows). The app cannot change these settings itself;
    /// opening the pane at the right switch is the deliverable.
    /// Choosing a pane also answers the prompt that sent the
    /// operator there.
    func openSystemSettings(pane: String) {
        if let url = URL(string: "x-apple.systempreferences:\(pane)") {
            NSWorkspace.shared.open(url)
        }
        voiceSpeechPrompt = nil
    }

    /// The preflight heard sound: open the session in the
    /// control plane and become a call. The probe audio in the
    /// stash is dropped, not sent — it was a level check, not a
    /// first sentence.
    private func openVoiceSession() {
        client.startVoiceSession { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.voiceCallStarting = false
                switch result {
                case .success(let session) where session.ok && session.active:
                    self.voiceSessionId = session.sessionId
                    self.voiceBargeIn = session.bargeIn ?? true
                    // v0.9.6: what this call actually uses — the
                    // control plane resolved (and probed) the
                    // modes at session start. The start detail
                    // already carries any fallback notice.
                    self.voiceSttMode = session.sttMode ?? "endpoint"
                    self.voiceTtsMode = session.ttsMode ?? "endpoint"
                    self.voiceTurns = session.turns
                    self.voiceLastSeq = 0
                    self.voicePlayQueue = []
                    self.voiceSpeakQueue = []
                    self.voiceLatencyLine = nil
                    self.voiceHearingLine = nil
                    self.voiceMicLevel = 0
                    self.voiceStashLock.lock()
                    self.voiceStash = Data()
                    self.voiceStashLock.unlock()
                    self.voiceInCall = true
                    self.notice = session.detail
                    self.voiceChunkTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                        self?.voiceChunkTick()
                    }
                    self.voicePollTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
                        self?.pollVoiceSession()
                    }
                    self.scheduleVoiceConvertGuard()
                    // v0.9.6: built-in ears start once the call
                    // exists (the recognizer needs the session to
                    // post transcripts to). Endpoint calls never
                    // start it — one set of ears per call.
                    if self.voiceSttMode == "local" {
                        self.startVoiceRecognition()
                    }
                case .success(let session):
                    self.stopVoiceCapture()
                    self.notice = session.detail
                case .failure(let e):
                    self.stopVoiceCapture()
                    self.notice = "The call didn't reach GUS: \(e.localizedDescription)"
                }
            }
        }
    }

    /// The End Call button: hang up in the control plane and
    /// close the microphone locally, in that order.
    func endVoiceCall() {
        guard voiceInCall else { return }
        teardownVoice(sendEnd: true)
        notice = "Call ended."
    }

    /// Start the microphone: engine first, tap second, converter
    /// later (lazily, from the buffers that actually arrive).
    /// Returns false — with the notice set — when the engine
    /// won't start. The capture runs during the preflight with
    /// no session behind it; the caller decides what a live
    /// capture becomes.
    ///
    /// Deliberately NO voice processing (v0.9.3): through
    /// 0.9.2 the call enabled the input node's voice processing
    /// (echo cancellation / gain control), and on Glenn's iMac
    /// that pipeline delivered frames of silence to a converter
    /// built from a pre-start format — every meter downstream
    /// read zero while the system input meter moved. Voice
    /// processing is out of the call path entirely now; echo
    /// management lives where it observably works: the barge-in
    /// energy thresholds and the server's VAD.
    @discardableResult
    private func beginVoiceCapture() -> Bool {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        voiceConverter = nil
        voiceConverterSourceFormat = nil
        // A fresh capture starts with clean evidence counters —
        // the preflight reads the peak, the converter guard
        // reads the deltas.
        voiceStashLock.lock()
        voiceConvertedFrames = 0
        voiceDroppedBuffers = 0
        voiceRawSpeechBuffers = 0
        voiceRawPeakLevel = 0
        voiceMicLevel = 0
        voiceStash = Data()
        voiceStashLock.unlock()
        engine.prepare()
        do {
            try engine.start()
        } catch {
            notice = "The microphone wouldn't start: \(error.localizedDescription)"
            return false
        }
        voiceEngine = engine
        // The tap goes on AFTER the engine is running and with
        // format nil, so buffers arrive in the input node's
        // true running format — whatever the hardware settled
        // on, not whatever a pre-start query claimed.
        input.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buffer, _ in
            self?.ingestVoiceBuffer(buffer)
        }
        return true
    }

    /// The converter guard (v0.9.3), replacing the v0.9.2
    /// restart-without-voice-processing health check (voice
    /// processing is gone, so there is nothing to restart
    /// without). Every 2 s of an open call it compares deltas:
    /// if buffers whose RAW level crossed the audible floor
    /// kept arriving while the converter produced ZERO frames,
    /// the converter is the failure — the call ends with that
    /// stated, loudly, instead of listening forever. A quiet
    /// room trips nothing: no raw speech, no conclusion.
    private func scheduleVoiceConvertGuard() {
        voiceConvertGuardTimer?.invalidate()
        voiceStashLock.lock()
        voiceGuardFramesMark = voiceConvertedFrames
        voiceGuardSpeechMark = voiceRawSpeechBuffers
        voiceStashLock.unlock()
        voiceGuardTicks = 0
        voiceConvertGuardTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self, self.voiceInCall else { return }
            self.voiceGuardTicks += 1
            guard self.voiceGuardTicks % 2 == 0 else { return }
            self.voiceStashLock.lock()
            let frames = self.voiceConvertedFrames
            let speech = self.voiceRawSpeechBuffers
            self.voiceStashLock.unlock()
            let dFrames = frames - self.voiceGuardFramesMark
            let dSpeech = speech - self.voiceGuardSpeechMark
            self.voiceGuardFramesMark = frames
            self.voiceGuardSpeechMark = speech
            if dSpeech > 0 && dFrames == 0 {
                self.notice = "Sound is reaching the app, but the call's audio converter is producing nothing from it — the call is closed. That's a converter failure, not a quiet room."
                self.teardownVoice(sendEnd: true)
            }
        }
    }

    /// Stop just the capture (timers, tap, engine, converter,
    /// stash) — the session, if one exists, stays open. The
    /// preflight's failure path uses this (no session ever
    /// existed); teardownVoice uses it too, on its way to
    /// ending the session as well.
    private func stopVoiceCapture() {
        voicePreflightTimer?.invalidate()
        voicePreflightTimer = nil
        voiceConvertGuardTimer?.invalidate()
        voiceConvertGuardTimer = nil
        voiceEngine?.inputNode.removeTap(onBus: 0)
        voiceEngine?.stop()
        voiceEngine = nil
        voiceConverter = nil
        voiceConverterSourceFormat = nil
        voiceStashLock.lock()
        voiceStash = Data()
        voiceStashLock.unlock()
    }

    /// Audio-thread work: measure one input buffer RAW, then
    /// convert it to the call's PCM16 shape and stash it.
    /// Nothing here posts, allocates UI, or touches published
    /// state — the chunk timer does all of that on the main
    /// thread.
    private func ingestVoiceBuffer(_ buffer: AVAudioPCMBuffer) {
        // The raw level FIRST, from the buffer exactly as the
        // microphone delivered it, before conversion touches
        // it (v0.9.3): this is the number the hearing line
        // shows as "mic", and the preflight + converter guard
        // read it. A conversion problem can no longer masquerade
        // as a silent microphone — the raw number says what the
        // mic actually sent.
        let raw = Self.rawBufferRms(buffer)
        voiceStashLock.lock()
        voiceMicLevel = Int(raw.rounded())
        if raw > voiceRawPeakLevel { voiceRawPeakLevel = raw }
        if raw > Self.voiceAudibleFloor {
            voiceRawSpeechBuffers += 1
            // v0.9.7: the mic-quiet half of the recognizer's
            // sentence-end test, read by the chunk timer.
            voiceLastLoudAt = Date()
        }
        voiceStashLock.unlock()

        // v0.9.6: the built-in recognizer eats the SAME buffer,
        // in the format the microphone delivered it — the Speech
        // framework takes the hardware's native format, so this
        // feed owes nothing to the converter below (a converter
        // failure can no longer starve the ears). The request
        // reference is read under the stash lock; append itself
        // is the framework's documented tap pattern.
        voiceStashLock.lock()
        let recognitionRequest = voiceRecognitionRequest
        voiceStashLock.unlock()
        recognitionRequest?.append(buffer)

        // The converter is built LAZILY from the first buffer's
        // actual format (and rebuilt whenever a buffer arrives
        // in a different one) — never from a format queried
        // before the engine started. 0.9.1/0.9.2 built one up
        // front from outputFormat(forBus:) and, on Glenn's
        // iMac, converted faithfully into silence.
        if voiceConverter == nil || !Self.sameAudioFormat(buffer.format, voiceConverterSourceFormat) {
            guard buffer.format.sampleRate > 0,
                  let fresh = AVAudioConverter(from: buffer.format, to: voiceTargetFormat) else {
                voiceStashLock.lock()
                voiceDroppedBuffers += 1
                voiceStashLock.unlock()
                return
            }
            voiceConverter = fresh
            voiceConverterSourceFormat = buffer.format
        }
        guard let converter = voiceConverter else { return }
        let ratio = voiceTargetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 128
        guard let out = AVAudioPCMBuffer(pcmFormat: voiceTargetFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var convertError: NSError?
        let status = converter.convert(to: out, error: &convertError) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, out.frameLength > 0, let channel = out.int16ChannelData?[0] else {
            // A buffer arrived and produced nothing — counted,
            // under the lock, for the converter guard. (Before
            // v0.9.2 this guard returned silently, which is why
            // a dead converter looked exactly like a quiet
            // room.)
            voiceStashLock.lock()
            voiceDroppedBuffers += 1
            voiceStashLock.unlock()
            return
        }
        let data = Data(bytes: channel, count: Int(out.frameLength) * 2)
        voiceStashLock.lock()
        voiceConvertedFrames += Int(out.frameLength)
        voiceStash.append(data)
        voiceStashLock.unlock()
    }

    /// Every ~250 ms while the call is open: ship the mic stash,
    /// watch for barge-in, fetch the next spoken segment, and
    /// keep the playback queue moving.
    private func voiceChunkTick() {
        guard voiceInCall, let id = voiceSessionId else { return }

        voiceStashLock.lock()
        let chunk = voiceStash
        voiceStash = Data()
        voiceStashLock.unlock()

        if !chunk.isEmpty {
            // This chunk's energy, for the barge-in check below
            // only. (The hearing line's "mic" number is NOT this
            // — since v0.9.3 it's the raw level the tap handler
            // measures before conversion, so the strip compares
            // what the microphone delivered against what the
            // server heard.)
            let chunkLevel = Self.pcmRms(chunk)
            // Barge-in, the app's half: sustained speech energy
            // while GUS is audibly talking means the operator is
            // talking over it — stop the player here, and tell
            // the control plane to drop the rest of the reply.
            if voiceBargeIn, voicePlayer?.isPlaying == true || voiceSynthesizer.isSpeaking {
                if chunkLevel > 900 {
                    voiceLoudStreak += 1
                } else {
                    voiceLoudStreak = 0
                }
                if voiceLoudStreak >= 2 {
                    voiceLoudStreak = 0
                    cutVoicePlayback()
                    client.interruptVoiceSession(sessionId: id) { _ in }
                }
            } else {
                voiceLoudStreak = 0
            }
            client.postVoiceSessionAudio(sessionId: id, pcm: chunk) { [weak self] result in
                if case .failure = result {
                    DispatchQueue.main.async {
                        guard let self, self.voiceInCall else { return }
                        self.notice = "The call's audio stopped reaching GUS — the call is closed here; start it again when the control plane answers."
                        self.teardownVoice(sendEnd: true)
                    }
                }
            }
        }

        client.voiceSessionNextAudio(sessionId: id, afterSeq: voiceLastSeq) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.voiceInCall else { return }
                if case .success(let seg) = result, let seq = seg.seq {
                    self.voiceLastSeq = seq
                    if let text = seg.text, !text.isEmpty {
                        // v0.9.6: a speak-text segment — for this
                        // call, this app is the mouth.
                        self.voiceSpeakQueue.append(text)
                    } else if let b64 = seg.audioBase64, let data = Data(base64Encoded: b64) {
                        self.voicePlayQueue.append(data)
                    }
                }
                self.advanceVoicePlayback()
                self.advanceVoiceSpeech()
            }
        }
        advanceVoicePlayback()
        advanceVoiceSpeech()
        // v0.9.7: the recognizer's sentence-end watch rides
        // the same ~250 ms beat as everything else in the call.
        advanceVoiceRecognition()
    }

    private func advanceVoicePlayback() {
        if voicePlayer?.isPlaying == true { return }
        guard !voicePlayQueue.isEmpty else {
            voicePlayer = nil
            return
        }
        let data = voicePlayQueue.removeFirst()
        voicePlayer = try? AVAudioPlayer(data: data)
        voicePlayer?.play()
    }

    private func cutVoicePlayback() {
        voicePlayer?.stop()
        voicePlayer = nil
        voicePlayQueue = []
        // v0.9.6: built-in speech cuts with the same stroke —
        // the synthesizer stops mid-word and its queue drops,
        // so a barge-in (or a hang-up) never leaves a sentence
        // talking over the operator.
        voiceSynthesizer.stopSpeaking(at: .immediate)
        voiceSpeakQueue = []
    }

    /// v0.9.6: built-in speech chaining — if the synthesizer is
    /// idle and a sentence is queued, speak it. Called from the
    /// chunk timer, the player's own no-delegate pattern.
    private func advanceVoiceSpeech() {
        if voiceSynthesizer.isSpeaking { return }
        guard !voiceSpeakQueue.isEmpty else { return }
        let text = voiceSpeakQueue.removeFirst()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        voiceSynthesizer.speak(utterance)
    }

    // MARK: Built-in ears (v0.9.6)

    /// Start the recognizer once readiness is proven — the
    /// same gate prepareVoiceSession ran before the session
    /// opened (for a call that fell back to built-in at its
    /// probe, this is where the gate runs instead). A wall
    /// ends the call with the reason stated AND the prompt
    /// raised: this call's ears were resolved as built-in, and
    /// a call must not sit in a fake "listening" state when
    /// the OS won't provide them — the silent-mic preflight's
    /// honesty rule, applied to the recognizer.
    private func startVoiceRecognition() {
        checkSpeechReadiness { [weak self] ready in
            guard let self, self.voiceInCall else { return }
            guard ready else {
                self.notice = "Built-in listening is walled off in System Settings — the call is closed; the prompt has the switches, one tap away."
                self.teardownVoice(sendEnd: true)
                return
            }
            self.beginVoiceRecognitionTask()
        }
    }

    /// One recognition task: on-device when the recognizer
    /// supports it (the words then never leave this Mac — the
    /// local-first posture in the framework's own terms).
    /// Partial results ON (v0.9.7): the partial is the sentence
    /// in progress, and advanceVoiceRecognition() ends its
    /// audio when the words stop changing and the mic goes
    /// quiet — that endAudio() is what makes the final below
    /// ever arrive mid-call. A final result is POSTed as the
    /// call's next transcript and the task restarts — Apple's
    /// per-task limit is about a minute, a call's limit is
    /// sixty (the same backstop lives in the sentence-end
    /// watch: ~50 s of continuous recognition ends the audio
    /// and banks the partial as a final).
    private func beginVoiceRecognitionTask() {
        guard voiceInCall, voiceSttMode == "local" else { return }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else {
            // v0.9.7: the Dictation/Siri wall, met with the
            // prompt (its buttons deep-link to the panes), not
            // a bare status line. Readiness was checked before
            // this start, so reaching here means availability
            // dropped in between — the handling is the same.
            voiceSpeechPrompt = .dictationDisabled
            notice = "Built-in speech recognition isn't available on this Mac right now — the call is closed. The prompt has the Dictation and Siri switches; in Settings → Voice you can also point transcription at an endpoint instead."
            teardownVoice(sendEnd: true)
            return
        }
        voiceRecognizer = recognizer
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        voiceStashLock.lock()
        voiceRecognitionRequest = request
        voiceStashLock.unlock()
        voiceRecognitionGen += 1
        let gen = voiceRecognitionGen
        // A fresh task starts with a clean sentence: no partial,
        // nothing ended, the backstop clock running from now.
        voicePartialText = ""
        voicePartialLastChange = Date()
        voiceTaskStartedAt = Date()
        voiceEndAudioSent = false
        voiceRecognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            if let result, result.isFinal {
                let text = result.bestTranscription.formattedString
                DispatchQueue.main.async {
                    guard let self, self.voiceInCall, gen == self.voiceRecognitionGen else { return }
                    // This task delivered its sentence — an
                    // error trailing it (the framework often
                    // appends one as a task winds down) is the
                    // sound of it closing, not a failure; the
                    // error branch below checks this mark.
                    self.voiceFinalGen = gen
                    if let id = self.voiceSessionId {
                        self.client.postVoiceSessionTranscript(sessionId: id, text: text) { _ in }
                    }
                    // Restart for the next sentence: cancel drops
                    // this task (its trailing error, if any, sees
                    // a stale generation and is ignored), and a
                    // fresh task takes over the ears.
                    self.voiceRecognitionTask?.cancel()
                    self.voiceRecognitionTask = nil
                    self.voiceStashLock.lock()
                    self.voiceRecognitionRequest = nil
                    self.voiceStashLock.unlock()
                    self.beginVoiceRecognitionTask()
                }
                return
            }
            if let result {
                // A partial: the sentence so far. Tracked —
                // text and the moment it last changed — for
                // the chunk timer's sentence-end watch. No
                // posting: a partial is a draft, and the turn
                // pipeline only ever sees finals.
                let text = result.bestTranscription.formattedString
                DispatchQueue.main.async {
                    guard let self, self.voiceInCall, gen == self.voiceRecognitionGen else { return }
                    if text != self.voicePartialText {
                        self.voicePartialText = text
                        self.voicePartialLastChange = Date()
                    }
                }
            }
            if let error {
                DispatchQueue.main.async {
                    guard let self, self.voiceInCall, gen == self.voiceRecognitionGen else { return }
                    if self.voiceFinalGen == gen {
                        // The error arrived AFTER this task's
                        // final — restart the ears for the next
                        // sentence instead of closing the call
                        // over a sentence that already landed.
                        self.voiceRecognitionTask = nil
                        self.voiceStashLock.lock()
                        self.voiceRecognitionRequest = nil
                        self.voiceStashLock.unlock()
                        self.beginVoiceRecognitionTask()
                        return
                    }
                    self.notice = "Built-in speech recognition stopped: \(error.localizedDescription) — the call is closed rather than left listening to nothing."
                    self.teardownVoice(sendEnd: true)
                }
            }
        }
    }

    /// v0.9.7: the sentence-end watch, run by the chunk timer
    /// (~250 ms) while a built-in call is open. When a partial
    /// exists, its words have been stable for ~0.9 s, and the
    /// mic itself has been quiet for ~0.9 s, the sentence is
    /// over: endAudio() forces the final that POSTs the
    /// transcript. The mic-quiet half matters — a partial can
    /// sit unchanged between two loud halves of one sentence,
    /// and the raw level (not the recognizer) says whether the
    /// operator is still talking. Backstop: ~50 s of continuous
    /// recognition with a partial outstanding also ends the
    /// audio, banking the words before Apple's ~1-minute
    /// per-task limit can take them. endAudio is sent at most
    /// once per task; the restarted task resets the flag.
    private func advanceVoiceRecognition() {
        guard voiceInCall, voiceSttMode == "local",
              voiceRecognitionTask != nil, !voiceEndAudioSent else { return }
        let partial = voicePartialText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !partial.isEmpty else { return }
        let now = Date()
        voiceStashLock.lock()
        let lastLoud = voiceLastLoudAt
        voiceStashLock.unlock()
        let sentenceDone = now.timeIntervalSince(voicePartialLastChange) >= 0.9
            && now.timeIntervalSince(lastLoud) >= 0.9
        let taskAged = now.timeIntervalSince(voiceTaskStartedAt) >= 50
        guard sentenceDone || taskAged else { return }
        voiceEndAudioSent = true
        voiceStashLock.lock()
        let request = voiceRecognitionRequest
        voiceStashLock.unlock()
        request?.endAudio()
    }

    /// Stop the recognizer: generation bump first (every pending
    /// callback from the old task becomes a no-op), then cancel.
    /// Called by teardownVoice — End Call, a server-side ending,
    /// and the kill phrase's ending all pass through there, so
    /// no path leaves the recognizer running past its call.
    private func stopVoiceRecognition() {
        voiceRecognitionGen += 1
        voiceRecognitionTask?.cancel()
        voiceRecognitionTask = nil
        voiceStashLock.lock()
        voiceRecognitionRequest?.endAudio()
        voiceRecognitionRequest = nil
        voiceStashLock.unlock()
        voiceRecognizer = nil
        // v0.9.7: no sentence survives the call it was spoken in.
        voicePartialText = ""
        voiceEndAudioSent = false
    }

    /// The state poll (~0.8 s): transcript, phase, elapsed,
    /// latency — and endings. If the server ended the call (the
    /// silence limit, the hour, the kill phrase), its detail
    /// says which, and the local side closes to match.
    private func pollVoiceSession() {
        guard voiceInCall, let id = voiceSessionId else { return }
        client.voiceSessionState(sessionId: id) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.voiceInCall else { return }
                guard case .success(let s) = result else { return }
                if !s.active {
                    self.voiceTurns = s.turns
                    self.notice = s.detail
                    self.teardownVoice(sendEnd: false)
                    self.refreshChat()
                    self.refreshJobs()
                    self.refreshApprovals()
                    return
                }
                self.voiceTurns = s.turns
                self.voicePhase = s.phase ?? "listening"
                self.voiceElapsedMs = s.elapsedMs ?? 0
                self.voiceBargeIn = s.bargeIn ?? self.voiceBargeIn
                if let l = s.lastLatency {
                    var line = "last turn — heard \(Self.seconds(l.sttMs)) · thought \(Self.seconds(l.jobMs))"
                    if let tts = l.ttsFirstMs { line += " · speaking after \(Self.seconds(tts))" }
                    self.voiceLatencyLine = line
                }
                if let h = s.hearing {
                    self.voiceHearingLine = "hearing — mic \(self.voiceMicLevel) · level \(Int(h.lastRms.rounded())) · peak \(Int(h.maxRms.rounded())) · in a sentence \(Self.seconds(h.inUtteranceMs)) · heard \(h.utterancesCompleted)"
                } else {
                    self.voiceHearingLine = nil
                }
            }
        }
    }

    /// Close the local call: timers off, tap removed, engine
    /// stopped, player cut. sendEnd also hangs up in the control
    /// plane (exactly once — the session id is gone afterwards).
    private func teardownVoice(sendEnd: Bool) {
        if sendEnd, let id = voiceSessionId {
            client.endVoiceSession(sessionId: id) { _ in }
        }
        voiceChunkTimer?.invalidate()
        voiceChunkTimer = nil
        voicePollTimer?.invalidate()
        voicePollTimer = nil
        stopVoiceRecognition()
        stopVoiceCapture()
        cutVoicePlayback()
        voiceSessionId = nil
        voiceInCall = false
        voicePhase = "listening"
    }

    private static func seconds(_ ms: Double) -> String {
        String(format: "%.1fs", ms / 1000)
    }

    /// RMS of a tap buffer AS DELIVERED, before any conversion
    /// (v0.9.3), on the int16 scale: float samples are scaled by
    /// 32767, int16 samples read directly, int32 samples scaled
    /// down by 65536 (their full scale is 65536× the int16
    /// scale). Channel 0 only — this is a level, not a mixdown.
    /// Zero for empty buffers and formats with no readable
    /// channel data.
    private static func rawBufferRms(_ buffer: AVAudioPCMBuffer) -> Double {
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return 0 }
        if let floats = buffer.floatChannelData {
            let ch = floats[0]
            var sum: Double = 0
            for i in 0..<frames {
                let s = Double(ch[i])
                sum += s * s
            }
            return (sum / Double(frames)).squareRoot() * 32_767
        }
        if let ints = buffer.int16ChannelData {
            let ch = ints[0]
            var sum: Double = 0
            for i in 0..<frames {
                let s = Double(ch[i])
                sum += s * s
            }
            return (sum / Double(frames)).squareRoot()
        }
        if let wide = buffer.int32ChannelData {
            let ch = wide[0]
            var sum: Double = 0
            for i in 0..<frames {
                let s = Double(ch[i]) / 65_536
                sum += s * s
            }
            return (sum / Double(frames)).squareRoot()
        }
        return 0
    }

    /// Whether two audio formats are the same for converter
    /// purposes — the lazy converter rebuilds when an arriving
    /// buffer's format differs from the one it was built from.
    private static func sameAudioFormat(_ a: AVAudioFormat, _ b: AVAudioFormat?) -> Bool {
        guard let b else { return false }
        return a.sampleRate == b.sampleRate
            && a.channelCount == b.channelCount
            && a.commonFormat == b.commonFormat
            && a.isInterleaved == b.isInterleaved
    }

    /// RMS of one raw PCM16 chunk (the call's audio shape), on
    /// the int16 scale — the barge-in energy check. Read byte by
    /// byte: no alignment assumptions about the buffer.
    private static func pcmRms(_ data: Data) -> Double {
        guard data.count >= 2 else { return 0 }
        var sum: Double = 0
        var n = 0
        var i = 0
        while i + 1 < data.count {
            var v = (Int32(data[i + 1]) << 8) | Int32(data[i])
            if v >= 32_768 { v -= 65_536 }
            sum += Double(v) * Double(v)
            n += 1
            i += 2
        }
        return n > 0 ? (sum / Double(n)).squareRoot() : 0
    }

    func resolve(_ approval: PanelApproval, approve: Bool) {
        let path = "/api/approvals/\(approval.id)/\(approve ? "approve" : "deny")"
        client.post(path) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let r):
                    self.notice = r.detail
                case .failure(let e):
                    self.notice = "Could not reach the panel: \(e.localizedDescription)"
                }
                self.refreshApprovals()
                self.refreshChat()
                self.refreshStatus()
            }
        }
    }

    // MARK: Polling

    func refreshAll() {
        refreshStatus()
        refreshChat()
        refreshJobs()
        refreshApprovals()
        refreshOnboarding()
    }

    // MARK: First-run setup (v0.8 — the wizard, in the app)

    /// The first-run signal, the same one the web wizard works
    /// from: the provider step isn't done AND GUS has no working
    /// brain yet (the offline stub, or a key-requiring provider
    /// whose key is missing). A hand-configured install whose
    /// wizard steps were never recorded does NOT trip this — its
    /// provider works, so there is nothing to set up.
    var needsSetup: Bool {
        guard let onboarding, let status else { return false }
        if onboarding.steps.provider.done { return false }
        return status.provider.id == "stub" || status.settings.providerKey == "missing"
    }

    private func refreshOnboarding() {
        client.get("/api/onboarding", as: PanelOnboarding.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let o) = result {
                    self.onboarding = o
                    if self.needsSetup && !self.setupAutoShown {
                        self.setupAutoShown = true
                        self.setupPresented = true
                    }
                }
            }
        }
    }

    /// One wizard step. Every step is the panel's own onboarding
    /// endpoint — the same call the web wizard makes, with the
    /// same vault/governor landings; the app adds no path of its
    /// own. The panel's detail text becomes the notice verbatim.
    private func setupAction(_ path: String, body: [String: Any] = [:], thenChat: Bool = false) {
        client.post(path, jsonBody: body) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let r):
                    self.notice = r.detail
                case .failure(let e):
                    self.notice = "Could not reach the panel: \(e.localizedDescription)"
                }
                self.refreshOnboarding()
                self.refreshStatus()
                if thenChat { self.refreshChat(); self.refreshJobs() }
            }
        }
    }

    func setupShield(failMode: String) {
        setupAction("/api/onboarding/shield", body: ["onUnavailable": failMode])
    }

    func setupTelegram(token: String) {
        setupAction("/api/onboarding/telegram", body: ["token": token])
    }

    func setupProvider(provider: String, model: String, apiKey: String, baseUrl: String) {
        var body: [String: Any] = ["provider": provider, "model": model]
        if !apiKey.isEmpty { body["apiKey"] = apiKey }
        if !baseUrl.isEmpty { body["baseUrl"] = baseUrl }
        setupAction("/api/onboarding/provider", body: body)
    }

    func setupCaps(task: Double, day: Double, month: Double) {
        setupAction("/api/onboarding/caps",
                    body: ["maxUsdPerTask": task, "maxUsdPerDay": day, "maxUsdPerMonth": month])
    }

    func setupFirstJob() {
        setupAction("/api/onboarding/first-job", thenChat: true)
    }

    private func refreshStatus() {
        client.get("/api/status", as: PanelStatus.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let s):
                    self.status = s
                    self.reachable = true
                case .failure:
                    self.status = nil
                    self.reachable = false
                }
            }
        }
    }

    private func refreshChat() {
        client.get("/api/chat/history", as: PanelChatHistory.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let h) = result {
                    self.chatMessages = h.messages
                    self.chatJobs = h.jobs
                }
            }
        }
    }

    private func refreshJobs() {
        client.get("/api/jobs", as: [PanelJob].self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let j) = result { self.jobs = j }
            }
        }
    }

    private func refreshApprovals() {
        client.get("/api/approvals", as: [PanelApproval].self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let a) = result { self.approvals = a }
            }
        }
        client.get("/api/approvals/history", as: [PanelApprovalHistoryEntry].self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let h) = result { self.approvalsHistory = h }
            }
        }
    }
}
