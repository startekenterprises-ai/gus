import AVFoundation
import Foundation

/// Cross-window requests, posted by views and observed by the app
/// delegate (windows) or this model (the setup sheet).
extension Notification.Name {
    static let gusOpenSettings = Notification.Name("gus.openSettings")
    static let gusCheckForUpdates = Notification.Name("gus.checkForUpdates")
    static let gusRunSetup = Notification.Name("gus.runSetup")
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
    /// app's own latest mic level. The gap between the two IS
    /// the diagnosis when a call won't take a turn: mic moving
    /// + heard flat means the audio dies between here and the
    /// segmenter; both flat means the microphone itself.
    @Published var voiceHearingLine: String?
    /// The app's own latest shipped chunk's energy (the same
    /// PCM the tick posts), on the int16 scale like the
    /// server's numbers, so the two compare directly.
    private var voiceMicLevel = 0
    private var voiceSessionId: String?
    private var voiceBargeIn = true
    private var voiceLastSeq = 0
    // Capture: AVAudioEngine tap → converter → a PCM16 stash the
    // chunk timer drains in ~250 ms posts (never from the audio
    // thread itself).
    private var voiceEngine: AVAudioEngine?
    private var voiceConverter: AVAudioConverter?
    private let voiceTargetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private var voiceStash = Data()
    private let voiceStashLock = NSLock()
    private var voiceChunkTimer: Timer?
    private var voicePollTimer: Timer?
    private var voiceLoudStreak = 0
    // Capture health (v0.9.2): frames the converter actually
    // produced vs buffers it dropped (error / zero frames),
    // counted on the audio thread under the stash lock and read
    // by the health check on the main thread. The 0.9.1 capture
    // dropped silently by design, so a converter that produced
    // nothing presented as a call that listened forever; now a
    // call whose capture yields no frames within 2 s restarts
    // once without voice processing, and a call that STILL
    // yields nothing ends with the reason on the notice instead
    // of listening forever.
    private var voiceConvertedFrames = 0
    private var voiceDroppedBuffers = 0
    private var voiceCaptureRestarted = false
    private var voiceHealthTimer: Timer?
    // Playback: a queue of sentence segments through one player,
    // advanced by the chunk timer (no delegate — the timer asks
    // isPlaying, which is all the chaining needs).
    private var voicePlayer: AVAudioPlayer?
    private var voicePlayQueue: [Data] = []
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
    /// asked first (the same gate as 0.9.0), then the session is
    /// opened in the control plane, and only then does capture
    /// start — the order matters: no session, no microphone.
    func startVoiceCall() {
        guard !voiceInCall else { return }
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                guard granted else {
                    self.notice = "Microphone access is off for GUS — grant it in System Settings → Privacy & Security → Microphone, then try the call again."
                    return
                }
                self.client.startVoiceSession { [weak self] result in
                    DispatchQueue.main.async {
                        guard let self else { return }
                        switch result {
                        case .success(let session) where session.ok && session.active:
                            self.voiceSessionId = session.sessionId
                            self.voiceBargeIn = session.bargeIn ?? true
                            self.voiceTurns = session.turns
                            self.voiceLastSeq = 0
                            self.voicePlayQueue = []
                            self.voiceLatencyLine = nil
                            self.voiceHearingLine = nil
                            self.voiceMicLevel = 0
                            self.voiceCaptureRestarted = false
                            self.voiceInCall = true
                            self.notice = session.detail
                            self.beginVoiceCapture()
                            self.voiceChunkTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                                self?.voiceChunkTick()
                            }
                            self.voicePollTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
                                self?.pollVoiceSession()
                            }
                        case .success(let session):
                            self.notice = session.detail
                        case .failure(let e):
                            self.notice = "The call didn't reach GUS: \(e.localizedDescription)"
                        }
                    }
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

    private func beginVoiceCapture(voiceProcessing: Bool = true) {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        // Voice processing (echo cancellation + gain control)
        // where the hardware offers it: GUS's own spoken reply
        // stays out of the microphone, which is what keeps the
        // barge-in energy check honest. If it's refused, the
        // plain input still carries the call. (v0.9.2: the
        // capture health check below restarts WITHOUT it when
        // it yields no convertible audio on this microphone.)
        if voiceProcessing {
            try? input.setVoiceProcessingEnabled(true)
        }
        let format = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: format, to: voiceTargetFormat) else {
            notice = "This Mac's microphone format can't be converted for the call — nothing is being recorded."
            teardownVoice(sendEnd: true)
            return
        }
        voiceConverter = converter
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            self?.ingestVoiceBuffer(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
            voiceEngine = engine
            // A fresh capture starts with a clean health slate,
            // and the check runs 2 s in: frames by then, or the
            // self-heal (once) / honest ending (after that).
            voiceStashLock.lock()
            voiceConvertedFrames = 0
            voiceDroppedBuffers = 0
            voiceStashLock.unlock()
            scheduleVoiceHealthCheck()
        } catch {
            notice = "The microphone wouldn't start: \(error.localizedDescription)"
            teardownVoice(sendEnd: true)
        }
    }

    /// The capture health check (v0.9.2), ~2 s after a capture
    /// (re)starts: if the converter has produced ZERO frames by
    /// now, the audio path is dead however healthy the engine
    /// looks. The first death restarts capture once without
    /// voice processing (the notice says so); a second death
    /// ends the call with the reason stated — never a call that
    /// listens forever in silence.
    private func scheduleVoiceHealthCheck() {
        voiceHealthTimer?.invalidate()
        voiceHealthTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { [weak self] _ in
            guard let self, self.voiceInCall else { return }
            self.voiceStashLock.lock()
            let frames = self.voiceConvertedFrames
            self.voiceStashLock.unlock()
            guard frames == 0 else { return }
            if !self.voiceCaptureRestarted {
                self.voiceCaptureRestarted = true
                self.notice = "Voice processing didn't agree with this microphone — restarted the call audio without it."
                self.stopVoiceCapture()
                self.beginVoiceCapture(voiceProcessing: false)
            } else {
                self.notice = "The microphone produced no usable audio — the call is closed. Check the microphone and try the call again."
                self.teardownVoice(sendEnd: true)
            }
        }
    }

    /// Stop just the capture (tap, engine, converter, stash) —
    /// the session stays open. The health restart uses this;
    /// teardownVoice uses it too, on its way to ending the
    /// session as well.
    private func stopVoiceCapture() {
        voiceHealthTimer?.invalidate()
        voiceHealthTimer = nil
        voiceEngine?.inputNode.removeTap(onBus: 0)
        voiceEngine?.stop()
        voiceEngine = nil
        voiceConverter = nil
        voiceStashLock.lock()
        voiceStash = Data()
        voiceStashLock.unlock()
    }

    /// Audio-thread work: convert one input buffer to the call's
    /// PCM16 shape and stash it. Nothing here posts, allocates
    /// UI, or touches published state — the chunk timer does all
    /// of that on the main thread.
    private func ingestVoiceBuffer(_ buffer: AVAudioPCMBuffer) {
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
            // v0.9.2: a buffer arrived and produced nothing —
            // counted, under the lock, for the health check.
            // (Before, this guard returned silently, which is
            // why a dead converter looked exactly like a quiet
            // room.) A converter that isn't there at all — the
            // guard at the top — is teardown's business, not a
            // drop.
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
            // The app's own level for this chunk — the same
            // number the barge-in check uses — kept for the
            // in-call strip's hearing line, where it sits next
            // to the server's heard level (v0.9.2).
            voiceMicLevel = Int(Self.pcmRms(chunk).rounded())
            // Barge-in, the app's half: sustained speech energy
            // while GUS is audibly talking means the operator is
            // talking over it — stop the player here, and tell
            // the control plane to drop the rest of the reply.
            if voiceBargeIn, voicePlayer?.isPlaying == true {
                if Self.pcmRms(chunk) > 900 {
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
                if case .success(let seg) = result,
                   let seq = seg.seq,
                   let b64 = seg.audioBase64,
                   let data = Data(base64Encoded: b64) {
                    self.voiceLastSeq = seq
                    self.voicePlayQueue.append(data)
                }
                self.advanceVoicePlayback()
            }
        }
        advanceVoicePlayback()
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
        stopVoiceCapture()
        cutVoicePlayback()
        voiceSessionId = nil
        voiceInCall = false
        voicePhase = "listening"
    }

    private static func seconds(_ ms: Double) -> String {
        String(format: "%.1fs", ms / 1000)
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
