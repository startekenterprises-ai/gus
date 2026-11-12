import AppKit
import AVFoundation
import Speech
import SwiftUI

/// The Settings window (v0.8, Desktop 2) — Glenn's direction:
/// setup and settings move out of the files and the web panel
/// and into the app, in the Muse app's settings shape (a section
/// sidebar, one pane per area).
///
/// It is a SURFACE MOVE, nothing more: every control is a call to
/// the same local panel API the web panel and wizard already use
/// (onboarding endpoints for provider/caps/Telegram, /api/kill,
/// /api/governor-mode, /api/approver-policy, /api/shield-policy).
/// Same settings, same landings (vault, Governor, policy file),
/// new home. The app stores nothing itself; API keys exist only
/// in the SecureField's memory between paste and save, and are
/// cleared on save.
final class SettingsWindowController: NSWindowController {
    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "GUS Settings"
        window.minSize = NSSize(width: 860, height: 580)
        super.init(window: window)
        window.contentViewController = NSHostingController(rootView: SettingsRootView())
        window.center()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("programmatic window only") }

    func show() {
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}

enum SettingsSection: String, CaseIterable, Identifiable {
    case general, provider, shield, caps, governor, telegram, voice, macBridge, delegates, dataControls, help

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: return "General"
        case .provider: return "Provider & model"
        case .shield: return "Agent-Shield gate"
        case .caps: return "Spend caps"
        case .governor: return "Governor & delegation"
        case .telegram: return "Telegram"
        case .voice: return "Voice"
        case .macBridge: return "Mac bridge"
        case .delegates: return "Delegates"
        case .dataControls: return "Data controls"
        case .help: return "Help & support"
        }
    }

    var symbol: String {
        switch self {
        case .general: return "gearshape"
        case .provider: return "cpu"
        case .shield: return "shield"
        case .caps: return "dollarsign.circle"
        case .governor: return "slider.horizontal.3"
        case .telegram: return "paperplane"
        case .voice: return "waveform"
        case .macBridge: return "desktopcomputer"
        case .delegates: return "person.2"
        case .dataControls: return "folder"
        case .help: return "questionmark.circle"
        }
    }
}

/// The Settings window's store: one load of the panel's read
/// models (status, onboarding, help registry, settings detail)
/// plus the editable drafts the panes bind to. Drafts seed once
/// from what is on file; a save posts the panel's own endpoint
/// and reloads, so the pane always ends up showing the panel's
/// answer — including its refusal text, verbatim, as the notice.
final class SettingsModel: ObservableObject {
    @Published var status: PanelStatus?
    @Published var onboarding: PanelOnboarding?
    @Published var helpEntries: [PanelHelpEntry] = []
    @Published var detail: PanelSettingsDetail?
    @Published var notice: String?
    @Published var reachable = false

    // Drafts (seeded once from what is on file).
    @Published var providerId = "gemini"
    @Published var modelName = ""
    @Published var apiKey = ""
    @Published var baseUrl = ""
    @Published var shieldRequired = true
    @Published var shieldFailMode = "closed"
    @Published var capTask = ""
    @Published var capDay = ""
    @Published var capMonth = ""
    @Published var delGusDelegates = false
    @Published var delGusOwn = false
    @Published var delDelegates = false
    @Published var delScope = "bounded"
    @Published var delMax = "30"
    @Published var tgToken = ""
    // Voice drafts (v0.9): seeded from GET /api/voice/settings —
    // its own endpoint, because voice.json is its own settings
    // file and is NOT part of the status payload.
    @Published var voiceEnabled = false
    @Published var voiceBargeIn = true
    /// v0.9.6: the speech engines — "local" (built into the app)
    /// or "endpoint" (the URL fields). Seeded from the settings
    /// read; a panel that doesn't send them seeds the shipped
    /// default, "local".
    @Published var voiceSttEngine = "local"
    @Published var voiceTtsEngine = "local"
    @Published var voiceSttUrl = ""
    @Published var voiceSttModel = ""
    @Published var voiceTtsUrl = ""
    @Published var voiceTtsModel = ""
    @Published var voiceTtsVoice = ""
    /// v0.9.9: the voice Shield-scan switch — seeded from the
    /// settings read; a panel that doesn't send it seeds the
    /// shipped default, ON.
    @Published var voiceShieldScan = true
    private var voiceSeeded = false

    // Voice test state (v0.9.9) — Test Connection results per
    // endpoint, and the Test mic and speaker check's live state.
    @Published var voiceSttTestResult: String?
    @Published var voiceTtsTestResult: String?
    @Published var voiceTestRunning = false
    /// The mic level as a 0…1 bar fraction, from the test tap's
    /// float RMS — the same raw, pre-conversion measurement the
    /// call's hearing line uses, scaled for display.
    @Published var voiceTestMicLevel: Double = 0
    @Published var voiceTestSpeakerResult: String?
    @Published var voiceTestHeard: String?
    @Published var voiceTestVerdict: String?
    private var voiceTestEngine: AVAudioEngine?
    private var voiceTestSynthesizer = AVSpeechSynthesizer()
    private var voiceTestPlayer: AVAudioPlayer?
    private var voiceTestTimer: Timer?
    private var voiceTestStartedAt = Date()
    // The dictation trial's measurement (v0.9.9 amendment): the
    // phrase's own span (first loud moment → last loud moment,
    // from the test tap's levels) and the recognition lag (the
    // endAudio() the trial sends when the phrase settles → the
    // final result's arrival). Their comparison is the speed
    // verdict — measured here, from the recognizer's own
    // timestamps, never estimated.
    private var voiceTestRecognizer: SFSpeechRecognizer?
    private var voiceTestRequest: SFSpeechAudioBufferRecognitionRequest?
    private var voiceTestTask: SFSpeechRecognitionTask?
    private var voiceTestFirstLoudAt: Date?
    private var voiceTestLastLoudAt = Date.distantPast
    private var voiceTestPartial = ""
    private var voiceTestPartialLastChange = Date()
    private var voiceTestEndAudioAt: Date?
    private var voiceTestEndAudioSent = false

    let client = PanelClient()
    private var seeded = false

    var helpById: [String: PanelHelpEntry] {
        Dictionary(uniqueKeysWithValues: helpEntries.map { ($0.id, $0) })
    }

    func help(_ id: String) -> PanelHelpEntry? { helpById[id] }

    func load() {
        client.get("/api/status", as: PanelStatus.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let s):
                    self.status = s
                    self.reachable = true
                    self.seed(from: s)
                case .failure:
                    self.status = nil
                    self.reachable = false
                }
            }
        }
        client.get("/api/onboarding", as: PanelOnboarding.self) { [weak self] result in
            DispatchQueue.main.async {
                if case .success(let o) = result { self?.onboarding = o }
            }
        }
        client.get("/api/help", as: PanelHelpResponse.self) { [weak self] result in
            DispatchQueue.main.async {
                if case .success(let h) = result { self?.helpEntries = h.entries }
            }
        }
        client.get("/api/settings-detail", as: PanelSettingsDetail.self) { [weak self] result in
            DispatchQueue.main.async {
                if case .success(let d) = result { self?.detail = d }
            }
        }
        client.get("/api/voice/settings", as: PanelVoiceSettings.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, case .success(let v) = result, !self.voiceSeeded else { return }
                self.voiceSeeded = true
                self.voiceEnabled = v.enabled
                self.voiceBargeIn = v.bargeIn ?? true
                self.voiceSttEngine = v.sttEngine ?? "local"
                self.voiceTtsEngine = v.ttsEngine ?? "local"
                self.voiceSttUrl = v.sttBaseUrl
                self.voiceSttModel = v.sttModel
                self.voiceTtsUrl = v.ttsBaseUrl
                self.voiceTtsModel = v.ttsModel
                self.voiceTtsVoice = v.ttsVoice
                self.voiceShieldScan = v.shieldScan ?? true
            }
        }
    }

    private func seed(from s: PanelStatus) {
        guard !seeded else { return }
        seeded = true
        providerId = s.provider.id
        modelName = s.provider.model
        shieldRequired = s.shield.required
        shieldFailMode = s.shield.onUnavailable
        let caps = s.settings.caps
        capTask = caps.maxUsdPerTask.map(trimNum) ?? ""
        capDay = caps.maxUsdPerDay.map(trimNum) ?? ""
        capMonth = caps.maxUsdPerMonth.map(trimNum) ?? ""
        let p = s.settings.approverPolicy
        delGusDelegates = p.gusApprovesDelegates
        delGusOwn = p.gusApprovesOwn
        delDelegates = p.delegatesMayApprove
        delScope = p.scope
        delMax = String(p.maxApprovalsPerHour)
    }

    func trimNum(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(v)
    }

    /// One settings action: POST the panel endpoint, surface its
    /// detail verbatim (success or refusal), then reload so the
    /// pane reflects what is actually on file.
    func act(_ path: String, body: [String: Any] = [:]) {
        client.post(path, jsonBody: body) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let r):
                    self.notice = r.detail
                case .failure(let e):
                    self.notice = "Could not reach the panel: \(e.localizedDescription)"
                }
                self.load()
            }
        }
    }

    // MARK: Actions (one per control; all panel endpoints)

    func saveProvider() {
        var body: [String: Any] = ["provider": providerId, "model": modelName]
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !key.isEmpty { body["apiKey"] = key }
        let base = baseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        if !base.isEmpty { body["baseUrl"] = base }
        apiKey = "" // the field never keeps a key after a save attempt
        act("/api/onboarding/provider", body: body)
    }

    func saveShieldPolicy() {
        act("/api/shield-policy", body: ["required": shieldRequired, "onUnavailable": shieldFailMode])
    }

    func provisionShield() {
        act("/api/onboarding/shield", body: ["onUnavailable": shieldFailMode])
    }

    func saveCaps() {
        let ob = onboarding?.suggestedCaps
        act("/api/onboarding/caps", body: [
            "maxUsdPerTask": Double(capTask) ?? ob?.maxUsdPerTask ?? 2,
            "maxUsdPerDay": Double(capDay) ?? ob?.maxUsdPerDay ?? 10,
            "maxUsdPerMonth": Double(capMonth) ?? ob?.maxUsdPerMonth ?? 100,
        ])
    }

    func setMode(_ mode: String) {
        act("/api/governor-mode", body: ["mode": mode])
    }

    func saveDelegation() {
        act("/api/approver-policy", body: [
            "gusApprovesDelegates": delGusDelegates,
            "gusApprovesOwn": delGusOwn,
            "delegatesMayApprove": delDelegates,
            "scope": delScope,
            "maxApprovalsPerHour": Int(delMax) ?? 30,
        ])
    }

    func saveTelegram() {
        let token = tgToken.trimmingCharacters(in: .whitespacesAndNewlines)
        tgToken = ""
        act("/api/onboarding/telegram", body: ["token": token])
    }

    func saveVoice() {
        act("/api/voice/settings", body: [
            "enabled": voiceEnabled,
            "bargeIn": voiceBargeIn,
            "shieldScan": voiceShieldScan,
            "sttEngine": voiceSttEngine,
            "ttsEngine": voiceTtsEngine,
            "sttBaseUrl": voiceSttUrl.trimmingCharacters(in: .whitespacesAndNewlines),
            "sttModel": voiceSttModel.trimmingCharacters(in: .whitespacesAndNewlines),
            "ttsBaseUrl": voiceTtsUrl.trimmingCharacters(in: .whitespacesAndNewlines),
            "ttsModel": voiceTtsModel.trimmingCharacters(in: .whitespacesAndNewlines),
            "ttsVoice": voiceTtsVoice.trimmingCharacters(in: .whitespacesAndNewlines),
        ])
    }

    // MARK: Voice tests (v0.9.9)

    /// Test Connection: probe the endpoint the form is showing
    /// RIGHT NOW (the draft URL + model — unsaved; the route
    /// stores nothing). The result replaces the button's line:
    /// reachable or not, the round-trip time, and whether the
    /// model is in the endpoint's list, in the control plane's
    /// own plain sentence.
    func testVoiceConnection(kind: String) {
        let isStt = kind == "stt"
        if isStt { voiceSttTestResult = "Testing…" } else { voiceTtsTestResult = "Testing…" }
        client.testVoiceConnection(
            kind: kind,
            baseUrl: (isStt ? voiceSttUrl : voiceTtsUrl).trimmingCharacters(in: .whitespacesAndNewlines),
            model: (isStt ? voiceSttModel : voiceTtsModel).trimmingCharacters(in: .whitespacesAndNewlines)
        ) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                let text: String
                switch result {
                case .success(let r): text = r.detail
                case .failure(let e): text = "Couldn't run the test: \(e.localizedDescription)"
                }
                if isStt { self.voiceSttTestResult = text } else { self.voiceTtsTestResult = text }
            }
        }
    }

    /// Test mic and speaker (Teams-style, lite): one tap on the
    /// same kind of capture the call uses (an AVAudioEngine tap
    /// in the input's native format, raw levels — no second
    /// recorder stack, nothing recorded or sent anywhere), the
    /// test sentence through the SELECTED speech engine, and —
    /// when transcription is built-in — a dictation trial with
    /// a measured speed verdict. Toggling again (or the trial
    /// finishing, or 20 s passing) tears it all down.
    func toggleVoiceTest() {
        if voiceTestRunning {
            stopVoiceTest()
        } else {
            startVoiceTest()
        }
    }

    private func startVoiceTest() {
        voiceTestRunning = true
        voiceTestStartedAt = Date()
        voiceTestMicLevel = 0
        voiceTestSpeakerResult = nil
        voiceTestHeard = nil
        voiceTestVerdict = nil
        voiceTestFirstLoudAt = nil
        voiceTestLastLoudAt = Date.distantPast
        voiceTestPartial = ""
        voiceTestEndAudioAt = nil
        voiceTestEndAudioSent = false

        let engine = AVAudioEngine()
        voiceTestEngine = engine
        engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buffer, _ in
            guard let self else { return }
            let rms = Self.testBufferRms(buffer)
            // The built-in ears eat the same buffer, in the
            // format the microphone delivered it — the call's
            // own arrangement, reused for the trial.
            self.voiceTestRequest?.append(buffer)
            DispatchQueue.main.async {
                guard self.voiceTestRunning else { return }
                self.voiceTestMicLevel = min(1, rms * 4)
                if rms > 0.02 {
                    if self.voiceTestFirstLoudAt == nil { self.voiceTestFirstLoudAt = Date() }
                    self.voiceTestLastLoudAt = Date()
                }
            }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            voiceTestVerdict = "The microphone wouldn't start: \(error.localizedDescription)"
            stopVoiceTest()
            return
        }

        runVoiceSpeakerTest()
        if voiceSttEngine == "local" {
            startVoiceDictationTrial()
        } else {
            voiceTestVerdict = "Transcription is set to Endpoint, so there's no built-in dictation trial — Test Connection above is that endpoint's check."
        }
        voiceTestTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.voiceTestTick()
        }
    }

    private func stopVoiceTest() {
        voiceTestTimer?.invalidate()
        voiceTestTimer = nil
        voiceTestTask?.cancel()
        voiceTestTask = nil
        voiceTestRequest = nil
        voiceTestRecognizer = nil
        voiceTestEngine?.inputNode.removeTap(onBus: 0)
        voiceTestEngine?.stop()
        voiceTestEngine = nil
        voiceTestRunning = false
        voiceTestMicLevel = 0
    }

    /// The speaker half: built-in speaks with the same
    /// synthesizer the call's built-in mouth uses; Endpoint
    /// asks the control plane to synthesize the sentence with
    /// the form's current (unsaved) values and plays the audio
    /// that comes back.
    private func runVoiceSpeakerTest() {
        if voiceTtsEngine == "local" {
            let utterance = AVSpeechUtterance(string: "This is the GUS speaker test. If you can hear me, your built-in speech works.")
            utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate
            voiceTestSynthesizer.speak(utterance)
            voiceTestSpeakerResult = "Playing the test sentence with the built-in voice — listen for it."
            return
        }
        voiceTestSpeakerResult = "Asking the speech endpoint for the test sentence…"
        client.testVoiceSpeech(
            baseUrl: voiceTtsUrl.trimmingCharacters(in: .whitespacesAndNewlines),
            model: voiceTtsModel.trimmingCharacters(in: .whitespacesAndNewlines),
            voice: voiceTtsVoice.trimmingCharacters(in: .whitespacesAndNewlines)
        ) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let r):
                    if r.ok, let b64 = r.audioBase64, let data = Data(base64Encoded: b64) {
                        self.voiceTestPlayer = try? AVAudioPlayer(data: data)
                        self.voiceTestPlayer?.play()
                        self.voiceTestSpeakerResult = "Playing the test sentence from the endpoint — listen for it."
                    } else {
                        self.voiceTestSpeakerResult = "Speaker test failed: \(r.detail)"
                    }
                case .failure(let e):
                    self.voiceTestSpeakerResult = "Speaker test couldn't run: \(e.localizedDescription)"
                }
            }
        }
    }

    /// The dictation trial: the call's recognizer configuration
    /// (partials on, on-device when supported), the call's
    /// sentence-end rule (partial stable ~1 s + mic quiet ~1 s
    /// → endAudio), and the call's timestamps — the phrase's
    /// span comes from the tap's loud moments, the lag from
    /// endAudio to the final. The verdict thresholds: a lag of
    /// at most 1 s and at most half the phrase is REAL TIME;
    /// at most 2.5 s and at most the whole phrase is
    /// BORDERLINE; anything worse — or no final inside the
    /// test window — is TOO SLOW, with the endpoint nudge.
    private func startVoiceDictationTrial() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self, self.voiceTestRunning else { return }
                guard status == .authorized,
                      let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
                      recognizer.isAvailable else {
                    self.voiceTestVerdict = "Built-in recognition isn't available right now — Dictation and Siri must be on (System Settings → Keyboard → Dictation), and Speech Recognition allowed for GUS. That's the usual cause."
                    return
                }
                self.voiceTestRecognizer = recognizer
                let request = SFSpeechAudioBufferRecognitionRequest()
                request.shouldReportPartialResults = true
                if recognizer.supportsOnDeviceRecognition {
                    request.requiresOnDeviceRecognition = true
                }
                self.voiceTestRequest = request
                self.voiceTestTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                    DispatchQueue.main.async {
                        guard let self, self.voiceTestRunning else { return }
                        if let result, result.isFinal {
                            self.finishVoiceDictation(heard: result.bestTranscription.formattedString)
                            return
                        }
                        if let result {
                            let text = result.bestTranscription.formattedString
                            if text != self.voiceTestPartial {
                                self.voiceTestPartial = text
                                self.voiceTestPartialLastChange = Date()
                            }
                        }
                        if let error {
                            self.voiceTestVerdict = "Built-in recognition stopped during the trial: \(error.localizedDescription)"
                            self.stopVoiceTest()
                        }
                    }
                }
            }
        }
    }

    private func voiceTestTick() {
        guard voiceTestRunning else { return }
        let now = Date()
        // Sentence end, the call's rule: words settled + mic
        // quiet for ~1 s → end the audio and start the lag clock.
        if voiceSttEngine == "local", !voiceTestEndAudioSent,
           !voiceTestPartial.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           now.timeIntervalSince(voiceTestPartialLastChange) >= 1.0,
           now.timeIntervalSince(voiceTestLastLoudAt) >= 1.0 {
            voiceTestEndAudioSent = true
            voiceTestEndAudioAt = now
            voiceTestRequest?.endAudio()
        }
        // The window: 20 s is plenty for a short phrase. No
        // final by then IS the verdict — the slow-Mac case this
        // test exists to catch before a call does.
        if now.timeIntervalSince(voiceTestStartedAt) >= 20 {
            if voiceSttEngine == "local", voiceTestHeard == nil {
                voiceTestVerdict = "Speed verdict: too slow on this Mac — no finished transcript arrived within 20 seconds. Try an endpoint instead: set Transcription (STT) to Endpoint above and use Test Connection on your speech service."
            }
            stopVoiceTest()
        }
    }

    private func finishVoiceDictation(heard: String) {
        let finalAt = Date()
        voiceTestHeard = heard.isEmpty ? "(the recognizer handed back an empty transcript)" : heard
        let phraseStart = voiceTestFirstLoudAt ?? voiceTestStartedAt
        let phraseSeconds = max(0.3, voiceTestLastLoudAt.timeIntervalSince(phraseStart))
        // The lag clock starts at endAudio when the trial sent
        // it, else at the last loud moment — and if the meter
        // never registered a loud moment (a whisper under its
        // floor), it starts at the final itself rather than
        // manufacturing a huge lag out of a bookkeeping gap.
        let lagBase = voiceTestEndAudioAt
            ?? (voiceTestFirstLoudAt != nil ? voiceTestLastLoudAt : finalAt)
        let lagSeconds = max(0, finalAt.timeIntervalSince(lagBase))
        let phraseText = String(format: "%.1f", phraseSeconds)
        let lagText = String(format: "%.1f", lagSeconds)
        if lagSeconds <= 1.0 && lagSeconds <= 0.5 * phraseSeconds {
            voiceTestVerdict = "Speed verdict: real time on this Mac — the phrase took \(phraseText) s to say and the finished transcript arrived \(lagText) s after you stopped. Built-in transcription should keep up in a call here."
        } else if lagSeconds <= 2.5 && lagSeconds <= phraseSeconds {
            voiceTestVerdict = "Speed verdict: borderline on this Mac — the phrase took \(phraseText) s to say and the finished transcript arrived \(lagText) s after you stopped. Calls will feel laggy; an endpoint may serve you better."
        } else {
            voiceTestVerdict = "Speed verdict: too slow on this Mac — the phrase took \(phraseText) s to say and the finished transcript arrived \(lagText) s after you stopped. Try an endpoint instead: set Transcription (STT) to Endpoint above and use Test Connection on your speech service."
        }
        stopVoiceTest()
    }

    /// Raw level of one test-tap buffer, 0…1 scale: float
    /// samples when the input runs float (the usual case), the
    /// int16 channel normalized when it doesn't.
    private static func testBufferRms(_ buffer: AVAudioPCMBuffer) -> Double {
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return 0 }
        if let floats = buffer.floatChannelData {
            let ch = floats[0]
            var sum: Double = 0
            for i in 0..<frames {
                let s = Double(ch[i])
                sum += s * s
            }
            return sqrt(sum / Double(frames))
        }
        if let ints = buffer.int16ChannelData {
            let ch = ints[0]
            var sum: Double = 0
            for i in 0..<frames {
                let s = Double(ch[i]) / 32_768.0
                sum += s * s
            }
            return sqrt(sum / Double(frames))
        }
        return 0
    }

    func setKilled(_ on: Bool) {
        act("/api/kill", body: ["on": on])
    }

    func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    func openPanelPage(_ path: String) {
        NSWorkspace.shared.open(client.panelURL(path))
    }
}

/// The registry's native face: a "?" beside a control; tapping it
/// shows the entry's tip and docs body from GET /api/help — the
/// same text as the web panel's pop-ups, fetched, never copied
/// into Swift. Renders nothing until the registry has loaded and
/// only for ids the registry actually carries.
struct HelpMark: View {
    let entry: PanelHelpEntry?
    @State private var shown = false

    var body: some View {
        if let entry {
            Button {
                shown.toggle()
            } label: {
                Image(systemName: "questionmark.circle")
                    .foregroundColor(.secondary)
            }
            .buttonStyle(.plain)
            .help("What this does")
            .popover(isPresented: $shown, arrowEdge: .trailing) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(entry.title)
                        .font(.headline)
                    Text(entry.tip)
                        .font(.callout)
                    Divider()
                    ScrollView {
                        Text(entry.body)
                            .font(.callout)
                            .foregroundColor(.secondary)
                    }
                    .frame(maxHeight: 240)
                }
                .padding(14)
                .frame(width: 360)
            }
        }
    }
}

/// The window: a section sidebar (Muse-settings shape) + the
/// selected pane, with the last action's outcome pinned under the
/// pane — the panel's own words, so a refusal is never silent.
struct SettingsRootView: View {
    @StateObject private var model = SettingsModel()
    @State private var section: SettingsSection? = .general

    var body: some View {
        HStack(spacing: 0) {
            List(selection: $section) {
                ForEach(SettingsSection.allCases) { s in
                    Label(s.title, systemImage: s.symbol)
                        .tag(s)
                }
            }
            .listStyle(.sidebar)
            .frame(width: 230)

            Divider()

            VStack(spacing: 0) {
                ScrollView {
                    Group {
                        switch section ?? .general {
                        case .general: SettingsGeneralView(model: model)
                        case .provider: SettingsProviderView(model: model)
                        case .shield: SettingsShieldView(model: model)
                        case .caps: SettingsCapsView(model: model)
                        case .governor: SettingsGovernorView(model: model)
                        case .telegram: SettingsTelegramView(model: model)
                        case .voice: SettingsVoiceView(model: model)
                        case .macBridge: SettingsMacBridgeView(model: model)
                        case .delegates: SettingsDelegatesView(model: model)
                        case .dataControls: SettingsDataView(model: model)
                        case .help: SettingsHelpView(model: model)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
                }
                if let notice = model.notice {
                    Divider()
                    Text(notice)
                        .font(.callout)
                        .foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 860, minHeight: 580)
        .onAppear { model.load() }
    }
}

/// Shared pane furniture: a titled row with an optional help mark,
/// and a plain value row.
struct SettingsRow: View {
    let title: String
    let value: String
    var help: PanelHelpEntry? = nil

    var body: some View {
        HStack(spacing: 6) {
            Text(title)
                .fontWeight(.medium)
            HelpMark(entry: help)
            Spacer()
            Text(value)
                .foregroundColor(.secondary)
        }
    }
}

struct SettingsPaneTitle: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.title2)
            .fontWeight(.semibold)
            .padding(.bottom, 4)
    }
}
