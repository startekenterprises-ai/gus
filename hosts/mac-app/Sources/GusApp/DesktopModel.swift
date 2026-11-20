import AppKit
import AVFoundation
import Foundation
import Speech
import UniformTypeIdentifiers

/// Cross-window requests, posted by views and observed by the app
/// delegate (windows) or this model (the setup sheet).
extension Notification.Name {
    static let gusOpenSettings = Notification.Name("gus.openSettings")
    static let gusCheckForUpdates = Notification.Name("gus.checkForUpdates")
    static let gusRunSetup = Notification.Name("gus.runSetup")
    /// v0.14.0: Settings lives in the main window now — the app
    /// delegate forwards .gusOpenSettings as this, and this
    /// model answers it by selecting the Settings section (and
    /// the pane named in userInfo["section"], a SettingsSection
    /// rawValue, when one rides along).
    static let gusShowSettingsSection = Notification.Name("gus.showSettingsSection")
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
/// it would on the operator's phone. v0.14.0 splits that timer
/// into lanes and gates every publish on a real change — see
/// init and the refresh functions.
final class DesktopModel: ObservableObject {
    enum Section {
        case chat
        case jobs
        case approvals
        case gateways
        /// v0.14.0: Settings as a section of this window — the
        /// separate Settings window is gone (see RootView).
        case settings
    }

    @Published var section: Section = .chat
    /// v0.14.0: the Settings section's selected pane, so a
    /// deep link (the Identity tab's "Open Settings → Voice")
    /// can preselect it from outside the Settings view.
    @Published var settingsSection: SettingsSection = .protection
    @Published var reachable = false
    @Published var status: PanelStatus?
    @Published var chatMessages: [PanelChatMessage] = []
    @Published var chatJobs: [PanelJob] = []
    /// v0.11.0 (the secure log): the Watch timeline — the
    /// durable event + gate logs merged, newest first — polled
    /// on the same 2.5 s beat as everything else in this model.
    /// The secure log renders it (reversed into chronological
    /// order; since v0.12.0 the log lives in the Jobs section
    /// and Chat shows only its newest line on the status
    /// strip); nothing here filters or rewrites it, so the
    /// log's lines are the records themselves.
    @Published var timeline: [PanelTimelineEntry] = []
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
    /// GUI polish (2026-11-16): composer dictation — the mic
    /// button beside Send. A self-contained sitting of the same
    /// built-in ears the call uses (Speech framework, on-device
    /// when supported): its own engine and recognizer task,
    /// live partials written straight into the composer, and
    /// nothing leaves the app — dictated words become a typed
    /// message only when the operator presses Send, and pass
    /// the same scan/caps/receipts as one. It never runs during
    /// a call (the microphone belongs to the call), and a call
    /// starting stops it first.
    @Published var dictating = false
    private var dictationEngine: AVAudioEngine?
    private var dictationRequest: SFSpeechAudioBufferRecognitionRequest?
    private var dictationTask: SFSpeechRecognitionTask?
    private var dictationGen = 0
    /// The composer text as it stood when dictation started;
    /// partials and the final append to it, never replace it.
    private var dictationBaseText = ""
    private var dictationBackstopTimer: Timer?
    /// v0.9.1 (Call GUS, live): an open call is a session in the
    /// control plane. The microphone streams only while
    /// voiceInCall — nothing listens outside a call the operator
    /// started. Turns render from the session state's own
    /// records (the poll below); the jobs behind them are
    /// ordinary jobs with ordinary receipts in the Jobs view.
    @Published var voiceInCall = false
    /// v0.9.11: the call's Shield mode for spoken turns, from
    /// the session state ("fast" / "off"; nil when the control
    /// plane doesn't report one). The in-call strip renders it
    /// as a chip next to Mute — the operator kept having to dig
    /// through Settings mid-call to learn which way the
    /// Shield-scan switch sat.
    @Published var voiceShieldMode: String?
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
    // v0.14.7 (the empty-final ladder): the built-in recognizer
    // sometimes ends a task with an EMPTY final over speech it
    // plainly received — the field failure behind "voice is
    // unresponsive" (the turn dies recorded as an empty
    // transcript, nothing sent). Two rescues, in order, live in
    // the final handler: bank the last partial (the recognizer
    // DID hear those words), else replay this sentence's own
    // buffers into one fresh task. The buffers are the tap's
    // native-format deliveries, stashed at the same point they
    // are appended to the live request (audio thread, under
    // voiceStashLock), capped, and cleared at every task start
    // that is not the replay itself.
    private var voiceSentenceBuffers: [AVAudioPCMBuffer] = []
    /// Buffers handed to the next task start for replay; nil on
    /// every ordinary start. Set only by the final handler.
    private var voiceRetryBuffers: [AVAudioPCMBuffer]?
    /// True while the live task is the replay retry — its own
    /// empty final posts as-is (the ladder has one rung).
    private var voiceTaskIsRetry = false
    /// voiceRawSpeechBuffers as the live task started: the
    /// final handler compares deltas to know the mic actually
    /// delivered speech during THIS task before spending the
    /// replay on it (a quiet room earns no retry).
    private var voiceTaskSpeechMark = 0
    private var voiceLastLoudAt = Date.distantPast
    /// v0.9.7: the Settings prompt when built-in listening is
    /// walled off by macOS — ChatView presents it; its buttons
    /// deep-link to the panes GUS can't flip itself.
    @Published var voiceSpeechPrompt: VoiceSpeechPrompt?
    /// v0.9.8: the call's mute state — the operator's
    /// dog-barking control. Published for the Mute button and
    /// the hearing line; the audio thread reads the lock-guarded
    /// twin below (voiceCaptureMuted, under voiceStashLock like
    /// every other capture-side flag) and drops buffers whole
    /// while it stands. Muted stops the ears only: GUS can
    /// still speak, the session stays open, the timers run.
    @Published var voiceMuted = false
    private var voiceCaptureMuted = false
    /// v0.9.11: the echo gate — GUS must never hear HIMSELF.
    /// Capture has run without voice processing since 0.9.3, so
    /// in a built-in call the recognizer transcribes whatever
    /// the speakers play: the greeting, the "Just a second."
    /// filler, the replies — each becoming a new turn nobody
    /// spoke (Glenn's logs, 2026-11-12). While the built-in
    /// synthesizer is speaking (or holding a queue) and for
    /// 0.6 s after, the tap feeds the recognizer NOTHING and
    /// any in-progress partial is discarded, exactly as the
    /// mute path discards it. voiceCaptureEchoGated is the
    /// lock-guarded flag the audio thread reads (voiceStashLock,
    /// like voiceCaptureMuted); the engaged/last-seen pair is
    /// main-thread state, worked by the chunk timer in
    /// updateVoiceEchoGate(). The accepted price, chosen with
    /// the fix: in a built-in call you can no longer barge in
    /// by talking over GUS — Mute and End Call still work, and
    /// endpoint calls (server speech, energy barge-in) are
    /// untouched.
    private var voiceCaptureEchoGated = false
    private var voiceEchoGateEngaged = false
    private var voiceEchoSpeechLastSeen = Date.distantPast
    /// The last action's outcome, in the panel's own words (or the
    /// transport error). Shown under the composer / sidebar so a
    /// refusal is never silent.
    @Published var notice: String?
    /// Bumped by "New chat": ChatView watches it and focuses the
    /// composer. (The panel chat is one durable operator
    /// conversation; a new chat means a fresh turn in it.)
    @Published var composerFocusToken = 0
    /// v0.10.1: the Chats slide-over's visibility — toggled
    /// from the top bar, dismissed by selection or a tap on
    /// the scrim. Chrome state only; the list it shows is the
    /// chat history this model already polls.
    @Published var chatsPanelPresented = false
    /// v0.10.1 (Identity): the operator's name for their
    /// agent — shown under the avatar in the Identity tab and
    /// wherever the app names the agent (the chat bubbles'
    /// speaker label). App-side only: a UserDefaults string,
    /// never sent to the control plane; the default is "GUS".
    @Published var displayName = "GUS"
    /// v0.10.1 (Identity): the operator's chosen avatar,
    /// loaded from the app's state dir (see avatarFilePath);
    /// nil means no custom photo — the bundled default avatar
    /// (v0.11.1, see defaultAvatarImage) stands in.
    @Published var avatarImage: NSImage?
    /// v0.11.0: the operator's chosen BUILT-IN speech voice —
    /// an AVSpeechSynthesisVoice identifier from the voices
    /// installed on this Mac, or "" for the Mac's default
    /// voice. App-side only, like the display name: a
    /// UserDefaults string (gus.localTtsVoiceId — the same key
    /// Settings → Voice's @AppStorage binds, so the two pickers
    /// are one setting), never sent to the control plane:
    /// voice.json's ttsVoice names an ENDPOINT voice and means
    /// nothing to the built-in engine, so the built-in choice
    /// lives here rather than overloading that field.
    @Published var localTtsVoiceId = ""
    /// The test synthesizer: separate from the call's, so a
    /// test sentence never queues behind (or cuts into) a
    /// call's speech.
    private var localVoiceTestSynthesizer = AVSpeechSynthesizer()
    /// v0.10.1 (Identity): the voice settings on file, for
    /// the Identity tab's voice picker — read from the same
    /// /api/voice/settings the Settings section edits, and
    /// written back through it (setTtsVoice below), so there
    /// is one voice.json and two editors, never two stores.
    @Published var voiceSettings: PanelVoiceSettings?
    /// v0.10.1 (Identity): the context pack's status for the
    /// Memory summary (GET /api/memory/status). Nil until the
    /// control plane answers — and stays nil against a panel
    /// where Memory isn't wired (it answers 501).
    @Published var memoryStatus: PanelMemoryStatus?
    /// The Invite share sheet, retained while it is on
    /// screen: NSSharingServicePicker is a transient object,
    /// and letting it deallocate mid-presentation would
    /// dismiss the sheet under the operator.
    private var sharePicker: NSSharingServicePicker?

    private let client = PanelClient()
    private var timer: Timer?
    /// v0.14.0 (shell performance): the poll's tick counter —
    /// the timer's lanes are counted in ticks, not seconds
    /// (see init). refreshAll() ignores the lanes entirely.
    private var pollTick = 0
    /// v0.14.0 (shell performance): poll suspension — RootView
    /// sets this as the root view appears and disappears, so a
    /// window that isn't on screen stops polling the panel.
    /// Voice-session timers are separate and never read this.
    var pollingSuspended = false

    init() {
        loadIdentity()
        refreshAll()
        refreshIdentitySession()
        // v0.14.0 (shell performance): the 2.5 s beat splits
        // into lanes — the fast lane (status, chat, approvals)
        // runs every tick; jobs and the timeline every 3rd tick
        // (~7.5 s); the slow reads (onboarding, voice settings,
        // memory status) and the avatar-file check every 12th
        // (~30 s). Actions still call refreshAll() /
        // refreshX() directly and land immediately; the lanes
        // only govern the idle poll, which was re-rendering the
        // whole window eight times a minute for data that
        // mostly hadn't changed.
        timer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in
            guard let self, !self.pollingSuspended else { return }
            self.pollTick += 1
            self.refreshStatus()
            self.refreshChat()
            self.refreshApprovals()
            if self.pollTick % 3 == 0 {
                self.refreshJobs()
                self.refreshTimeline()
            }
            if self.pollTick % 12 == 0 {
                self.refreshOnboarding()
                self.refreshVoiceSettings()
                self.refreshMemoryStatus()
                self.reloadAvatarIfChanged()
            }
        }
        NotificationCenter.default.addObserver(forName: .gusRunSetup, object: nil, queue: .main) { [weak self] _ in
            self?.setupPresented = true
        }
        // v0.14.0: Settings is a section of this window — the
        // app delegate forwards every .gusOpenSettings here;
        // a "section" userInfo value (a SettingsSection
        // rawValue) preselects that pane.
        NotificationCenter.default.addObserver(forName: .gusShowSettingsSection, object: nil, queue: .main) { [weak self] note in
            guard let self else { return }
            if let raw = note.userInfo?["section"] as? String,
               let pane = SettingsSection(rawValue: raw) {
                self.settingsSection = pane
            }
            self.section = .settings
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

    /// v0.14.0: the header avatar's state, derived from what
    /// the model already polls — a parked approval outranks
    /// everything (it is the one state that needs the
    /// operator), a call's phase comes next, then any running
    /// job, then idle. Pure derivation, no new polling.
    var avatarState: AvatarState {
        if !approvals.isEmpty { return .needsApproval }
        if voiceInCall {
            switch voicePhase {
            case "speaking": return .speaking
            case "thinking": return .thinking
            default: return .listening
            }
        }
        if jobs.contains(where: { $0.state == "running" }) { return .working }
        return .idle
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
        // Sending ends any dictation sitting first — the words
        // on screen are the message; the recognizer must not
        // keep appending to a composer that just emptied.
        if dictating { stopComposerDictation() }
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

    // MARK: Composer dictation (GUI polish, 2026-11-16)

    /// The composer's mic button: tap to dictate, tap again to
    /// stop. The gates are the call's own, in the call's order —
    /// microphone permission first (the system popup is the
    /// meeting place), then the speech-readiness check, whose
    /// walls raise the same Settings prompt the call raises.
    /// During a call the microphone is the call's: dictation
    /// refuses, in the notice, rather than fighting it for the
    /// input device.
    func toggleComposerDictation() {
        if dictating {
            stopComposerDictation()
            return
        }
        guard !voiceInCall else {
            notice = "The microphone belongs to the call right now — dictation starts when the call ends."
            return
        }
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                guard granted else {
                    self.notice = "Microphone access is off for GUS — grant it in System Settings → Privacy & Security → Microphone, then try dictation again."
                    return
                }
                self.checkSpeechReadiness { [weak self] ready in
                    guard let self else { return }
                    guard ready else {
                        // The readiness check set the prompt;
                        // its buttons open the exact panes.
                        self.notice = "Dictation wasn't started: built-in listening is walled off in System Settings — the prompt has the switches, one tap away."
                        return
                    }
                    self.beginComposerDictation()
                }
            }
        }
    }

    /// One dictation sitting: a fresh engine + recognition task,
    /// mirroring the call ears' documented pattern (engine
    /// started first, tap installed after with format nil so
    /// buffers arrive in the input's true running format, the
    /// request fed straight from the tap). Partials rewrite the
    /// composer as base + words-so-far; the final banks them
    /// and ends the sitting. A ~50 s backstop ends a sitting
    /// the operator forgot, before Apple's per-task limit can
    /// take the words. The generation counter keeps a stopped
    /// sitting's trailing callbacks from acting.
    private func beginComposerDictation() {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else {
            voiceSpeechPrompt = .dictationDisabled
            notice = "Built-in speech recognition isn't available on this Mac right now — dictation can't start. The prompt has the Dictation and Siri switches."
            return
        }
        let engine = AVAudioEngine()
        engine.prepare()
        do {
            try engine.start()
        } catch {
            notice = "The microphone wouldn't start: \(error.localizedDescription)"
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        dictationEngine = engine
        dictationRequest = request
        dictationGen += 1
        let gen = dictationGen
        dictationBaseText = composerText
        dictating = true
        engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: nil) { buffer, _ in
            request.append(buffer)
        }
        dictationTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.dictating, gen == self.dictationGen else { return }
                if let result {
                    self.composerText = self.dictationJoined(result.bestTranscription.formattedString)
                    if result.isFinal {
                        self.stopComposerDictation()
                    }
                    return
                }
                if let error {
                    self.notice = "Dictation stopped: \(error.localizedDescription) — the words already in the composer are yours to keep or clear."
                    self.stopComposerDictation()
                }
            }
        }
        dictationBackstopTimer = Timer.scheduledTimer(withTimeInterval: 50, repeats: false) { [weak self] _ in
            self?.stopComposerDictation()
        }
    }

    /// The dictated words appended to whatever the composer
    /// already held — dictation adds a sentence, it never
    /// replaces typing.
    private func dictationJoined(_ spoken: String) -> String {
        let base = dictationBaseText
        if base.isEmpty { return spoken }
        if spoken.isEmpty { return base }
        return base.hasSuffix(" ") ? base + spoken : base + " " + spoken
    }

    /// End a sitting: generation bump first (every pending
    /// callback becomes a no-op), then task, tap, engine. The
    /// words already written into the composer stay — stopping
    /// is not undoing.
    func stopComposerDictation() {
        dictationBackstopTimer?.invalidate()
        dictationBackstopTimer = nil
        dictationGen += 1
        dictationTask?.cancel()
        dictationTask = nil
        dictationRequest = nil
        dictationEngine?.inputNode.removeTap(onBus: 0)
        dictationEngine?.stop()
        dictationEngine = nil
        dictating = false
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
        // One microphone, one sitter: a dictation sitting ends
        // before the call's preflight takes the input.
        if dictating { stopComposerDictation() }
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
                    // v0.9.11: the call's Shield mode, for the
                    // strip's chip (nil from an older control
                    // plane — no chip, exactly as before).
                    self.voiceShieldMode = session.shieldMode
                    self.voiceTurns = session.turns
                    self.voiceLastSeq = 0
                    self.voicePlayQueue = []
                    self.voiceSpeakQueue = []
                    self.voiceLatencyLine = nil
                    self.voiceHearingLine = nil
                    self.voiceMicLevel = 0
                    // v0.9.8: every call starts unmuted.
                    self.voiceMuted = false
                    // v0.9.11: and with the echo gate down — it
                    // engages on its own when GUS first speaks.
                    self.voiceEchoGateEngaged = false
                    self.voiceStashLock.lock()
                    self.voiceCaptureMuted = false
                    self.voiceCaptureEchoGated = false
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

    /// The Mute button (v0.9.8), mid-call only. Muting is
    /// immediate and total on the capture side: the flag the
    /// tap handler reads flips first, so the very next buffer
    /// is dropped whole — never appended to the recognizer,
    /// never converted or stashed, so nothing posts to the
    /// session and room noise can't open a sentence or trigger
    /// barge-in. The in-progress partial is DISCARDED, not
    /// banked: the recognition task ends without a final (the
    /// generation bump makes its trailing callbacks no-ops,
    /// the same discipline as stopVoiceRecognition), the
    /// unposted stash clears, and the barge-in streak resets.
    /// Unmuting restarts the recognizer task if this call's
    /// ears are built-in; endpoint calls just resume posting
    /// chunks. Playback is untouched either way — muting is
    /// about the ears, not the mouth.
    func toggleVoiceMute() {
        guard voiceInCall else { return }
        let muted = !voiceMuted
        voiceStashLock.lock()
        voiceCaptureMuted = muted
        if muted { voiceStash = Data(); voiceSentenceBuffers = [] }
        voiceStashLock.unlock()
        if muted { voiceRetryBuffers = nil }
        voiceMuted = muted
        if muted {
            voiceRecognitionGen += 1
            voiceRecognitionTask?.cancel()
            voiceRecognitionTask = nil
            voiceStashLock.lock()
            voiceRecognitionRequest = nil
            voiceStashLock.unlock()
            voicePartialText = ""
            voicePartialLastChange = Date()
            voiceEndAudioSent = false
            voiceLoudStreak = 0
            notice = "Muted — GUS hears nothing until you unmute."
        } else {
            notice = "Unmuted — listening again."
            if voiceSttMode == "local" {
                beginVoiceRecognitionTask()
            }
        }
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
        // v0.9.8: muted means the buffer goes NOWHERE — not
        // measured (the hearing line reads "Muted", not a
        // level), not appended to the recognizer, not
        // converted or stashed. The converter guard is safe
        // by construction: it trips on raw-speech deltas, and
        // a muted mic produces none.
        voiceStashLock.lock()
        let muted = voiceCaptureMuted
        voiceStashLock.unlock()
        if muted { return }

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
        // v0.9.11: the echo gate rides the same read — while
        // GUS is speaking through the built-in synthesizer (and
        // for the tail after), the buffer is measured and
        // converted as always (the hearing line and the session
        // telemetry keep their numbers) but NEVER appended to
        // the recognizer: GUS's own voice must not become a
        // turn. Only the recognizer feed is gated; the PCM path
        // below is unchanged.
        voiceStashLock.lock()
        let recognitionRequest = voiceRecognitionRequest
        let echoGated = voiceCaptureEchoGated
        // v0.14.7: the same buffers the recognizer hears are
        // stashed for the empty-final replay — only while a
        // task is live, and only the buffers it actually gets
        // (an echo-gated buffer was never the operator's
        // sentence). Capped well past any sentence; the stash
        // clears at every task start that is not the replay.
        if !echoGated && recognitionRequest != nil && voiceSentenceBuffers.count < 3000 {
            voiceSentenceBuffers.append(buffer)
        }
        voiceStashLock.unlock()
        if !echoGated {
            recognitionRequest?.append(buffer)
        }

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
        // v0.9.11: work the echo gate on the same beat, after
        // playback has advanced — the speaking state it reads
        // is this tick's freshest.
        updateVoiceEchoGate()
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
    /// v0.11.0: the utterance speaks with the operator's chosen
    /// built-in voice (see the local-voice section below) — the
    /// picker's whole point is that this line honors it.
    private func advanceVoiceSpeech() {
        if voiceSynthesizer.isSpeaking { return }
        guard !voiceSpeakQueue.isEmpty else { return }
        let text = voiceSpeakQueue.removeFirst()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.localSpeechVoice()
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        voiceSynthesizer.speak(utterance)
    }

    /// v0.9.11: the echo gate's driver, run by the chunk timer
    /// (~250 ms) in a built-in call — and ONLY a built-in call:
    /// the gate exists for the arrangement where this app is both
    /// the ears (Speech-framework recognizer) and the mouth
    /// (AVSpeechSynthesizer). An endpoint mouth is server audio
    /// through the player, whose energy barge-in is the designed
    /// behavior; an endpoint ear has no recognizer to feed.
    ///
    /// Engaging (GUS starts speaking — synthesizer active or a
    /// sentence still queued): the tap's recognizer feed closes
    /// (voiceCaptureEchoGated, read under the stash lock), and
    /// any in-progress partial is DISCARDED, never posted — the
    /// recognition task ends without a final, the generation
    /// bump makes its trailing callbacks no-ops, exactly the
    /// mute path's discipline in toggleVoiceMute.
    ///
    /// Lifting (speech over, plus a 0.6 s tail for the room's
    /// last echo and the synthesizer's decay): the feed opens
    /// and a fresh recognition task starts — unless the call is
    /// muted, in which case Unmute owns the restart, as it
    /// already does.
    private func updateVoiceEchoGate() {
        guard voiceSttMode == "local", voiceTtsMode == "local" else { return }
        let speaking = voiceSynthesizer.isSpeaking || !voiceSpeakQueue.isEmpty
        if speaking {
            voiceEchoSpeechLastSeen = Date()
            if !voiceEchoGateEngaged {
                voiceEchoGateEngaged = true
                voiceStashLock.lock()
                voiceCaptureEchoGated = true
                voiceStashLock.unlock()
                voiceRecognitionGen += 1
                voiceRecognitionTask?.cancel()
                voiceRecognitionTask = nil
                voiceStashLock.lock()
                voiceRecognitionRequest = nil
                voiceStashLock.unlock()
                voicePartialText = ""
                voicePartialLastChange = Date()
                voiceEndAudioSent = false
            }
            return
        }
        if voiceEchoGateEngaged,
           Date().timeIntervalSince(voiceEchoSpeechLastSeen) >= 0.6 {
            voiceEchoGateEngaged = false
            voiceStashLock.lock()
            voiceCaptureEchoGated = false
            voiceStashLock.unlock()
            if !voiceMuted {
                beginVoiceRecognitionTask()
            }
        }
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
        // v0.14.7: a fresh task starts a fresh sentence — the
        // replay stash clears and the speech counter is marked
        // here — unless this start IS the empty-final replay,
        // which consumes the stash instead (below, once the
        // task exists).
        let retryBuffers = voiceRetryBuffers
        voiceRetryBuffers = nil
        voiceTaskIsRetry = retryBuffers != nil
        voiceStashLock.lock()
        if retryBuffers == nil { voiceSentenceBuffers = [] }
        voiceTaskSpeechMark = voiceRawSpeechBuffers
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
                    // v0.14.7: the empty-final ladder (see the
                    // state declarations). An empty final over a
                    // sentence the recognizer partially heard
                    // banks the partial — those words were real,
                    // and the framework's final dropping them is
                    // its quirk, not the operator's silence. An
                    // empty final with NO partial but with speech
                    // on the mic replays the sentence's own
                    // buffers into one fresh task instead of
                    // posting the empty transcript. Only when
                    // neither rescue applies — or the retry itself
                    // came back empty — does the empty final post
                    // exactly as before, and the turn records it.
                    var textToPost = text
                    var replay = false
                    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        let partial = self.voicePartialText.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !partial.isEmpty {
                            textToPost = partial
                        } else if !self.voiceTaskIsRetry {
                            self.voiceStashLock.lock()
                            let heardSpeech = self.voiceRawSpeechBuffers > self.voiceTaskSpeechMark
                            let buffers = self.voiceSentenceBuffers
                            self.voiceStashLock.unlock()
                            if heardSpeech && !buffers.isEmpty {
                                self.voiceRetryBuffers = buffers
                                replay = true
                            }
                        }
                    }
                    if !replay, let id = self.voiceSessionId {
                        self.client.postVoiceSessionTranscript(sessionId: id, text: textToPost) { _ in }
                    }
                    // Restart for the next sentence: cancel drops
                    // this task (its trailing error, if any, sees
                    // a stale generation and is ignored), and a
                    // fresh task takes over the ears. On the
                    // replay path the fresh task is the retry —
                    // beginVoiceRecognitionTask consumes
                    // voiceRetryBuffers into it.
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
        // v0.14.7: the replay rung — feed the sentence's own
        // buffers into this fresh task and end its audio, so
        // its final is a second hearing of the same words.
        if let retryBuffers {
            for buffer in retryBuffers { request.append(buffer) }
            request.endAudio()
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
        // v0.14.7: no sentence — and no pending replay — survives
        // the call it was spoken in.
        voiceSentenceBuffers = []
        voiceStashLock.unlock()
        voiceRetryBuffers = nil
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
                // v0.9.11: the Shield mode rides every poll, the
                // start answer's value kept current (a mid-call
                // settings edit still lands on the NEXT call —
                // the control plane resolves it at call start —
                // so in practice this simply confirms it).
                self.voiceShieldMode = s.shieldMode
                self.voiceBargeIn = s.bargeIn ?? self.voiceBargeIn
                if let l = s.lastLatency {
                    var line = "last turn — heard \(Self.seconds(l.sttMs)) · thought \(Self.seconds(l.jobMs))"
                    if let tts = l.ttsFirstMs { line += " · speaking after \(Self.seconds(tts))" }
                    self.voiceLatencyLine = line
                }
                if self.voiceMuted {
                    // v0.9.8: muted replaces the level readout
                    // wholesale — a level line ticking along
                    // behind a mute would claim hearing that
                    // isn't happening.
                    self.voiceHearingLine = "Muted — the microphone is off; GUS hears nothing until you unmute."
                } else if let h = s.hearing {
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
        // v0.9.11: the Shield chip is the call's, not the app's.
        voiceShieldMode = nil
        // v0.9.8: mute never outlives its call.
        voiceMuted = false
        // v0.9.11: neither does the echo gate.
        voiceEchoGateEngaged = false
        voiceStashLock.lock()
        voiceCaptureMuted = false
        voiceCaptureEchoGated = false
        voiceStashLock.unlock()
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
        refreshTimeline()
        refreshApprovals()
        refreshOnboarding()
        refreshVoiceSettings()
        refreshMemoryStatus()
    }

    // MARK: Launch gate (v0.14.5 — the first-run login screen)

    /// The gate's readout, fetched ONCE at launch (init) and
    /// refreshed by the gate's own actions — deliberately NOT
    /// part of the poll: the gate is a launch screen, so a
    /// sign-out from Settings mid-session takes effect at the
    /// NEXT launch, exactly as its copy promises, and never
    /// yanks the operator out of a window they're using.
    @Published var identitySession: PanelIdentitySession?
    /// False until the first session read lands (or fails) —
    /// RootView holds a neutral launch state meanwhile, so the
    /// main window never flashes up ahead of its own gate.
    @Published var sessionChecked = false
    @Published var loginBusy = false
    @Published var loginError: String?

    /// The gate shows when the first-run screen is still owed
    /// (no welcome marker yet), or when the install locks with
    /// a local password and no live session exists. A failed
    /// read (an older panel, the panel down) never gates: the
    /// app falls through to its ordinary unreachable state —
    /// the gate is a launch screen, not a new security
    /// boundary, and it must never trap the operator outside
    /// their own agent over a readout.
    var loginGateActive: Bool {
        guard sessionChecked, let s = identitySession else { return false }
        // v0.14.6: the operator's auto-login posture wins over
        // every other gate condition — gate off means the app
        // opens straight in, first run included.
        if s.launchGateEnabled == false { return false }
        if s.welcomedAt == nil { return true }
        return s.provider == "local-password" && !s.signedIn
    }

    func refreshIdentitySession() {
        client.get("/api/identity/session", as: PanelIdentitySession.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let s) = result { self.identitySession = s }
                self.sessionChecked = true
            }
        }
    }

    /// "Continue on this Mac" — sign in through the active
    /// no-login local provider (the machine is the lock).
    func loginContinueOnThisMac() {
        login(username: "", password: "")
    }

    /// Sign in through the active provider (POST
    /// /api/identity/login). On success the first-run welcome
    /// is recorded (a no-op when it already stands) and the
    /// gate readout refreshes, which lifts the gate. A refusal
    /// lands in loginError verbatim — the panel's words, not a
    /// paraphrase.
    func login(username: String, password: String) {
        guard !loginBusy else { return }
        loginBusy = true
        loginError = nil
        client.post("/api/identity/login", jsonBody: ["username": username, "password": password]) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let r) where r.ok:
                    self.client.post("/api/identity/welcome") { [weak self] _ in
                        DispatchQueue.main.async {
                            guard let self else { return }
                            self.loginBusy = false
                            self.refreshIdentitySession()
                        }
                    }
                case .success(let r):
                    self.loginBusy = false
                    self.loginError = r.detail
                case .failure(let e):
                    self.loginBusy = false
                    self.loginError = "Could not reach the panel: \(e.localizedDescription)"
                }
            }
        }
    }

    /// The first-run password path: set the credential, make
    /// local-password the active provider, then sign in with
    /// the new credential — one flow, each step the panel's own
    /// endpoint, the first refusal stopping the chain with its
    /// detail in loginError.
    func loginSetPassword(username: String, password: String) {
        guard !loginBusy else { return }
        loginBusy = true
        loginError = nil
        client.post("/api/identity/password", jsonBody: ["username": username, "password": password]) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let r) where r.ok:
                    self.client.post("/api/identity/provider", jsonBody: ["kind": "local-password"]) { [weak self] result2 in
                        DispatchQueue.main.async {
                            guard let self else { return }
                            switch result2 {
                            case .success(let r2) where r2.ok:
                                self.loginBusy = false
                                self.login(username: username, password: password)
                            case .success(let r2):
                                self.loginBusy = false
                                self.loginError = r2.detail
                            case .failure(let e):
                                self.loginBusy = false
                                self.loginError = "Could not reach the panel: \(e.localizedDescription)"
                            }
                        }
                    }
                case .success(let r):
                    self.loginBusy = false
                    self.loginError = r.detail
                case .failure(let e):
                    self.loginBusy = false
                    self.loginError = "Could not reach the panel: \(e.localizedDescription)"
                }
            }
        }
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
                    if self.onboarding != o { self.onboarding = o }
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
                    // v0.14.0: publish only on a real change —
                    // an unchanged status no longer invalidates
                    // every view on each poll tick.
                    if self.status != s { self.status = s }
                    if !self.reachable { self.reachable = true }
                case .failure:
                    if self.status != nil { self.status = nil }
                    if self.reachable { self.reachable = false }
                }
            }
        }
    }

    private func refreshChat() {
        client.get("/api/chat/history", as: PanelChatHistory.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let h) = result {
                    if self.chatMessages != h.messages { self.chatMessages = h.messages }
                    if self.chatJobs != h.jobs { self.chatJobs = h.jobs }
                }
            }
        }
    }

    private func refreshJobs() {
        client.get("/api/jobs", as: [PanelJob].self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let j) = result, self.jobs != j { self.jobs = j }
            }
        }
    }

    /// v0.11.0: the secure log's feed — the same timeline the
    /// web panel's Watch view polls. A failed read keeps the
    /// last good lines rather than blanking the log mid-demo.
    private func refreshTimeline() {
        client.get("/api/watch/timeline", as: [PanelTimelineEntry].self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let t) = result, self.timeline != t { self.timeline = t }
            }
        }
    }

    private func refreshApprovals() {
        client.get("/api/approvals", as: [PanelApproval].self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let a) = result, self.approvals != a { self.approvals = a }
            }
        }
        client.get("/api/approvals/history", as: [PanelApprovalHistoryEntry].self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let h) = result, self.approvalsHistory != h { self.approvalsHistory = h }
            }
        }
    }

    private func refreshVoiceSettings() {
        client.get("/api/voice/settings", as: PanelVoiceSettings.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let v) = result, self.voiceSettings != v { self.voiceSettings = v }
            }
        }
    }

    private func refreshMemoryStatus() {
        client.get("/api/memory/status", as: PanelMemoryStatus.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let m) = result, self.memoryStatus != m { self.memoryStatus = m }
            }
        }
    }

    // MARK: Identity customization (v0.10.1)

    /// Where the chosen avatar lives: a PNG copy under the
    /// app's state dir, so the choice survives the original
    /// file moving or being deleted. Presence of the file IS
    /// the customization; resetting is deleting it.
    private var avatarFilePath: String {
        NSHomeDirectory() + "/.gus/state/desktop/avatar.png"
    }

    /// v0.14.0: the avatar file's modification time as last
    /// loaded — reloadAvatarIfChanged() compares against it,
    /// so an avatar GUS writes into the slot (the "make me an
    /// avatar" flow) is picked up without a relaunch.
    private var avatarFileMtime: Date?

    var hasCustomAvatar: Bool { avatarImage != nil }

    /// The bundled default avatar (v0.14.0): the lifelike GUS
    /// portrait — the R2 realism track's candidate, replacing
    /// the v0.11.1 cartoon character the operator called
    /// generic. Shipped in the app bundle's Resources by
    /// build-dmg.sh (Resources/DefaultAvatar.png.b64 in the
    /// repo — the push path is text-only, so it rides as base64
    /// like the icon master). Loaded once; nil only if the
    /// bundle is missing the file, in which case the fallback
    /// character below stands in.
    static let defaultAvatarImage: NSImage? = {
        guard let url = Bundle.main.url(forResource: "DefaultAvatar", withExtension: "png"),
              let image = NSImage(contentsOf: url) else { return nil }
        return image
    }()

    /// The fallback avatar (v0.14.0): Avatar A, the v0.11.1
    /// character (the Commons resident poll's pick, 4–0,
    /// 2026-11-17), bundled as DefaultAvatarA.png. Shown only
    /// if the portrait above ever fails to load.
    static let fallbackAvatarImage: NSImage? = {
        guard let url = Bundle.main.url(forResource: "DefaultAvatarA", withExtension: "png"),
              let image = NSImage(contentsOf: url) else { return nil }
        return image
    }()

    /// The avatar the header actually shows: the operator's
    /// custom photo when one is set, else the bundled default
    /// portrait, else the fallback character, else — a bundle
    /// missing both resources — the app icon.
    var displayAvatarImage: NSImage {
        avatarImage ?? Self.defaultAvatarImage ?? Self.fallbackAvatarImage ?? NSApplication.shared.applicationIconImage
    }

    private func loadIdentity() {
        if let saved = UserDefaults.standard.string(forKey: "gus.displayName") {
            let trimmed = saved.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { displayName = trimmed }
        }
        if let savedVoice = UserDefaults.standard.string(forKey: Self.localTtsVoiceDefaultsKey) {
            localTtsVoiceId = savedVoice
        }
        if let data = try? Data(contentsOf: URL(fileURLWithPath: avatarFilePath)),
           let image = NSImage(data: data) {
            avatarImage = image
        }
        avatarFileMtime = Self.avatarMtime(atPath: avatarFilePath)
    }

    /// The avatar file's modification time, if the file exists.
    private static func avatarMtime(atPath path: String) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date
    }

    /// v0.14.0: pick up an avatar written into the slot from
    /// outside this app's own pickers — the "make me an avatar"
    /// flow has GUS save the finished PNG to avatarFilePath as
    /// an ordinary job, and this (run on the poll's slow lane
    /// and right after requestAvatar) notices the mtime move
    /// and reloads. A deleted file clears back to the default.
    func reloadAvatarIfChanged() {
        let mtime = Self.avatarMtime(atPath: avatarFilePath)
        guard mtime != avatarFileMtime else { return }
        avatarFileMtime = mtime
        if mtime != nil,
           let data = try? Data(contentsOf: URL(fileURLWithPath: avatarFilePath)),
           let image = NSImage(data: data) {
            avatarImage = image
        } else if mtime == nil {
            avatarImage = nil
        }
    }

    /// v0.14.0: "GUS, make me an avatar" — an ordinary chat
    /// job, on purpose: the request goes through the same
    /// scan, caps, and receipts as any message, and the
    /// finished image lands in the desktop avatar slot, where
    /// reloadAvatarIfChanged picks it up. The message names
    /// the slot path in words the job can act on.
    func requestAvatar(description: String) {
        let trimmed = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let text = "Make me a new avatar from this description: \(trimmed). Create the image and save the final PNG to ~/.gus/state/desktop/avatar.png — that file is your avatar slot in the desktop app; replacing it changes your face in the sidebar. Square, face-forward, readable at small sizes."
        client.post("/api/chat", jsonBody: ["text": text]) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let r):
                    self.notice = r.detail
                case .failure(let e):
                    self.notice = "Could not reach the panel: \(e.localizedDescription)"
                }
                self.reloadAvatarIfChanged()
                self.refreshChat()
            }
        }
    }

    /// Rename the agent (Identity tab). Blank means the
    /// default — the name is never an empty string anywhere
    /// it is shown. Stored in this app's preferences only.
    func setDisplayName(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        displayName = trimmed.isEmpty ? "GUS" : trimmed
        UserDefaults.standard.set(displayName, forKey: "gus.displayName")
        notice = "Name saved — \(displayName) it is."
    }

    /// Pick a new avatar photo (Identity tab): the system
    /// open panel, any image type macOS reads. The image is
    /// re-encoded to PNG into the state dir (uniform format,
    /// independent of the source file) and rendered
    /// round-cropped by the Identity tab.
    func chooseAvatarImage() {
        let panel = NSOpenPanel()
        panel.title = "Choose an avatar image"
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url,
              let image = NSImage(contentsOf: url) else { return }
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            notice = "That file couldn't be read as an image GUS can keep — try a PNG or JPEG."
            return
        }
        do {
            try FileManager.default.createDirectory(
                atPath: (avatarFilePath as NSString).deletingLastPathComponent,
                withIntermediateDirectories: true)
            try png.write(to: URL(fileURLWithPath: avatarFilePath))
            avatarImage = NSImage(data: png)
            avatarFileMtime = Self.avatarMtime(atPath: avatarFilePath)
            notice = "Avatar saved — the new face is in the sidebar header."
        } catch {
            notice = "The avatar couldn't be saved: \(error.localizedDescription)"
        }
    }

    /// Back to the bundled default avatar (v0.11.1 — through
    /// v0.11.0 this meant the app icon).
    func resetAvatar() {
        try? FileManager.default.removeItem(atPath: avatarFilePath)
        avatarImage = nil
        avatarFileMtime = nil
        notice = "Avatar reset — back to the default GUS avatar."
    }

    /// The standard Kokoro voice set (the endpoint mouth's
    /// voices) — the same names Settings → Voice's free-text
    /// field accepts; af_heart is the shipped default.
    static let kokoroVoices = [
        "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica",
        "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
        "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
        "am_michael", "am_onyx", "am_puck",
        "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
        "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
    ]

    /// Change the spoken voice (Identity tab): the SAME
    /// write Settings → Voice makes — the full settings body
    /// re-posted with only ttsVoice changed. The endpoint
    /// treats the body as the whole file (a field it doesn't
    /// hear about falls back, and `enabled` reads as false
    /// unless sent true), so a partial post here would
    /// silently unconfigure the channel. One voice.json, one
    /// endpoint, two editors — never a second store.
    func setTtsVoice(_ voice: String) {
        guard let current = voiceSettings else { return }
        let trimmed = voice.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != current.ttsVoice else { return }
        client.post("/api/voice/settings", jsonBody: [
            "enabled": current.enabled,
            "bargeIn": current.bargeIn ?? true,
            "shieldScan": current.shieldScan ?? true,
            "sttEngine": current.sttEngine ?? "local",
            "ttsEngine": current.ttsEngine ?? "local",
            "sttBaseUrl": current.sttBaseUrl,
            "sttModel": current.sttModel,
            "ttsBaseUrl": current.ttsBaseUrl,
            "ttsModel": current.ttsModel,
            "ttsVoice": trimmed,
        ]) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let r):
                    self.notice = r.detail
                case .failure(let e):
                    self.notice = "Could not reach the panel: \(e.localizedDescription)"
                }
                self.refreshVoiceSettings()
            }
        }
    }

    // MARK: Built-in voice choice (v0.11.0)

    /// The UserDefaults key both pickers (Identity tab,
    /// Settings → Voice) and the speech path share.
    static let localTtsVoiceDefaultsKey = "gus.localTtsVoiceId"

    /// The voices installed on this Mac, by name — the picker's
    /// contents, enumerated live from the speech framework
    /// (AVSpeechSynthesisVoice.speechVoices(), the modern face
    /// of NSSpeechSynthesizer's availableVoices) rather than a
    /// shipped list that would drift from the machine. Voices
    /// the operator downloads in System Settings appear here
    /// on the next read.
    static var installedSpeechVoices: [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// The UserDefaults key for the pickers' language filter
    /// (v0.11.1) — shared by both pickers exactly the way the
    /// voice key is. Absent means English.
    static let localTtsVoiceLanguageDefaultsKey = "gus.localTtsVoiceLanguage"

    /// A voice's primary language ("en" for en-US / en-GB) —
    /// the filter's unit. Voice languages are BCP-47 tags; the
    /// country variants are what made the unfiltered list a
    /// junk drawer (Glenn's v0.11.0 note), so the picker groups
    /// by language and lets the variants live inside it.
    static func primaryLanguage(of voice: AVSpeechSynthesisVoice) -> String {
        voice.language.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? voice.language
    }

    /// The languages the installed voices actually cover —
    /// the language selector's contents. English first (the
    /// default filter), the rest by display name.
    static var speechVoiceLanguages: [String] {
        let codes = Set(installedSpeechVoices.map { primaryLanguage(of: $0) })
        return codes.sorted { a, b in
            if a == "en" { return true }
            if b == "en" { return false }
            return languageDisplayName(a).localizedCaseInsensitiveCompare(languageDisplayName(b)) == .orderedAscending
        }
    }

    /// A language code's display name, in the operator's own
    /// locale ("en" → "English", "es" → "Spanish").
    static func languageDisplayName(_ code: String) -> String {
        Locale.current.localizedString(forLanguageCode: code) ?? code
    }

    /// Quality rank for sorting: premium above enhanced above
    /// the default quality — the good voices first, per
    /// Glenn's "the voices are all not good" note.
    private static func qualityRank(_ voice: AVSpeechSynthesisVoice) -> Int {
        switch voice.quality {
        case .premium: return 0
        case .enhanced: return 1
        default: return 2
        }
    }

    /// The picker's label for a voice: its name, with the
    /// quality the framework exposes named when it is above
    /// the default — "Samantha · Enhanced".
    static func speechVoiceLabel(_ voice: AVSpeechSynthesisVoice) -> String {
        switch voice.quality {
        case .premium: return "\(voice.name) · Premium"
        case .enhanced: return "\(voice.name) · Enhanced"
        default: return voice.name
        }
    }

    /// The voices for one language, best first: quality rank,
    /// then name. (The unfiltered enumeration stays name-sorted
    /// — installedSpeechVoices above; this is the filtered,
    /// quality-led view the pickers show.)
    static func speechVoices(forLanguage language: String) -> [AVSpeechSynthesisVoice] {
        installedSpeechVoices
            .filter { primaryLanguage(of: $0) == language }
            .sorted { a, b in
                let rank = qualityRank(a) - qualityRank(b)
                if rank != 0 { return rank < 0 }
                return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            }
    }

    /// The picker list for a language filter, with the saved
    /// pick kept in the list even when it belongs to another
    /// language — changing the filter must never strand the
    /// current selection (the picker would show nothing and a
    /// stray tap could silently replace the pick). The saved
    /// voice rides at the top, labeled with its language.
    static func pickerVoices(forLanguage language: String, selectedId: String) -> [AVSpeechSynthesisVoice] {
        var list = speechVoices(forLanguage: language)
        if !selectedId.isEmpty,
           !list.contains(where: { $0.identifier == selectedId }),
           let saved = AVSpeechSynthesisVoice(identifier: selectedId) {
            list.insert(saved, at: 0)
        }
        return list
    }

    /// The voice built-in speech actually uses: the operator's
    /// pick when it names a voice still installed, else the
    /// en-US default the app has always used. Read fresh from
    /// UserDefaults at speak time, so a change in either picker
    /// (or Settings) lands on the very next sentence, and a
    /// voice removed from the Mac degrades to the default
    /// instead of failing a call.
    static func localSpeechVoice() -> AVSpeechSynthesisVoice? {
        let id = UserDefaults.standard.string(forKey: localTtsVoiceDefaultsKey) ?? ""
        if !id.isEmpty, let chosen = AVSpeechSynthesisVoice(identifier: id) {
            return chosen
        }
        return AVSpeechSynthesisVoice(language: "en-US")
    }

    /// Choose the built-in voice (Identity tab picker). "" is
    /// the Mac's default voice. Stored in this app's
    /// preferences only — see localTtsVoiceId.
    func setLocalTtsVoice(_ id: String) {
        localTtsVoiceId = id
        UserDefaults.standard.set(id, forKey: Self.localTtsVoiceDefaultsKey)
        if id.isEmpty {
            notice = "Built-in voice: back to this Mac's default voice."
        } else if let voice = AVSpeechSynthesisVoice(identifier: id) {
            notice = "Built-in voice saved — \(voice.name) speaks from the next sentence."
        } else {
            notice = "Built-in voice saved."
        }
    }

    /// The Identity tab's Test button for the built-in engine:
    /// one sentence through the selected voice, on the test
    /// synthesizer (never the call's). During a call it refuses
    /// in the notice rather than talking over the call.
    func testLocalVoice() {
        guard !voiceInCall else {
            notice = "The test voice waits until the call ends — it won't talk over a call."
            return
        }
        let utterance = AVSpeechUtterance(string: "This is the built-in voice test. If you can hear me, this voice works.")
        utterance.voice = Self.localSpeechVoice()
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        localVoiceTestSynthesizer.speak(utterance)
        notice = "Playing the test sentence with the built-in voice — listen for it."
    }

    // MARK: Invite (v0.10.1)

    /// The top bar's Invite. GUS has no accounts and nothing
    /// to join (decided), so inviting means pointing someone
    /// at GUS: the macOS share sheet carries a line of text
    /// and the public page — Messages, Mail, AirDrop,
    /// whatever this Mac offers. When the Mac offers no
    /// sharing services at all (or there is no window to
    /// anchor to), the same text lands on the clipboard and
    /// the notice says so — the invite is never a dead click.
    func invite() {
        let link = "https://www.startekenterprises.com/gus"
        let text = "Try GUS — a secure AI agent that lives on your own Mac: it asks before anything consequential, keeps its keys in a vault, and shows a receipt for every job. Get it here: \(link)"
        guard let url = URL(string: link) else { return }
        let items: [Any] = [text, url]
        guard !NSSharingService.sharingServices(forItems: items).isEmpty,
              let view = NSApp.keyWindow?.contentView else {
            copyInvite(text)
            return
        }
        let picker = NSSharingServicePicker(items: items)
        sharePicker = picker
        // Anchor just under the top bar's right side, where
        // the Invite button sits — the sheet points at its
        // own button.
        let anchor = NSRect(x: view.bounds.maxX - 170, y: view.bounds.maxY - 46, width: 1, height: 1)
        picker.show(relativeTo: anchor, of: view, preferredEdge: .minY)
    }

    private func copyInvite(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        notice = "No sharing services on this Mac — the invite was copied to your clipboard instead; paste it anywhere to send it."
    }
}
