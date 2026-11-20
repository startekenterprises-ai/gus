import AppKit
import AVFoundation
import Speech
import SwiftUI

/// Settings (v0.8, Desktop 2) — Glenn's direction: setup and
/// settings move out of the files and the web panel and into
/// the app, in the Muse app's settings shape (a section
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
///
/// v0.14.0: the separate Settings WINDOW is gone — Settings is
/// a section of the main window (RootView owns the model and
/// the pane selection; the app delegate forwards the open
/// request as .gusShowSettingsSection). Every pane moved 1:1;
/// no capability changed home with it, only the window did.

enum SettingsSection: String, CaseIterable, Identifiable {
    case protection, general, provider, shield, caps, governor, telegram, voice, devices, macBridge, delegates, dataControls, help

    var id: String { rawValue }

    var title: String {
        switch self {
        case .protection: return "Protection"
        case .general: return "General"
        case .provider: return "Provider & model"
        case .shield: return "Agent-Shield gate"
        case .caps: return "Spend caps"
        case .governor: return "Governor & delegation"
        case .telegram: return "Telegram"
        case .voice: return "Voice"
        case .devices: return "Devices & identity"
        case .macBridge: return "Mac bridge"
        case .delegates: return "Delegates"
        case .dataControls: return "Data controls"
        case .help: return "Help & support"
        }
    }

    var symbol: String {
        switch self {
        case .protection: return "shield.fill"
        case .general: return "gearshape"
        case .provider: return "cpu"
        case .shield: return "shield"
        case .caps: return "dollarsign.circle"
        case .governor: return "slider.horizontal.3"
        case .telegram: return "paperplane"
        case .voice: return "waveform"
        case .devices: return "iphone"
        case .macBridge: return "desktopcomputer"
        case .delegates: return "person.2"
        case .dataControls: return "folder"
        case .help: return "questionmark.circle"
        }
    }
}

/// The Settings section's store: one load of the panel's read
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
    /// v0.17.2: the bundled Kokoro engine's status line —
    /// the control plane's own sentence (Downloading… /
    /// Ready / Unavailable + reason), shown under the Speech
    /// picker when Built-in Kokoro is the picked engine.
    /// Empty when the control plane reports no bundled
    /// engine. Refreshed on its own (refreshVoiceSettings)
    /// so a download's progress lands without touching the
    /// operator's unsaved form edits. v0.17.5: the pane's
    /// Kokoro line is always visible — this sentence fills
    /// it when Kokoro is the saved engine; otherwise the
    /// line states plainly that Kokoro is off.
    @Published var voiceBundledStatus = ""
    /// v0.17.2: the bundled engine's loopback base URL, kept
    /// alongside its status so the speaker test below can ask
    /// the bundled engine itself (not the endpoint fields)
    /// when Built-in Kokoro is the picked engine.
    @Published var voiceBundledBaseUrl = ""
    private var voiceSeeded = false
    /// v0.17.5: the engine pair as last seeded from / saved to
    /// the panel — the baseline the Voice pane's save-on-select
    /// compares a picker change against, so the one-time seed
    /// itself never fires a save (and never marks enginesChosen
    /// for a form the operator hasn't touched).
    private var voiceEnginesSaved: (stt: String, tts: String)?

    // Devices & identity (v0.12.0 — pivot Phase 1 / iPhone
    // Step 1): the registry the panel keeps (GET /api/devices).
    // A panel too old for the registry leaves devicesWired
    // false and the pane says so.
    // v0.14.0: the identity itself (GET /api/identity, R1) rides
    // along — devices are credentials OF this identity now, and
    // the pane shows the identity above its devices. The
    // grant state that used to live here is deleted with
    // that enrollment flow itself (R1 removed its endpoints;
    // enrollment is by login identity, not by a scanned grant).
    @Published var devices: [PanelDevice] = []
    @Published var devicesWired = true
    @Published var identity: PanelIdentity?
    /// v0.14.5: the launch gate's readout (GET
    /// /api/identity/session) — the pane shows the session
    /// state and carries the sign-out beside the provider
    /// controls it belongs with.
    @Published var identitySession: PanelIdentitySession?
    /// The local-password drafts (username + a SecureField
    /// password, cleared on save like every key field here).
    @Published var identityUsername = ""
    @Published var identityPassword = ""

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
        client.get("/api/devices", as: [PanelDevice].self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let list):
                    self.devices = list
                    self.devicesWired = true
                case .failure:
                    // An older panel answers 501 with a refusal
                    // body, which fails this decode — the pane
                    // reads that as "no registry here".
                    self.devicesWired = false
                }
            }
        }
        client.get("/api/identity", as: PanelIdentity.self) { [weak self] result in
            DispatchQueue.main.async {
                // An unwired backend answers 501 with a refusal
                // body, which fails this decode — the pane then
                // simply has no identity to show.
                if case .success(let i) = result { self?.identity = i }
            }
        }
        client.get("/api/identity/session", as: PanelIdentitySession.self) { [weak self] result in
            DispatchQueue.main.async {
                if case .success(let s) = result { self?.identitySession = s }
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
                self.voiceEnginesSaved = (self.voiceSttEngine, self.voiceTtsEngine)
                self.voiceSttUrl = v.sttBaseUrl
                self.voiceSttModel = v.sttModel
                self.voiceTtsUrl = v.ttsBaseUrl
                self.voiceTtsModel = v.ttsModel
                self.voiceTtsVoice = v.ttsVoice
                self.voiceShieldScan = v.shieldScan ?? true
                self.voiceBundledStatus = v.bundled?.detail ?? ""
                self.voiceBundledBaseUrl = v.bundled?.baseUrl ?? ""
            }
        }
    }

    /// v0.17.2: re-read ONLY the bundled Kokoro status —
    /// the Voice pane calls this when it appears, so a
    /// download started by picking the engine (the save
    /// starts it) shows its progress instead of a stale
    /// line. Deliberately touches nothing else: the form
    /// may hold unsaved edits the seed must never clobber.
    func refreshVoiceSettings() {
        client.get("/api/voice/settings", as: PanelVoiceSettings.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, case .success(let v) = result else { return }
                self.voiceBundledStatus = v.bundled?.detail ?? ""
                self.voiceBundledBaseUrl = v.bundled?.baseUrl ?? ""
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

    // MARK: Protection home actions (v0.14.6) — one-tap flips
    // over the same endpoints the advanced panes use; each
    // posts and reloads, so the home always shows the state
    // on file, never a local guess.

    func setBudgetProfile(_ profile: String) {
        act("/api/budget-profile", body: ["profile": profile])
    }

    func setShieldRequired(_ on: Bool) {
        shieldRequired = on
        saveShieldPolicy()
    }

    func setVoiceEnabled(_ on: Bool) {
        // The drafts seed from voice.json on load; saving
        // before the seed lands would write defaults over the
        // operator's endpoints, so an unseeded flip waits.
        guard voiceSeeded else { return }
        voiceEnabled = on
        saveVoice()
    }

    func setLaunchGate(_ on: Bool) {
        act("/api/identity/launch-gate", body: ["enabled": on])
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

    // MARK: Devices & identity (v0.14.0)

    /// Revoke one device (operator-only on the panel). The
    /// record stays in the list, marked revoked; the device's
    /// credential stops working immediately.
    func revokeDevice(_ device: PanelDevice) {
        act("/api/devices/\(device.id)/revoke")
    }

    /// Set (or replace) the local password credential
    /// (POST /api/identity/password {username, password} — the
    /// panel stores only a scrypt digest). The field clears on
    /// save, like every secret field in this model; setting a
    /// password does not by itself switch the active provider
    /// (the panel's detail says so, and act surfaces it).
    func setIdentityPassword() {
        let username = identityUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        let password = identityPassword
        identityPassword = "" // the field never keeps a password after a save attempt
        act("/api/identity/password", body: ["username": username, "password": password])
    }

    /// Switch the identity's active provider
    /// (POST /api/identity/provider {kind}). Only "local" and
    /// "local-password" can be active in this build — the
    /// panel refuses the seam stubs and a password-less
    /// local-password plainly, and act surfaces its words.
    func setIdentityProvider(_ kind: String) {
        act("/api/identity/provider", body: ["kind": kind])
    }

    /// Sign out (POST /api/identity/logout, v0.14.5): the
    /// session file goes away and the login screen shows at
    /// the NEXT launch — this window stays open and usable,
    /// exactly as the panel's detail says. act() reloads, so
    /// the pane's session row reflects the sign-out at once.
    func signOutIdentity() {
        act("/api/identity/logout")
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
        voiceEnginesSaved = (voiceSttEngine, voiceTtsEngine)
    }

    /// v0.17.5: save-on-select for the engine pickers — the
    /// Voice pane calls this when either picker changes. An
    /// engine pick is a decision, not a draft: it goes through
    /// the same saveVoice() the Save button uses, so it lands
    /// on the next call (and picking Built-in Kokoro starts its
    /// model download at once) without the operator hunting
    /// for a Save button below the fold — the v0.17.2–0.17.4
    /// trap, where a pick that was never saved read as a broken
    /// engine. The seeded baseline keeps the initial settings
    /// read from firing a save of its own, and the bundled
    /// status is re-read so the pane's Kokoro line follows the
    /// pick (Downloading… / Ready / Unavailable).
    func saveVoiceOnEngineChange() {
        guard let saved = voiceEnginesSaved,
              saved.stt != voiceSttEngine || saved.tts != voiceTtsEngine else { return }
        saveVoice()
        refreshVoiceSettings()
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

    /// v0.11.0: the voices installed on this Mac, enumerated
    /// live — the same list DesktopModel offers in the
    /// Identity tab (one enumeration, two doors).
    static var installedSpeechVoices: [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// v0.11.1: the language filter's shared pieces — the
    /// languages on offer, the filtered + quality-sorted list
    /// (saved pick never stranded), and the row labels. The
    /// logic lives on DesktopModel; these delegate so the
    /// Voice pane and the Identity tab filter identically.
    static var speechVoiceLanguages: [String] { DesktopModel.speechVoiceLanguages }
    static func pickerVoices(forLanguage language: String, selectedId: String) -> [AVSpeechSynthesisVoice] {
        DesktopModel.pickerVoices(forLanguage: language, selectedId: selectedId)
    }

    /// v0.15.6: one voice in the Settings → Voice Kokoro picker.
    struct KokoroVoiceOption: Identifiable {
        let id: String
        let label: String
    }

    /// v0.15.6: the curated Kokoro catalog — the same eight
    /// voices, with the same labels, as the iPhone app's picker
    /// (iOS 0.15.4), so the Mac and the phone offer one list.
    /// The pick is voice.json's ttsVoice, which the endpoint
    /// synthesis request already carries — the picker is a new
    /// door onto the existing setting, not a new store.
    static let kokoroVoiceCatalog: [KokoroVoiceOption] = [
        KokoroVoiceOption(id: "af_heart", label: "Heart — female (default)"),
        KokoroVoiceOption(id: "af_bella", label: "Bella — female"),
        KokoroVoiceOption(id: "af_nicole", label: "Nicole — female"),
        KokoroVoiceOption(id: "am_michael", label: "Michael — male"),
        KokoroVoiceOption(id: "am_fenrir", label: "Fenrir — male"),
        KokoroVoiceOption(id: "am_puck", label: "Puck — male"),
        KokoroVoiceOption(id: "bf_emma", label: "Emma — British female"),
        KokoroVoiceOption(id: "bm_george", label: "George — British male"),
    ]

    /// The picker's options: the catalog, plus the value on
    /// file when it isn't one of the eight — a custom voice
    /// name typed into the old free-text field stays selectable
    /// (and stays the selection) instead of being silently
    /// replaced by the picker's first entry.
    static func kokoroVoiceOptions(current: String) -> [KokoroVoiceOption] {
        var options = kokoroVoiceCatalog
        let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, !options.contains(where: { $0.id == trimmed }) {
            options.append(KokoroVoiceOption(id: trimmed, label: "\(trimmed) (custom)"))
        }
        return options
    }
    static func speechVoiceLabel(_ voice: AVSpeechSynthesisVoice) -> String {
        DesktopModel.speechVoiceLabel(voice)
    }
    static func languageDisplayName(_ code: String) -> String {
        DesktopModel.languageDisplayName(code)
    }

    /// v0.11.0: the built-in voice the operator picked — the
    /// app-side UserDefaults choice (gus.localTtsVoiceId, the
    /// key DesktopModel.localTtsVoiceDefaultsKey names; ""
    /// means the Mac's default). Mirrors DesktopModel's
    /// resolution exactly: a pick that names a voice no longer
    /// installed falls back to the en-US default rather than
    /// failing. The call path reads the same key at speak time.
    static func localSpeechVoice() -> AVSpeechSynthesisVoice? {
        let id = UserDefaults.standard.string(forKey: "gus.localTtsVoiceId") ?? ""
        if !id.isEmpty, let chosen = AVSpeechSynthesisVoice(identifier: id) {
            return chosen
        }
        return AVSpeechSynthesisVoice(language: "en-US")
    }

    /// The Voice pane's Test voice button (v0.11.0): one
    /// sentence through the selected built-in voice, on the
    /// test synthesizer — the local engine's parity with the
    /// endpoint rows' Test Connection.
    func testLocalVoice() {
        let utterance = AVSpeechUtterance(string: "This is the built-in voice test. If you can hear me, this voice works.")
        utterance.voice = Self.localSpeechVoice()
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        voiceTestSynthesizer.speak(utterance)
        voiceTestSpeakerResult = "Playing the test sentence with the selected built-in voice — listen for it."
    }

    /// The speaker half: built-in speaks with the same
    /// synthesizer the call's built-in mouth uses; Endpoint
    /// asks the control plane to synthesize the sentence with
    /// the form's current (unsaved) values and plays the audio
    /// that comes back. v0.11.0: the built-in half speaks with
    /// the operator's selected built-in voice (localSpeechVoice
    /// above) — before, it hard-coded the en-US default, so the
    /// test could pass in a voice the call would never use…
    /// (and, the picker not existing, vice versa).
    private func runVoiceSpeakerTest() {
        if voiceTtsEngine == "local" {
            let utterance = AVSpeechUtterance(string: "This is the GUS speaker test. If you can hear me, your built-in speech works.")
            utterance.voice = Self.localSpeechVoice()
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate
            voiceTestSynthesizer.speak(utterance)
            voiceTestSpeakerResult = "Playing the test sentence with the built-in voice — listen for it."
            return
        }
        // v0.17.2: with Built-in Kokoro picked, the test asks
        // the bundled engine (its loopback URL + the one model
        // it serves), not the endpoint fields — testing the
        // endpoint while Kokoro is picked would pass or fail
        // the wrong engine.
        let bundled = voiceTtsEngine == "bundled"
        if bundled && voiceBundledBaseUrl.isEmpty {
            voiceTestSpeakerResult = "Built-in Kokoro isn't reporting yet — its status line above has the latest; the test can run once it's ready."
            return
        }
        voiceTestSpeakerResult = bundled
            ? "Asking built-in Kokoro for the test sentence…"
            : "Asking the speech endpoint for the test sentence…"
        client.testVoiceSpeech(
            baseUrl: bundled ? voiceBundledBaseUrl : voiceTtsUrl.trimmingCharacters(in: .whitespacesAndNewlines),
            model: bundled ? "kokoro" : voiceTtsModel.trimmingCharacters(in: .whitespacesAndNewlines),
            voice: voiceTtsVoice.trimmingCharacters(in: .whitespacesAndNewlines)
        ) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let r):
                    if r.ok, let b64 = r.audioBase64, let data = Data(base64Encoded: b64) {
                        self.voiceTestPlayer = try? AVAudioPlayer(data: data)
                        self.voiceTestPlayer?.play()
                        self.voiceTestSpeakerResult = bundled
                            ? "Playing the test sentence from built-in Kokoro — listen for it."
                            : "Playing the test sentence from the endpoint — listen for it."
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

/// The Settings section (v0.14.0 — through v0.13.0 this was a
/// window of its own): a section sidebar (Muse-settings shape)
/// + the selected pane, with the last action's outcome pinned
/// under the pane — the panel's own words, so a refusal is
/// never silent. The model and the pane selection come from
/// RootView now: the model is constructed with the app (cheap —
/// its load() fires from onAppear below, NOT at launch, which
/// is part of the v0.14.0 shell-performance work), and the
/// selection is a binding so a deep link can preselect a pane.
struct SettingsRootView: View {
    @ObservedObject var model: SettingsModel
    @Binding var section: SettingsSection?

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
                        switch section ?? .protection {
                        case .protection: ProtectionSettingsView(model: model)
                        case .general: SettingsGeneralView(model: model)
                        case .provider: SettingsProviderView(model: model)
                        case .shield: SettingsShieldView(model: model)
                        case .caps: SettingsCapsView(model: model)
                        case .governor: SettingsGovernorView(model: model)
                        case .telegram: SettingsTelegramView(model: model)
                        case .voice: SettingsVoiceView(model: model)
                        case .devices: SettingsDevicesView(model: model)
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
        // v0.14.0: no min frame of its own — as a section it
        // fills the main window's content column instead.
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
