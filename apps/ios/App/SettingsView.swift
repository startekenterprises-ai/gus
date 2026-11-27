import ShieldKit
import SwiftUI

/// Settings: the core connection (transport — the address +
/// the Keychain-held token), the voice engine choice, and
/// sign-out. Deliberately small in the scaffold: everything
/// here is something the login flow or the call actually reads.
struct SettingsView: View {
    @ObservedObject var model: SessionModel
    @ObservedObject private var library = ModelLibrary.shared
    @ObservedObject private var customBrains = CustomBrainStore.shared
    @ObservedObject private var kokoro = KokoroRuntime.shared
    /// The voice audition's state (v0.33.0) — observed so
    /// a failed preview's words land under the voice list.
    @ObservedObject private var preview = VoicePreviewPlayer.shared
    @State private var coreAddress = GUSSettings.baseURLString
    @State private var coreToken = GUSSettings.token
    @State private var engineKind: SpeechEngineKind = .preferred
    @State private var kokoroVoice: KokoroVoice = KokoroVoice.selected
    @State private var callMode: CallMode = CallMode.preferred
    @State private var demoPitch: Bool = LocalBrain.demoPitchEnabled
    /// v0.36.0: start-in-a-voice-call launch preference
    /// (StartInCall) — read once per cold launch by
    /// RootView; written here.
    @State private var startInCall: Bool = StartInCall.enabled
    @State private var personaText: String = LocalBrain.customPrompt ?? ""
    @State private var stockAvatar: String = UserDefaults.standard.string(forKey: "gus.avatar.stock") ?? "boy"
    @State private var shieldEnabled: Bool = ShieldSettings.enabled
    @State private var shieldPosture: ShieldPosture = ShieldSettings.posture
    @State private var savedNote = false
    /// v0.34.0: the delete-history confirm, and the line
    /// that says it landed.
    @State private var confirmDeleteHistory = false
    @State private var historyDeleted = false

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
                    Text("On, the on-device brain introduces itself with the email pitch — the Gmail demo. Off, it's a general-purpose assistant. Takes effect with your next message or call — the brain reloads in this same app run (v0.31.0).")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    // v0.36.0: start in a voice call — the
                    // launch preference RootView reads once
                    // per cold launch (StartInCall). Plain
                    // copy, one promise: opening the app
                    // fresh starts a call; coming back to an
                    // already-open app never does.
                    Toggle("Start in a voice call", isOn: $startInCall)
                        .onChange(of: startInCall) { newValue in
                            StartInCall.enabled = newValue
                        }
                    Text("On, opening GUS fresh starts a voice call right away, so GUS can say hello first. Coming back to the app later never re-starts a call.")
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
                // Glenn's: Gus first, the Devil last (the
                // roster consolidated to six in v0.32.0).
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
                    Text("Tap a starter to fill the prompt, then make the words your own — nothing here is locked or hidden. Empty means the general assistant. A change lands with your next message or call — the brain reloads in this same app run (v0.31.0); while the Gmail demo pitch above is on, it wins. To switch persona, voice, and face together in one tap, use the Personas tab or tap the avatar in Chat.")
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
                    // v0.23.0: the simple level shows three
                    // curated voices — Heart, Emma (British),
                    // and Michael (male) — with the full set
                    // of eight under the disclosure below,
                    // both levels bound to the same saved
                    // pick (gus.voice.kokoroVoice, untouched
                    // by the restructure: a pick made from
                    // the full list rides along in the simple
                    // level rather than being reset).
                    // v0.33.0: the pickers became rows, so
                    // every voice carries its audition button
                    // (VoiceChoiceRow) — hear a few words in
                    // a voice before picking it, instead of
                    // learning how it sounds mid-call. Tapping
                    // a row is the pick, exactly as the
                    // pickers' selection was.
                    ForEach(KokoroVoice.simpleOptions(current: kokoroVoice)) { voice in
                        VoiceChoiceRow(
                            voice: voice,
                            selected: kokoroVoice == voice,
                            previewLine: voicePreviewLine(voice)
                        ) {
                            kokoroVoice = voice
                            KokoroVoice.selected = voice
                        }
                    }
                    DisclosureGroup("All voices") {
                        ForEach(KokoroVoice.all) { voice in
                            VoiceChoiceRow(
                                voice: voice,
                                selected: kokoroVoice == voice,
                                previewLine: voicePreviewLine(voice)
                            ) {
                                kokoroVoice = voice
                                KokoroVoice.selected = voice
                            }
                        }
                    }
                    if let error = preview.lastError {
                        Text(error)
                            .font(.caption)
                            .foregroundColor(.orange)
                    }
                } header: {
                    Text("Call voice")
                } footer: {
                    Text("Kokoro is GUS's voice — it runs on this iPhone and prepares itself automatically when the app opens. There is no setup tap and no fallback voice behind it. Three voices sit up front; the full set is under All voices. The play button beside a voice speaks a few words in it, so you can choose by ear — a first listen may take a moment while that voice is fetched. Each persona can also carry its own voice (Personas tab). Studio Voice is a future cloud opt-in — off until you configure it.")
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
                    ForEach(customBrains.entries, id: \.id) { entry in
                        BrainRowView(entry: entry)
                    }
                    NavigationLink("Find a brain (advanced)") {
                        BrainSearchView()
                    }
                    kokoroRow
                } header: {
                    Text("On-device models")
                } footer: {
                    Text("Brains are downloaded once, verified against the model manifest before use, and stored on this iPhone. You can keep more than one and switch freely — switching never deletes anything, and the switch takes effect right away: the new brain loads in this same app run with your next message or call (v0.31.0), no restart needed. The brain marked Active is the one that loads. Nothing about a call leaves the phone in on-device mode. Deleting every brain turns on-device calls off (Core mode still works) and brings the setup prompt back at the next launch. Brains marked Custom came from Find a brain (v0.38.0): they come straight from Hugging Face, are size-checked — and checksum-checked when the repo publishes one — before use, and aren't vetted by GUS.")
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
                // the app. v0.35.0: the section is its own
                // view (AboutSection, below) because Chat's
                // hamburger menu opens the very same About —
                // one About, two doors (the v0.30.0 same-view
                // pattern).
                AboutSection()

                // v0.34.0: Privacy — the delete that is
                // actually a delete. It tombstones every
                // message in the phone's store (the store
                // is shared with Chat, so the conversation
                // empties there in the same beat) and the
                // tombstones sync to the core, where the
                // same content leaves the Mac's transcript.
                // The confirm copy says all of that,
                // including what is NOT deleted: the Shield
                // receipts — verdicts and hashes, never
                // content — are the audit trail, and they
                // stay.
                Section {
                    Button(role: .destructive) {
                        confirmDeleteHistory = true
                    } label: {
                        Text("Delete chat history")
                    }
                    if historyDeleted {
                        Text("Deleted — the conversation is empty, here and (on the next sync) on your Mac.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                } header: {
                    Text("Privacy")
                } footer: {
                    Text("Deletes every chat message on this iPhone and, on the next sync, on your Mac too — removed, not just hidden. Shield security receipts are not chat content and are kept: they hold verdicts and hashes, never your words, and they are your audit trail. For a single conversation that leaves nothing behind at all, use Incognito in Chat.")
                }
                .confirmationDialog(
                    "Delete all chat history?",
                    isPresented: $confirmDeleteHistory
                ) {
                    Button("Delete everything", role: .destructive) {
                        ChatHistoryStore.shared.deleteAllLocal()
                        historyDeleted = true
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Every chat message on this iPhone is deleted now, and the deletion reaches your Mac on the next sync — the messages are removed there too, not just hidden. Shield security receipts are not chat content and are kept: they're your audit trail. This cannot be undone.")
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
            .onAppear {
                // v0.30.0: the persona picker (the avatar
                // tap, the Personas tab) writes the same key
                // this editor holds — re-read it on appear so
                // a pick made there is the text shown here.
                // The editor writes every keystroke through
                // to the key, so this can only ever catch the
                // field up, never clobber an edit.
                personaText = LocalBrain.customPrompt ?? ""
                // v0.31.0: the same coherence for the voice —
                // a persona pick sets the persona's voice
                // (gus.voice.kokoroVoice), and this picker's
                // state was loaded when the view was built.
                kokoroVoice = KokoroVoice.selected
                // v0.35.0: the same coherence for Shield —
                // the Shield hub's toggles write the same
                // persisted settings this section holds, so
                // re-read them on appear too.
                shieldEnabled = ShieldSettings.enabled
                shieldPosture = ShieldSettings.posture
            }
        }
    }

    /// The line a Settings voice preview speaks (v0.33.0):
    /// the voice introduces ITSELF — hearing "I'm Michael"
    /// in Michael's voice is the whole audition.
    private func voicePreviewLine(_ voice: KokoroVoice) -> String {
        "Hi, I'm \(voice.shortName) — this is how I sound. Ask me anything."
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

/// About (v0.22.0), as its own section so two doors show the
/// very same view: Settings' form above, and Chat's
/// hamburger menu (v0.35.0). Three plain rows — the app
/// version and build from the bundle, and the brain a call
/// would load. The voice path's own record rides here too
/// (VoiceFailureLog): when a call goes silent, these lines —
/// the path, the route, and any failure with its error —
/// are what a report can quote.
struct AboutSection: View {
    @State private var voiceLogLines: [String] = []

    var body: some View {
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
        .onAppear {
            voiceLogLines = VoiceFailureLog.shared.recentLines
        }
    }
}
