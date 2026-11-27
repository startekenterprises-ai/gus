import ShieldKit
import SwiftUI

/// Settings: the core connection (transport — the address +
/// the Keychain-held token), the voice engine choice, and
/// sign-out. Deliberately small in the scaffold: everything
/// here is something the login flow or the call actually reads.
struct SettingsView: View {
    @ObservedObject var model: SessionModel
    @ObservedObject private var library = ModelLibrary.shared
    @ObservedObject private var kokoro = KokoroRuntime.shared
    @State private var coreAddress = GUSSettings.baseURLString
    @State private var coreToken = GUSSettings.token
    @State private var engineKind: SpeechEngineKind = .preferred
    @State private var kokoroVoice: KokoroVoice = KokoroVoice.selected
    @State private var callMode: CallMode = CallMode.preferred
    @State private var demoPitch: Bool = LocalBrain.demoPitchEnabled
    @State private var personaText: String = LocalBrain.customPrompt ?? ""
    @State private var voiceLogLines: [String] = []
    @State private var stockAvatar: String = UserDefaults.standard.string(forKey: "gus.avatar.stock") ?? "boy"
    @State private var shieldEnabled: Bool = ShieldSettings.enabled
    @State private var shieldPosture: ShieldPosture = ShieldSettings.posture
    @State private var savedNote = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Core address", text: $coreAddress)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    SecureField("Panel token", text: $coreToken)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Button("Save connection") {
                        GUSSettings.baseURLString = coreAddress
                        GUSSettings.token = coreToken
                        savedNote = true
                        Task { await model.refresh() }
                    }
                    if savedNote {
                        Text("Saved. The token lives in this iPhone's Keychain — never in defaults, source, or logs.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                } header: {
                    Text("Your GUS core")
                } footer: {
                    Text("The Mac's Tailscale address is the reliable route (e.g. https://your-mac.<tailnet>:8731); the token is ~/.gus/state/panel-token on the Mac. Never expose the panel to the open internet.")
                }

                Section {
                    Picker("Call brain", selection: $callMode) {
                        ForEach(CallMode.allCases) { mode in
                            Text(mode.displayName).tag(mode)
                        }
                    }
                    .onChange(of: callMode) { newValue in
                        CallMode.preferred = newValue
                    }
                    // v0.20.0: the Gmail demo's pitch is a
                    // mode now, not the brain's only prompt —
                    // the general-purpose prompt is the default
                    // (LocalBrain.activePrompt). The brain
                    // reads the choice when it loads, and the
                    // call and chat each load it once per app
                    // run, so the footer says when it lands.
                    Toggle("Gmail demo pitch", isOn: $demoPitch)
                        .onChange(of: demoPitch) { newValue in
                            LocalBrain.demoPitchEnabled = newValue
                        }
                    Text("On, the on-device brain introduces itself with the email pitch — the Gmail demo. Off, it's a general-purpose assistant. Takes effect the next time the app starts.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } header: {
                    Text("Call mode")
                } footer: {
                    Text("On-device is the default: the call's brain and voice run on this iPhone and work with no network at all. Core mode hands the call to your GUS core — the workshop, with tools and the big model — exactly as before.")
                }

                // v0.22.0: persona starters — beginnings, not
                // locks. A starter fills the prompt field; the
                // field stays editable and whatever it holds is
                // what the brain loads with (LocalBrain's
                // customPrompt, read at brain load like the
                // demo-pitch choice). The shelf's order is
                // Glenn's: security personas first.
                Section {
                    ForEach(LocalBrain.personaStarters) { starter in
                        Button {
                            personaText = starter.prompt
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(starter.name)
                                    .foregroundColor(.primary)
                                Text(starter.blurb)
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                    TextEditor(text: $personaText)
                        .frame(minHeight: 110)
                        .onChange(of: personaText) { newValue in
                            LocalBrain.customPrompt = newValue
                        }
                    if !personaText.isEmpty {
                        Button("Use the general assistant instead") {
                            personaText = ""
                        }
                    }
                } header: {
                    Text("Persona starters")
                } footer: {
                    Text("Tap a starter to fill the prompt, then make the words your own — nothing here is locked or hidden. Empty means the general assistant. The brain reads the prompt when the app starts, so a change lands on the next launch; while the Gmail demo pitch above is on, it wins.")
                }

                Section {
                    Picker("Voice", selection: $engineKind) {
                        ForEach(SpeechEngineKind.allCases) { kind in
                            Text(kind.displayName).tag(kind)
                        }
                    }
                    .onChange(of: engineKind) { newValue in
                        SpeechEngineKind.preferred = newValue
                    }
                    Picker("Kokoro voice", selection: $kokoroVoice) {
                        ForEach(KokoroVoice.all) { voice in
                            Text(voice.displayName).tag(voice)
                        }
                    }
                    .onChange(of: kokoroVoice) { newValue in
                        KokoroVoice.selected = newValue
                    }
                } header: {
                    Text("Call voice")
                } footer: {
                    Text("Kokoro is GUS's voice — it runs on this iPhone and prepares itself automatically when the app opens. There is no setup tap and no fallback voice behind it. Studio Voice is a future cloud opt-in — off until you configure it.")
                }

                // v0.20.0: the stock avatar pair — the face
                // on the call screen. The pick is the same
                // UserDefaults key the Mac's Identity tab
                // writes (gus.avatar.stock), so the pair reads
                // the same on both; the boy is the default.
                Section {
                    Picker("Stock avatar", selection: $stockAvatar) {
                        Text("Boy").tag("boy")
                        Text("Girl").tag("girl")
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: stockAvatar) { newValue in
                        UserDefaults.standard.set(newValue, forKey: "gus.avatar.stock")
                    }
                } header: {
                    Text("Avatar")
                } footer: {
                    Text("The face on the call screen — the bundled pair. The Mac keeps the same choice over the same key.")
                }

                Section {
                    ForEach(GUSModelManifest.downloads, id: \.id) { entry in
                        BrainRowView(entry: entry)
                    }
                    kokoroRow
                } header: {
                    Text("On-device models")
                } footer: {
                    Text("Brains are downloaded once, verified against the model manifest before use, and stored on this iPhone. You can keep more than one and switch freely — switching never deletes anything, and the switch takes effect the next time the app starts. Nothing about a call leaves the phone in on-device mode. Deleting every brain turns on-device calls off (Core mode still works) and brings the setup prompt back at the next launch.")
                }

                Section {
                    Toggle("Agent Shield", isOn: $shieldEnabled)
                        .onChange(of: shieldEnabled) { newValue in
                            ShieldSettings.enabled = newValue
                        }
                    if shieldEnabled {
                        Picker("Posture", selection: $shieldPosture) {
                            ForEach(ShieldPosture.allCases) { posture in
                                Text(posture.displayName).tag(posture)
                            }
                        }
                        .pickerStyle(.segmented)
                        .onChange(of: shieldPosture) { newValue in
                            ShieldSettings.posture = newValue
                        }
                        NavigationLink("Shield log") {
                            ShieldLogView()
                        }
                        HStack {
                            Text("Bundled rules")
                            Spacer()
                            Text(ShieldScanner.rulesVersion)
                                .foregroundColor(.secondary)
                        }
                    }
                } header: {
                    Text("Security")
                } footer: {
                    Text(shieldEnabled
                         ? "Shield scans on-device calls both ways — your words before the brain hears them, replies before the voice speaks them — and writes a signed receipt for every scan on this iPhone. Permissive only watches: everything is logged, nothing is stopped. Standard stops known injections and holds suspicious turns for your OK. Strict stops anything suspicious — and anything Shield can't evaluate. Rules are bundled with the app (\(ShieldScanner.rulesVersion)); they update with the app."
                         : "Shield is off: on-device calls are not scanned and no receipts are written.")
                }

                // v0.22.0: About — "which version is this
                // phone running?" had no answer anywhere in
                // the app. Three plain rows: the app version
                // and build from the bundle, and the brain a
                // call would load. The voice path's own record
                // rides here too (VoiceFailureLog): when a
                // call goes silent, these lines — the path,
                // the route, and any failure with its error —
                // are what a report can quote.
                Section {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?")
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Text("Build")
                        Spacer()
                        Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?")
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Text("Brain")
                        Spacer()
                        Text(ActiveBrain.resolved()?.plainName ?? "None downloaded")
                            .foregroundColor(.secondary)
                    }
                    if !voiceLogLines.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Voice playback — the last things it did")
                                .font(.caption)
                                .foregroundColor(.secondary)
                            ForEach(Array(voiceLogLines.suffix(6).enumerated()), id: \.offset) { _, line in
                                Text(line)
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                } header: {
                    Text("About")
                } footer: {
                    Text("The voice lines are the call path's own record — formats, route, and any playback failure with its error — kept so a silent call can say why.")
                }

                Section {
                    Button(role: .destructive) {
                        Task { await model.signOut() }
                    } label: {
                        Text("Sign out")
                    }
                } footer: {
                    Text("Signs this install out of the GUS identity (the core ends its session). The connection above stays, so signing back in is one step.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { voiceLogLines = VoiceFailureLog.shared.recentLines }
        }
    }

    /// The voice row: Kokoro's assets are fetched and verified
    /// by the speech engine itself (its own pinned manifest);
    /// this row drives and reports the warm-up honestly.
    private var kokoroRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Voice — Kokoro (on-device)")
                .font(.callout)
            Text("Prepares itself automatically — its speech models (~294 MB) download once, and the engine verifies them before it will speak.")
                .font(.caption)
                .foregroundColor(.secondary)
            switch kokoro.state {
            case .idle:
                ProgressView() { Text("Getting ready…").font(.caption) }
            case .warming:
                ProgressView() { Text("Preparing (download + load)…").font(.caption) }
            case .ready:
                Text("Ready — Kokoro speaks on this iPhone.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            case .failed(let message):
                Text(message)
                    .font(.caption)
                    .foregroundColor(.orange)
                Button("Try again") { kokoro.warmUp() }
            }
        }
        .padding(.vertical, 2)
        .onAppear {
            // This row never offers a "prepare" tap (Glenn,
            // 2026-11-20): if warm-up somehow hasn't started by
            // the time anyone looks at the row, it starts
            // itself. The row only reports.
            if kokoro.state == .idle { kokoro.warmUp() }
        }
    }
}
