import AVFoundation
import Foundation
import ShieldKit
import Speech
import UIKit

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

/// Start in a voice call (v0.36.0): the operator's launch
/// preference — when on, a COLD launch opens straight into
/// the call screen with the call started, so GUS greets the
/// operator right away instead of waiting to be summoned
/// (Settings → Call mode). RootView reads it once, when the
/// signed-in shell first appears — the cold-launch moment.
/// Warm foregrounding never re-reads it: the shell stays in
/// the hierarchy across backgrounding, and ambushing the
/// operator with a call every time they return to the app
/// would be wrong. Default off.
enum StartInCall {
    static var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: "gus.call.startInCall") }
        set { UserDefaults.standard.set(newValue, forKey: "gus.call.startInCall") }
    }
}

/// One camera moment on the call screen (v0.36.0): the
/// photo the operator took mid-call (or, with imageData
/// nil, the plain-words record of why no photo happened —
/// permission denied, no camera). Memory only, in every
/// mode: nothing here is ever written to a store on this
/// phone — the entries are born with the call screen's
/// session and cleared at the next call's start. In a
/// Core-mode call the photo itself rides to the Mac like
/// the call's audio does (the v0.34.0 incognito boundary:
/// the Mac side of a call is the call); on-device, it
/// never leaves this struct.
struct CallPhotoEntry: Identifiable {
    let id = UUID()
    /// The capture, after the chat pipeline's transport
    /// treatment (long edge ≤1568 px, JPEG q0.8).
    let imageData: Data?
    /// What happened to the photo, in plain words — set at
    /// capture, and rewritten if the Core refuses or the
    /// post fails, so the record never claims a delivery
    /// that didn't happen.
    var note: String
    /// turns.count at capture: the entry renders in the
    /// transcript panel just before the turn that followed
    /// it — in Core mode, the photo's own reply turn.
    let turnAnchor: Int
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

    /// Whether any call is live right now (v0.33.0): set
    /// where a call goes live (both transports) and cleared
    /// where one ends or fails. Its one consumer is the
    /// voice preview (VoicePreviewPlayer / VoicePreviewButton):
    /// an audition is never offered into a live call. It is
    /// a plain flag, not a control — nothing in the call
    /// path reads it.
    ///
    /// nonisolated(unsafe): writes happen only on the main
    /// actor, inside CallSession; the preview's reader is
    /// off-actor and uses it as an advisory gate, where a
    /// one-frame-stale read is harmless.
    nonisolated(unsafe) static private(set) var isAnyCallLive = false

    @Published private(set) var phase: Phase = .idle
    /// The core's word for the moment: listening | thinking |
    /// speaking | ended — drives the call screen's status line.
    @Published private(set) var corePhase: String = ""
    @Published private(set) var liveTranscript: String = ""
    /// The reply being spoken right now, sentence by sentence
    /// (v0.23.0): speakText appends each sentence as its
    /// playback STARTS, so the call screen's transcript shows
    /// GUS's words as he says them instead of only when the
    /// finished turn lands in `turns`. Cleared when a new user
    /// turn begins (spoken final or typed send). The screen
    /// renders it as the in-flight GUS row and drops it once
    /// the completed turn carries the same text — this is a
    /// display seam on the existing turn flow, not a second
    /// transcript store.
    @Published private(set) var liveReplyText: String = ""
    @Published private(set) var turns: [VoiceSessionState.Turn] = []
    /// v0.36.0: the call's camera moments (CallPhotoEntry),
    /// rendered in the transcript panel at their turn
    /// anchors. Memory only — see the struct.
    @Published private(set) var photoEntries: [CallPhotoEntry] = []

    // Watch mode (v0.37.0): the call's eyes. The operator's
    // per-call tap (CallView's Watch control) is the ONLY
    // way in — Watch never starts itself, not even on a
    // start-in-call launch. While on, the WatchCapture
    // controller runs the camera(s) and this session samples
    // its latest frames to the core, which holds them in
    // memory as the session's eyes and drops them when
    // Watch turns off or the call ends. On-device calls
    // can't watch (the local brain has no vision) — the
    // toggle says so in plain words and captures nothing.
    @Published private(set) var watchOn = false
    @Published private(set) var watchMode: WatchCameraMode = .back
    /// A Watch problem, in plain words for the call screen:
    /// permission off, the on-device explanation, a start
    /// the core refused. Set where it happens, cleared when
    /// Watch next turns on or off cleanly.
    @Published private(set) var watchNotice: String?
    @Published private(set) var watchTorchOn = false
    /// The torch can only exist while the back camera is
    /// live and the device has one — recomputed at every
    /// mode change (refreshWatchTorch).
    @Published private(set) var watchTorchUsable = false
    /// Whether this phone can run both cameras at once —
    /// read from the controller when Watch turns on; the
    /// Both control exists only when this is true.
    @Published private(set) var watchBothSupported = false
    private let watchCapture = WatchCaptureController()
    private var watchSamplerTask: Task<Void, Never>?
    /// The app left the foreground mid-watch: the capture
    /// session is stopped (the camera is off while the app
    /// is away — the background-audio mode keeps the CALL,
    /// never the camera) and sampling is paused. Foreground
    /// return resumes both, if the call is still live.
    private var watchSuspended = false
    private var watchBackgroundObserver: NSObjectProtocol?
    private var watchForegroundObserver: NSObjectProtocol?
    /// The baseline sampling cadence: a fresh frame set
    /// every 12 s while watching (SerenAI's proven 15 s
    /// comment rhythm, a touch quicker) — plus an immediate
    /// grab whenever a turn ends, so an answer is grounded
    /// in the view as it is, not as it was.
    private static let watchSampleSeconds: UInt64 = 12

    /// The capture's preview surface, for the call screen
    /// to embed while watching.
    var watchPreviewView: UIView { watchCapture.previewView }
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
    /// The persona context the core currently holds for this
    /// call (v0.40.0): the composed prompt this phone sent at
    /// start, or with the latest accepted update.
    /// syncCorePersonaContext compares the live composition
    /// against it and posts only a difference — the Core
    /// call's version of the on-device brain's staleness
    /// reload. The context's content lives nowhere else on
    /// this phone beyond LocalBrain's own composition inputs,
    /// and on the core it is session memory only.
    private var corePersonaContext: String?

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

    // Audio lifecycle (v0.31.0, item 8): the observers that
    // let a call survive the phone's ordinary life —
    // interruptions (another call, Siri, an alarm), route
    // changes (a Bluetooth device coming and going), and
    // the media-services reset. Registered at call start,
    // removed when the call ends; they handle lifecycle
    // only and never touch the playback graph.
    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?
    private var mediaResetObserver: NSObjectProtocol?
    /// An interruption is in progress: hearing and playback
    /// are stalled by the system, and the resume path runs
    /// when it ends. The call itself is NOT ended — an
    /// interruption is weather, not a hang-up.
    private var audioInterrupted = false

    /// Whether the call's audio is ACTUALLY coming out of
    /// the built-in speaker right now (v0.31.0, item 10) —
    /// read from the session's current route, refreshed on
    /// every route change. The speaker button shows THIS,
    /// not the toggle's intent: a button that lights for a
    /// route the phone isn't using is a lie on the call
    /// screen (Glenn's field report: the button toggled,
    /// the route never moved). `isSpeakerOn` remains the
    /// operator's selected route — the intent the
    /// reassertion points re-apply.
    @Published private(set) var outputRouteIsSpeaker: Bool = true

    // MARK: - Lifecycle

    func startCall() {
        guard phase == .idle || phase == .ended else { return }
        phase = .connecting
        observeAudioLifecycle()
        errorText = nil
        liveTranscript = ""
        liveReplyText = ""
        turns = []
        photoEntries = []
        // Watch is per-call and never survives into a new
        // one: a previous call's watch was stopped when it
        // ended, and this is the belt to that suspender.
        if watchOn { stopWatch(announce: false) }
        watchNotice = nil
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
            // the level meter still moving). The port is
            // asserted outright — through applySelectedRoute,
            // the one route owner since v0.31.0: at call start
            // the selection defaults to speaker, and every
            // later reassertion re-applies the OPERATOR's
            // selection, never a hard-coded speaker. The route
            // the system reports is written to the voice log,
            // so a field report can see where sound went.
            applySelectedRoute()
            refreshOutputRoute()
            VoiceFailureLog.shared.recordInfo("Call route: \(session.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ", ")) — speaker \(isSpeakerOn ? "on" : "off").")
        } catch {
            fail("The call's audio couldn't be set up: \(error.localizedDescription)")
            return false
        }
        return true
    }

    // MARK: - Audio lifecycle & routes (v0.31.0)

    private static let interruptionNotice = "Call interrupted — another app or call has the audio. GUS will pick up again when it clears."

    /// Register the lifecycle observers for this call
    /// (idempotent — a re-call after an ended call reuses
    /// them). Background continuation itself needs no
    /// observer: the audio background mode (Info.plist,
    /// UIBackgroundModes = audio) plus this call's active
    /// session and running engine are what keep the
    /// process alive while the app is backgrounded or the
    /// phone is locked — hearing, synthesis, and playback
    /// all keep running because nothing here ever suspends
    /// them on a scene change.
    private func observeAudioLifecycle() {
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        if interruptionObserver == nil {
            interruptionObserver = center.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: session, queue: nil) { [weak self] note in
                guard let self,
                      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      let type = AVAudioSession.InterruptionType(rawValue: raw)
                else { return }
                Task { @MainActor in
                    switch type {
                    case .began: self.handleInterruptionBegan()
                    case .ended: self.handleInterruptionEnded(note)
                    @unknown default: break
                    }
                }
            }
        }
        if routeChangeObserver == nil {
            routeChangeObserver = center.addObserver(
                forName: AVAudioSession.routeChangeNotification,
                object: session, queue: nil) { [weak self] note in
                let reasonRaw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
                Task { @MainActor in
                    guard let self else { return }
                    self.refreshOutputRoute()
                    // A device that vanished (Bluetooth
                    // dropped, headphones unplugged) leaves
                    // the route wherever the system dropped
                    // it — put the OPERATOR's selection back.
                    // A change the operator made themselves
                    // (the route picker, the toggle) already
                    // carries their intent and is never fought.
                    if reasonRaw == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue,
                       self.phase == .live {
                        self.applySelectedRoute()
                        self.refreshOutputRoute()
                    }
                }
            }
        }
        if mediaResetObserver == nil {
            mediaResetObserver = center.addObserver(
                forName: AVAudioSession.mediaServicesWereResetNotification,
                object: nil, queue: nil) { [weak self] _ in
                Task { @MainActor in self?.handleMediaServicesReset() }
            }
        }
        // Watch's foreground discipline (v0.37.0): the
        // camera suspends when the app leaves the foreground
        // and resumes on return — registered with the call's
        // lifecycle observers, removed with them, and inert
        // whenever Watch is off (the handlers check).
        if watchBackgroundObserver == nil {
            watchBackgroundObserver = center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil, queue: nil) { [weak self] _ in
                Task { @MainActor in self?.handleWatchBackground() }
            }
        }
        if watchForegroundObserver == nil {
            watchForegroundObserver = center.addObserver(
                forName: UIApplication.willEnterForegroundNotification,
                object: nil, queue: nil) { [weak self] _ in
                Task { @MainActor in self?.handleWatchForeground() }
            }
        }
    }

    private func removeAudioLifecycleObservers() {
        let center = NotificationCenter.default
        if let interruptionObserver { center.removeObserver(interruptionObserver) }
        if let routeChangeObserver { center.removeObserver(routeChangeObserver) }
        if let mediaResetObserver { center.removeObserver(mediaResetObserver) }
        if let watchBackgroundObserver { center.removeObserver(watchBackgroundObserver) }
        if let watchForegroundObserver { center.removeObserver(watchForegroundObserver) }
        interruptionObserver = nil
        routeChangeObserver = nil
        mediaResetObserver = nil
        watchBackgroundObserver = nil
        watchForegroundObserver = nil
        audioInterrupted = false
    }

    /// An interruption began (a phone call, Siri, an
    /// alarm): the system stalls the call's audio on its
    /// own. Nothing is torn down — the graph, the hearing,
    /// and the session all stay exactly as built, so the
    /// resume below is a reactivation, not a rebuild. The
    /// operator is told, in words, on the call screen.
    private func handleInterruptionBegan() {
        guard phase == .live || phase == .connecting else { return }
        audioInterrupted = true
        if speechNotice == nil { speechNotice = Self.interruptionNotice }
        VoiceFailureLog.shared.recordInfo("Audio interruption began — the call waits it out.")
    }

    /// The interruption ended: reactivate the session,
    /// re-apply the operator's route, and restart hearing
    /// (recognizer tasks do not survive interruptions; the
    /// restart is the call's ordinary recovery path, and
    /// starting the shared engine is also what brings
    /// playback back). If the system says don't resume,
    /// the call still re-arms hearing — the operator is
    /// here and the call screen says the call is live;
    /// ending the call is their tap, not an inference.
    private func handleInterruptionEnded(_ note: Notification) {
        guard phase == .live, audioInterrupted else { return }
        audioInterrupted = false
        if speechNotice == Self.interruptionNotice { speechNotice = nil }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default,
                                    options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
        } catch {
            VoiceFailureLog.shared.recordInfo("Audio session couldn't reactivate after the interruption (\(error.localizedDescription)).")
        }
        applySelectedRoute()
        refreshOutputRoute()
        if !isMuted { restartHearing() }
        VoiceFailureLog.shared.recordInfo("Audio interruption ended — session reactivated, hearing restarted.")
    }

    /// The media services daemon restarted: every audio
    /// object the call holds is invalid, and rebuilding the
    /// graph mid-call is exactly what this class never does
    /// silently. The honest move is to end the call in
    /// words and let the operator call again into a fresh
    /// graph.
    private func handleMediaServicesReset() {
        guard phase == .live || phase == .connecting else { return }
        VoiceFailureLog.shared.recordInfo("Media services were reset by the system — the call was ended.")
        fail("The phone's audio system restarted itself, so this call had to end. Please call again.")
    }

    /// The operator's selected route, applied — the ONE
    /// place a route override is written during a call
    /// (v0.31.0, item 10). Speaker on: the built-in speaker,
    /// outright. Speaker off: no override — the earpiece,
    /// the private route. An EXTERNAL output (Bluetooth,
    /// AirPlay, wired headphones, a car) owns the route
    /// while it is connected and is never overridden here:
    /// the route picker's choice outranks the toggle until
    /// the device goes away. Call start defaults to speaker
    /// because isSpeakerOn does; once the operator toggles,
    /// every reassertion point (call setup, hearing starts,
    /// interruption resume, a device vanishing) re-applies
    /// THEIR selection, never a hard-coded speaker.
    private func applySelectedRoute() {
        let session = AVAudioSession.sharedInstance()
        let hasExternalOutput = session.currentRoute.outputs.contains { output in
            switch output.portType {
            case .builtInSpeaker, .builtInReceiver: return false
            default: return true
            }
        }
        guard !hasExternalOutput else { return }
        try? session.overrideOutputAudioPort(isSpeakerOn ? .speaker : .none)
    }

    /// What the route actually is, for the call screen's
    /// speaker button (item 10): read from the live route,
    /// never inferred from the toggle.
    private func refreshOutputRoute() {
        outputRouteIsSpeaker = AVAudioSession.sharedInstance()
            .currentRoute.outputs.contains { $0.portType == .builtInSpeaker }
    }

    /// Voice processing on the call engine's input (v0.18.0;
    /// factored out in v0.29.1 so call setup and hearing
    /// starts make the one same attempt): it can only be set
    /// while the engine is stopped — a call's first attempt
    /// always runs stopped, and the setting then persists
    /// for the engine's life, so restarts during playback
    /// simply find it already on. A failure here is not
    /// fatal: unprocessed input still works, defended by the
    /// echo guard and the barge-in debounce exactly as
    /// before v0.18.0 — but it is SAID (v0.22.0): through
    /// v0.21.0 the equivalent catch was empty, so no field
    /// report could ever tell whether voice processing had
    /// engaged, which playback path that left the call on,
    /// or why the echo canceller was absent.
    private func enableVoiceProcessingIfNeeded() {
        guard !voiceProcessingEnabled, !audioEngine.isRunning else { return }
        do {
            try audioEngine.inputNode.setVoiceProcessingEnabled(true)
            voiceProcessingEnabled = true
        } catch {
            VoiceFailureLog.shared.recordInfo("Voice processing couldn't be enabled (\(error.localizedDescription)) — echo cancellation off for this call.")
        }
    }

    /// The call-start audio proof (v0.29.1): with the audio
    /// session configured (prepareCallAudio) and voice
    /// processing enabled, the speech engine primes its
    /// playback graph BEFORE the first sentence can be
    /// spoken — the shared engine is cycled once and a
    /// breath of silence is played through the player — and
    /// settles whether this call speaks through the shared
    /// engine or the player's private fallback engine (see
    /// KokoroPlayer.primeCallAudio for the two builds of
    /// field evidence). Hearing starts after this
    /// (startHearing), so the recognizer is never running
    /// across the engine cycle.
    private func primeCallAudioPath() {
        enableVoiceProcessingIfNeeded()
        speaker.primeCallAudio()
    }

    private func connect() async {
        guard await prepareCallAudio() else { return }
        primeCallAudioPath()
        transport = .core
        do {
            // v0.40.0: the phone's composed persona prompt
            // opens the call — the core answers as the persona
            // picked here, memories included, from the first
            // turn. Over the transport cap the call starts
            // without it and says so (the core's own door
            // words it the same way); the marker stays nil, so
            // the sync below keeps offering the composition
            // and a trim mid-call brings the persona along.
            let persona = PersonaContextTransport.current()
            let state = try await client.voiceSessionStart(personaContext: persona.context)
            guard state.ok, let id = state.sessionId else {
                fail(state.detail)
                return
            }
            sessionId = id
            corePersonaContext = persona.context
            sttMode = state.sttMode ?? "local"
            if let notice = state.speechNotice { speechNotice = notice }
            if persona.overCap, speechNotice == nil {
                speechNotice = "The persona context from your phone was over the 16 KB limit, so this call runs without it — trim the persona's prompt or its remembered lines on the phone to bring it along."
            }
            corePhase = state.phase ?? "listening"
            phase = .live
            Self.isAnyCallLive = true
            startHearing()
            startWatchdog()
            pollTask = Task { [weak self] in await self?.pollLoop() }
            playbackTask = Task { [weak self] in await self?.playbackLoop() }
        } catch {
            fail(error.localizedDescription)
        }
    }

    /// Bring the core's held persona context current
    /// (v0.40.0): recompose the phone's prompt (LocalBrain
    /// .activePrompt folds in the persona pick, that
    /// persona's memories, and the session style) and post
    /// it when it differs from what the core already holds.
    /// Only an ACCEPTED post moves the marker, so a failed
    /// update is retried by the next sync rather than lost.
    /// An over-cap composition posts nothing — the call
    /// keeps the context it already had, the same refusal
    /// the core's own door makes. Called from the poll loop
    /// (so a change made on another screen while the call
    /// runs in the background lands within a beat, and turns
    /// the core starts itself — endpoint transcription,
    /// Watch observations — are covered) and awaited ahead
    /// of the turns this phone dispatches itself, so a
    /// change made a breath before speaking is already
    /// there when the turn runs.
    private func syncCorePersonaContext() async {
        guard transport == .core, let id = sessionId else { return }
        let current = PersonaContextTransport.current()
        guard let context = current.context, context != corePersonaContext else { return }
        if let result = try? await client.voiceSessionContext(sessionId: id, personaContext: context),
           result.ok {
            corePersonaContext = context
        }
    }

    /// On-device connect: no core session, no network at all.
    /// The brain loads once and stays loaded across calls (a
    /// 2.5 GB model is not re-read per call) while it is still
    /// CURRENT (v0.31.0): a library switch or a persona pick
    /// makes a kept brain stale — the old file, the old
    /// prompt — and a stale brain is dropped here and
    /// reloaded in-process, so a switch never asks for an app
    /// restart. A missing or unloadable brain fails the call
    /// loudly, in words, with the way out named.
    private func connectLocal() async {
        guard await prepareCallAudio() else { return }
        primeCallAudioPath()
        transport = .local
        // A call is a new conversation session (v0.33.0):
        // the session style state (depth-offer suppression,
        // length stance) starts fresh, and it resets BEFORE
        // the staleness check below so the brain this call
        // loads composes its prompt from the fresh state.
        PersonaSessionStyle.reset()
        if let kept = localBrain, !kept.isCurrent() {
            localBrain = nil
        }
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
        Self.isAnyCallLive = true
        startHearing()
        startWatchdog()
        // GUS speaks first (v0.31.0): the greeting turn goes
        // out through the same pump as any answer.
        greetLocally()
    }

    /// The greeting (v0.31.0, item 9): a connected call
    /// opens with GUS speaking first — a short hello in the
    /// ACTIVE PERSONA's character (the brain carries the
    /// persona prompt, and the shared style block keeps it
    /// brief) — instead of dead air while the operator
    /// wonders if anything connected. It rides the ordinary
    /// answer turn with a stage-direction input and NO
    /// transcript: nothing the operator said is being
    /// answered, so nothing is scanned as their words and
    /// no line appears in the transcript as if they spoke.
    /// The reply itself still passes the reply-side Shield
    /// seam in the pump, like every spoken sentence. Core
    /// calls don't greet (report): the core's voice session
    /// opens by listening and has no kickoff turn to send —
    /// a synthetic transcript would put words in the
    /// operator's mouth in the core's own record.
    private static let greetingInstruction = "The call just connected and the person is listening. Greet them now: a short, warm hello in character — one or two sentences — and invite them to tell you what they need."

    private func greetLocally() {
        guard localBrain != nil, phase == .live else { return }
        beginLocalTurn(input: Self.greetingInstruction, transcript: nil)
    }

    func endCall() {
        guard phase == .live || phase == .connecting else { return }
        phase = .ended
        Self.isAnyCallLive = false
        // The camera stops with the call (v0.37.0): capture
        // off, sampler off, and the core told to drop the
        // eyes it holds — before the session end below, so
        // the drop lands while the session still exists.
        stopWatch(announce: false)
        removeAudioLifecycleObservers()
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
        // v0.40.0: the core drops the call's persona context
        // with the session; the phone's marker goes with it.
        corePersonaContext = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func fail(_ message: String) {
        errorText = message
        voiceLevel = 0
        stopWatch(announce: false)
        removeAudioLifecycleObservers()
        pendingShieldQuarantine = nil
        phase = .ended
        Self.isAnyCallLive = false
        watchdogTask?.cancel(); watchdogTask = nil
        if audioEngine.isRunning { audioEngine.stop() }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Hearing

    private func startHearing() {
        guard phase == .live, !isMuted else { return }
        // Route reassertion (v0.22.0; ownership v0.31.0):
        // hearing restarts ride session reactivations and
        // route changes that can reset the output port —
        // the OPERATOR's route choice is restated here so
        // it survives them, through the one route owner
        // (applySelectedRoute): their earpiece choice is
        // re-applied exactly as faithfully as speaker, and
        // an external device's route is never fought.
        applySelectedRoute()
        refreshOutputRoute()
        recognitionGeneration += 1
        let generation = recognitionGeneration
        let input = audioEngine.inputNode
        input.removeTap(onBus: 0)
        // Voice processing BEFORE the format is read (v0.18.0):
        // enabling it swaps the input to the Voice Processing
        // I/O unit, whose output format is the one the tap must
        // use. Call setup (primeCallAudioPath) normally made
        // this attempt already, before the prime; this is the
        // same one attempt for any hearing start that gets
        // here first.
        enableVoiceProcessingIfNeeded()
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
    /// button at all). The toggle records the OPERATOR's
    /// selection and applies it through the one route owner
    /// (v0.31.0, item 10 — the field defect this fixes: the
    /// button once only changed its own highlight while
    /// other code paths quietly re-asserted speaker over
    /// the operator's earpiece choice). On = the built-in
    /// speaker, outright; off = no override, the earpiece —
    /// hold the phone to your ear for a private call. The
    /// session's category is never touched here, because
    /// its echo behavior comes from the engine's voice
    /// processing (v0.18.0), which the output-port override
    /// does not touch. The button's face follows the ACTUAL
    /// route (outputRouteIsSpeaker), refreshed here and on
    /// every route change.
    func setSpeaker(_ on: Bool) {
        isSpeakerOn = on
        applySelectedRoute()
        refreshOutputRoute()
        VoiceFailureLog.shared.recordInfo("Route selected: speaker \(on ? "on" : "off") — now \(AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ", ")).")
    }

    /// A typed message sent mid-call (v0.23.0, Glenn's
    /// "type while talking"): it enters the conversation
    /// through EXACTLY the doors a spoken final takes, so it
    /// gets the same treatment end to end — on-device, the
    /// Shield gate in answerLocally scans it before the
    /// brain sees it (quarantine holds it for the same
    /// one-time prompt); on the core, it posts as a session
    /// transcript, which the core Shield-scans server-side
    /// like any spoken final. The reply is spoken by the
    /// call's normal pump, as part of the call.
    ///
    /// Interaction choices: the keyboard changes NOTHING
    /// about hearing — the mic tap, the recognizer, the echo
    /// guard and the barge-in debounce all keep running
    /// exactly as in a hands-free call (keystrokes make no
    /// sound a recognizer could mistake for sustained
    /// speech, and a stray partial still has to pass the
    /// echo guard and the two-word/0.35 s debounce to cut
    /// anything). The operator can talk and type in the same
    /// call. The one deliberate act: pressing Send while GUS
    /// is mid-reply cuts the reply, locally and on the core —
    /// a typed send is a turn, with a spoken final's manners.
    /// The call itself never ends, and mute is untouched.
    func sendTypedMessage(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard phase == .live, !text.isEmpty else { return }
        liveReplyText = ""
        if gusSpeaking {
            cutSpeech()
            if transport == .local { interruptLocalAnswer() }
            if let id = sessionId {
                Task { _ = try? await client.voiceSessionInterrupt(sessionId: id) }
            }
        }
        if transport == .local {
            answerLocally(text)
        } else if let id = sessionId {
            Task {
                // Persona (v0.40.0): the core's context is
                // brought current first, so a persona switch
                // or memory write made a breath ago already
                // shapes this turn.
                await self.syncCorePersonaContext()
                // Watch (v0.37.0): the fresh frame goes
                // FIRST, awaited, so the core's eyes are
                // current before this message's turn runs —
                // the answer is grounded in the view as it
                // is. A no-op unless Watch is on.
                await self.uploadWatchFrames(turnRefresh: true)
                _ = try? await client.voiceSessionTranscript(sessionId: id, text: text)
            }
        }
    }

    // MARK: - Camera turns (v0.36.0)

    /// One captured photo, sent as the operator's turn.
    /// The capture is run through the chat pipeline's ONE
    /// transport treatment (ChatModel.transportPhotoData —
    /// long edge ≤1568 px, JPEG q0.8) and recorded as a
    /// CallPhotoEntry BEFORE anything is dispatched, so the
    /// transcript panel always shows that a photo was taken
    /// and what happened to it — a capture is never silently
    /// dropped. Then:
    ///
    /// - On-device: the photo is NOT dispatched — the
    ///   LocalBrain has no vision projector, so it could
    ///   only pretend to look. The entry carries the
    ///   established honest line (the same words chat stamps
    ///   on an on-device photo) and GUS says it out loud
    ///   through the normal pump, as a "[Photo]" turn.
    /// - Core: the photo rides the voice-session transcript
    ///   post as a photo-only turn — the same door a chat
    ///   photo takes into the pipeline (the core frames it
    ///   for its vision-capable brain; its turn record keeps
    ///   the count). The reply arrives through the normal
    ///   poll-and-speak flow and is SPOKEN. If GUS is mid-
    ///   reply, the photo barges in exactly like a typed
    ///   message does. If the core refuses the post or the
    ///   post fails, the entry's note is rewritten with the
    ///   refusal's own words — the record never claims a
    ///   delivery that didn't happen.
    ///
    /// Incognito: the photo lives only in this session's
    /// memory (the entry) — nothing is written to any store
    /// on this phone in any mode. In a Core-mode incognito
    /// call it travels to the Mac exactly like the call's
    /// audio does; that is the v0.34.0 boundary, unchanged.
    func sendPhotoTurn(rawImageData: Data) {
        guard phase == .live else { return }
        let data = ChatModel.transportPhotoData(rawImageData)
        if transport == .local {
            appendPhotoEntry(
                imageData: data,
                note: "This brain can't look at photos yet — switch to Core to ask about pictures.")
            speakCannedLocalTurn(
                transcript: "[Photo]",
                canned: "This brain can't look at photos yet — switch to Core to ask about pictures.")
            return
        }
        guard let id = sessionId else { return }
        appendPhotoEntry(
            imageData: data,
            note: "Photo sent to your Mac — GUS can see it there.")
        guard let entryID = photoEntries.last?.id else { return }
        liveReplyText = ""
        if gusSpeaking {
            cutSpeech()
            Task { _ = try? await client.voiceSessionInterrupt(sessionId: id) }
        }
        Task {
            do {
                // Persona (v0.40.0): the core's context is
                // brought current before the photo's turn
                // runs (see sendTypedMessage).
                await self.syncCorePersonaContext()
                let result = try await client.voiceSessionTranscript(
                    sessionId: id, text: "", images: [data])
                if !result.ok {
                    self.updatePhotoEntryNote(
                        entryID, "The photo wasn't sent — \(result.detail)")
                }
            } catch {
                self.updatePhotoEntryNote(
                    entryID,
                    "The photo wasn't sent — \(error.localizedDescription)")
            }
        }
    }

    /// Record, in plain words in the transcript panel, why
    /// a camera tap produced no photo — permission denied,
    /// no camera on this device. The call screen calls this
    /// from its permission gate; the words are the record.
    func notePhotoProblem(_ note: String) {
        guard phase == .live else { return }
        appendPhotoEntry(imageData: nil, note: note)
    }

    private func appendPhotoEntry(imageData: Data?, note: String) {
        photoEntries.append(CallPhotoEntry(
            imageData: imageData, note: note, turnAnchor: turns.count))
    }

    private func updatePhotoEntryNote(_ id: UUID, _ note: String) {
        guard let idx = photoEntries.firstIndex(where: { $0.id == id }) else { return }
        photoEntries[idx].note = note
    }

    // MARK: - Watch mode (v0.37.0)

    /// The Watch toggle (CallView's Watch control): the one
    /// and only way the camera starts. On-device, there is
    /// nothing to start — the local brain has no vision, so
    /// the toggle explains itself in plain words on the call
    /// screen and in the transcript, and NO frame is ever
    /// captured. In Core mode the core is told first (its
    /// refusal, if any, is the answer the operator sees);
    /// only then does the capture start and the sampler run.
    func setWatch(on: Bool) {
        if on {
            startWatch()
        } else {
            stopWatch(announce: true)
        }
    }

    private func startWatch() {
        guard phase == .live else { return }
        guard transport == .core, let id = sessionId else {
            let words = "Watching needs Core mode — this brain can't see yet."
            watchNotice = words
            appendPhotoEntry(imageData: nil, note: words)
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            beginWatch(sessionId: id)
        case .notDetermined:
            // The system's ask, in context, over the call
            // screen — the same discipline as the still
            // camera's gate (v0.36.0).
            Task {
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                guard granted else {
                    self.watchPermissionDenied()
                    return
                }
                guard self.phase == .live, self.transport == .core,
                      let id = self.sessionId else { return }
                self.beginWatch(sessionId: id)
            }
        case .denied, .restricted:
            watchPermissionDenied()
        @unknown default:
            watchPermissionDenied()
        }
    }

    private func watchPermissionDenied() {
        let words = "Camera access is off for GUS — turn it on in Settings → GUS → Camera if you want GUS to watch."
        watchNotice = words
        appendPhotoEntry(imageData: nil, note: words)
    }

    private func beginWatch(sessionId id: String) {
        Task {
            do {
                let result = try await client.voiceSessionWatch(
                    sessionId: id, on: true, cameras: watchMode.cameraNames)
                guard result.ok else {
                    watchNotice = result.detail
                    appendPhotoEntry(imageData: nil, note: result.detail)
                    return
                }
            } catch {
                let words = "Watching couldn't start — \(error.localizedDescription)"
                watchNotice = words
                appendPhotoEntry(imageData: nil, note: words)
                return
            }
            // The call may have ended while the core was
            // answering: then the watch is undone at once,
            // not left running into a dead session.
            guard phase == .live, sessionId == id else {
                _ = try? await client.voiceSessionWatch(
                    sessionId: id, on: false, cameras: [])
                return
            }
            watchOn = true
            watchNotice = nil
            watchBothSupported = WatchCaptureController.isMultiCamSupported
            watchCapture.onEffectiveModeChange = { [weak self] mode in
                Task { @MainActor in self?.watchFellBack(to: mode) }
            }
            watchCapture.onFailure = { [weak self] words in
                Task { @MainActor in
                    guard let self else { return }
                    self.watchNotice = words
                    self.appendPhotoEntry(imageData: nil, note: words)
                    self.stopWatch(announce: false)
                }
            }
            watchCapture.start(mode: watchMode)
            refreshWatchTorch()
            appendPhotoEntry(
                imageData: nil,
                note: "Watching on — GUS can see what the \(watchMode.label) sees. Frames aren't saved.")
            startWatchSampler()
            // The first frame as soon as the capture has one
            // to give (conversion takes a beat to land).
            Task {
                try? await Task.sleep(nanoseconds: 750_000_000)
                await self.uploadWatchFrames(turnRefresh: false)
            }
        }
    }

    /// Both cameras were asked for and this phone couldn't
    /// run them together on the day: the controller fell
    /// back to one camera — the call screen hears about it
    /// in the transcript, and the core's camera list is
    /// corrected to match what is actually streaming.
    private func watchFellBack(to mode: WatchCameraMode) {
        guard watchOn else { return }
        watchMode = mode
        refreshWatchTorch()
        appendPhotoEntry(
            imageData: nil,
            note: "This iPhone can't run both cameras at once right now — watching with the \(mode.label).")
        if let id = sessionId {
            Task {
                _ = try? await client.voiceSessionWatch(
                    sessionId: id, on: true, cameras: mode.cameraNames)
            }
        }
    }

    /// Watch off: capture stops, the sampler stops, the
    /// torch dies with the camera, and the core is told to
    /// drop the eyes it holds. Announced in the transcript
    /// only for the operator's own toggle — a call ending
    /// (endCall / fail) stops the watch silently, because
    /// the call's own ending is the announcement there.
    private func stopWatch(announce: Bool) {
        let wasOn = watchOn
        watchOn = false
        watchSamplerTask?.cancel()
        watchSamplerTask = nil
        watchCapture.stop()
        watchTorchOn = false
        watchSuspended = false
        if announce { watchNotice = nil }
        guard wasOn else { return }
        if let id = sessionId {
            Task {
                _ = try? await client.voiceSessionWatch(
                    sessionId: id, on: false, cameras: [])
            }
        }
        if announce {
            appendPhotoEntry(imageData: nil, note: "Watching off.")
        }
    }

    /// Flip / Both from the call screen: the capture
    /// rebuilds around the new mode, the core's camera list
    /// is re-posted to match, and the torch's usability is
    /// recomputed (the front camera has no torch to offer).
    func setWatchMode(_ newMode: WatchCameraMode) {
        guard newMode != watchMode else { return }
        watchMode = newMode
        guard watchOn else { return }
        watchCapture.setMode(newMode)
        refreshWatchTorch()
        if let id = sessionId {
            Task {
                _ = try? await client.voiceSessionWatch(
                    sessionId: id, on: true, cameras: newMode.cameraNames)
            }
        }
        VoiceFailureLog.shared.recordInfo("Watch camera: \(newMode.rawValue).")
    }

    func setWatchTorch(_ on: Bool) {
        if watchCapture.setTorch(on) {
            watchTorchOn = on
        }
    }

    private func refreshWatchTorch() {
        let backActive = watchMode == .back || watchMode == .both
        watchTorchUsable = backActive && watchCapture.backTorchAvailable
        if !watchTorchUsable && watchTorchOn {
            _ = watchCapture.setTorch(false)
            watchTorchOn = false
        }
    }

    /// The baseline sampler: while watching, a fresh frame
    /// set every 12 s. Suspended (backgrounded) ticks are
    /// skipped — no capture runs while the app is away, so
    /// there is nothing new to send.
    private func startWatchSampler() {
        watchSamplerTask?.cancel()
        watchSamplerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(
                    nanoseconds: Self.watchSampleSeconds * 1_000_000_000)
                guard let self, self.watchOn, self.phase == .live,
                      !self.watchSuspended else { continue }
                await self.uploadWatchFrames(turnRefresh: false)
            }
        }
    }

    /// Send the capture's latest frame for each live camera
    /// to the core as the session's eyes. Fire-and-forget by
    /// design: a frame that fails to land is superseded by
    /// the next one seconds later, and the core refuses
    /// frames for a call that has ended — neither is worth
    /// words on the call screen. Frames are encoded here,
    /// in memory, from the capture's stored images: nothing
    /// is written to any file, in any mode, incognito
    /// included (an incognito Core call's frames travel to
    /// the Mac exactly like its audio — the v0.34.0
    /// boundary — and are kept nowhere).
    func uploadWatchFrames(turnRefresh: Bool) async {
        guard watchOn, transport == .core, let id = sessionId else { return }
        for slot in watchMode.slots {
            guard let image = watchCapture.latestFrame(for: slot),
                  let encoded = WatchFrameEncoder.encode(image)
            else { continue }
            _ = try? await client.voiceSessionWatchFrame(
                sessionId: id, camera: slot.rawValue,
                image: encoded.data, hash: encoded.hash,
                turnRefresh: turnRefresh)
        }
    }

    /// The app left the foreground mid-watch: the capture
    /// session stops — the camera is OFF while the app is
    /// away. The call itself keeps running on its
    /// background-audio mode, as it always has; only the
    /// eyes close. The core keeps the last frames it held
    /// (memory only, dropped at Watch-off or call end); on
    /// return, a fresh frame replaces them at once.
    private func handleWatchBackground() {
        guard watchOn, !watchSuspended else { return }
        watchSuspended = true
        watchCapture.suspend()
        VoiceFailureLog.shared.recordInfo(
            "Watch suspended — the app left the foreground; the camera is off and sampling paused.")
    }

    private func handleWatchForeground() {
        guard watchOn, watchSuspended else { return }
        watchSuspended = false
        guard phase == .live else { return }
        watchCapture.resume()
        Task { await self.uploadWatchFrames(turnRefresh: false) }
        VoiceFailureLog.shared.recordInfo(
            "Watch resumed — the app is back in the foreground.")
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
            liveReplyText = ""
            lastPartialText = ""
            if !trimmed.isEmpty {
                if transport == .local {
                    answerLocally(trimmed)
                } else if sttMode == "local", let id = sessionId {
                    Task {
                        // Persona (v0.40.0): the core's
                        // context is brought current first
                        // (see sendTypedMessage).
                        await self.syncCorePersonaContext()
                        // Watch (v0.37.0): the fresh frame
                        // goes FIRST, awaited — the core's
                        // eyes are current before the turn
                        // runs (see sendTypedMessage). A
                        // no-op unless Watch is on.
                        await self.uploadWatchFrames(turnRefresh: true)
                        _ = try? await client.voiceSessionTranscript(sessionId: id, text: trimmed)
                    }
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
            recordShieldReceipt(scan, direction: .user)
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
        // The session style hears the turn (v0.33.0) only
        // once Shield has let it through — a blocked turn
        // never reaches the brain, so it teaches the style
        // nothing either (an injection's "tell me more"
        // must not move the stance). Noted BEFORE the
        // answer composes, so a stance change or an offer
        // suppression lands in this turn's prompt.
        PersonaSessionStyle.noteUserTurn(text)
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
        // The operator's own override: the turn is theirs
        // again, and the session style hears it now (it was
        // not noted while held — see answerLocally).
        PersonaSessionStyle.noteUserTurn(held.text)
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
        speakCannedLocalTurn(
            transcript: text,
            canned: "I stopped that — it matched a known injection pattern.")
    }

    /// Speak one locally-composed line as a complete turn:
    /// the transcript row, the phase, and the mouth, with
    /// nothing dispatched anywhere. Shared by the Shield
    /// block above and the camera turn's honest line below —
    /// both are cases where the app itself owes the operator
    /// an answer in words, out loud, on the record.
    private func speakCannedLocalTurn(transcript: String, canned: String) {
        localTurnCounter += 1
        let turnID = localTurnCounter
        turns.append(VoiceSessionState.Turn(
            index: turns.count, kind: "voice", detail: "",
            transcript: transcript, replyText: nil, interrupted: false))
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
        beginLocalTurn(input: text, transcript: text)
    }

    /// The turn engine, split from its transcript (v0.31.0):
    /// a normal answer is driven by — and recorded as — the
    /// operator's words; the connect-time GREETING is driven
    /// by a stage direction and records NO transcript (see
    /// greetLocally). Everything downstream — the pump, the
    /// reply-side Shield seam, barge-in — is shared verbatim.
    private func beginLocalTurn(input: String, transcript: String?) {
        // Session-style staleness (v0.33.0): the kept brain
        // was loaded with the prompt composed when it
        // loaded; a session-style change since (an offer
        // declined on the last turn, a length ask) makes it
        // stale in exactly the sense a persona pick does,
        // and it is dropped and reloaded here, between
        // turns — the connect path's own discipline, applied
        // mid-call. A reload that fails ends the turn
        // quietly rather than answering with the wrong
        // prompt; the next turn retries the load.
        if let kept = localBrain, !kept.isCurrent() {
            localBrain = nil
        }
        if localBrain == nil {
            guard let entry = ActiveBrain.resolved(),
                  let loaded = LocalBrain(modelURL: ModelStore.fileURL(for: entry))
            else { return }
            localBrain = loaded
        }
        guard let brain = localBrain, phase == .live else { return }
        localTurnCounter += 1
        let turnID = localTurnCounter
        turns.append(VoiceSessionState.Turn(
            index: turns.count, kind: "voice", detail: "",
            transcript: transcript, replyText: nil, interrupted: false))
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
            let reply = await brain.respond(to: input) { sentence in
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
                // The session style hears the reply (v0.33.0):
                // a real turn's answer is scanned for the
                // depth offer, so the person's NEXT turn can
                // resolve it. The greeting (transcript nil)
                // answers nobody and is never noted.
                if transcript != nil {
                    PersonaSessionStyle.noteReply(reply)
                }
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
        recordShieldReceipt(scan, direction: .assistant)
        return scan.verdict == .block
    }

    /// The call's one receipt seam (v0.34.0): in incognito
    /// the receipt is EPHEMERAL — the verdict is real and
    /// shown in the moment, but nothing is written to the
    /// persistent Shield log, so a call taken while
    /// incognito leaves no transcript-shaped trace behind.
    /// (The call's turns themselves are memory-only in
    /// every mode — this seam is the call surface's only
    /// persistence, and it is the one incognito closes.)
    private func recordShieldReceipt(_ scan: ShieldScanResult, direction: ShieldDirection) {
        if IncognitoMode.shared.isOn {
            ShieldReceiptLog.shared.recordEphemeral(scan, direction: direction)
        } else {
            ShieldReceiptLog.shared.record(scan, direction: direction)
        }
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
            // v0.40.0: a persona change made while the call
            // runs (another screen, the background) reaches
            // the core within a poll beat — see
            // syncCorePersonaContext. A no-op when nothing
            // changed, which is nearly every beat.
            await syncCorePersonaContext()
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
        // The live transcript's GUS row (v0.23.0): this
        // sentence is starting to play — put its words on
        // screen now, in order, so the reply reads as it is
        // spoken. Both transports pass through here (the
        // local sentence pump and the core's text segments);
        // audio segments carry no text and add nothing.
        liveReplyText = liveReplyText.isEmpty ? text : liveReplyText + " " + text
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
