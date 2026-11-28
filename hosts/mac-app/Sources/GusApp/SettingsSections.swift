import ApplicationServices
import AVFoundation
import ServiceManagement
import SwiftUI

/// The Settings section's panes (v0.8; a window of their own
/// through v0.13.0, a section of the main window since
/// v0.14.0). Every control posts the
/// panel endpoint the web surface uses for the same setting —
/// see SettingsModel. Read-only where the panel has no write API
/// (Mac work dirs, delegates), and the pane says so in words.

struct SettingsGeneralView: View {
    @ObservedObject var model: SettingsModel
    /// The live-status strip's visibility (the key predates the
    /// strip — it bound the in-chat log through v0.11.1, and the
    /// setting carries over so nobody's choice resets): the
    /// SAME UserDefaults switch the chat strip and the Jobs
    /// log header bind, so the controls can never disagree.
    @AppStorage("gus.secureLogVisible") private var secureLogVisible = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsPaneTitle(text: "General")
            HStack(spacing: 6) {
                Toggle("Show the live status line in Chat", isOn: $secureLogVisible)
                HelpMark(entry: model.help("secure-log"))
            }
            Text("One slim line above the composer carrying the newest entry of the secure log — the full log, with its filters and search, lives in the Jobs section. On by default: the record is the product. Hiding the line stops nothing; the recording continues underneath.")
                .font(.caption)
                .foregroundColor(.secondary)
            Divider()
            if let s = model.status {
                SettingsRow(title: "GUS version", value: s.version)
                SettingsRow(title: "App version",
                            value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?")
                SettingsRow(title: "Status",
                            value: s.killed ? "Kill switch ON — stopped" : "Running")
                SettingsRow(title: "Governor mode", value: s.governorMode.capitalized,
                            help: model.help("governor-mode"))
                SettingsRow(title: "Spend today", value: GusFormat.usd(s.spendTodayUsd))
                SettingsRow(title: "Spend this month", value: GusFormat.usd(s.spendMonthUsd))
                SettingsRow(title: "Approvals waiting", value: "\(s.pendingApprovals)")
            } else {
                Text("The control plane isn't reachable — settings appear when the panel answers.")
                    .foregroundColor(.secondary)
            }
            Divider()
            HStack {
                Button("Check for Updates…") {
                    NotificationCenter.default.post(name: .gusCheckForUpdates, object: nil)
                }
                Button("Run first-run setup…") {
                    NotificationCenter.default.post(name: .gusRunSetup, object: nil)
                }
                Button("Open web panel") { model.openPanelPage("/") }
                Spacer()
                Button("Reload") { model.load() }
            }
            Text("Updates download from GitHub Releases, verify their checksum, and swap the app in place — the same one-click path as the menu bar. State (vault, policy, jobs, receipts) is never touched by an update.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }
}

struct SettingsProviderView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsPaneTitle(text: "Provider & model")
            if let s = model.status {
                SettingsRow(title: "On file", value: "\(s.provider.id) · \(s.provider.model)")
                SettingsRow(title: "API key", value: keyStateText(s.settings.providerKey))
            }
            HStack(spacing: 6) {
                Text("Provider")
                    .fontWeight(.medium)
                HelpMark(entry: model.help("provider"))
                Spacer()
                Picker("", selection: $model.providerId) {
                    ForEach(SetupFlowView.providers, id: \.self) { p in Text(p).tag(p) }
                }
                .frame(maxWidth: 220)
                .onChange(of: model.providerId) { _, newValue in
                    if let suggested = SetupFlowView.suggestedModels[newValue] {
                        model.modelName = suggested
                    }
                }
            }
            HStack(spacing: 6) {
                Text("Model")
                    .fontWeight(.medium)
                HelpMark(entry: model.help("model"))
                Spacer()
                TextField("Model", text: $model.modelName)
                    .frame(maxWidth: 260)
            }
            HStack {
                Text("API key")
                    .fontWeight(.medium)
                Spacer()
                SecureField("Paste a key to store or replace it", text: $model.apiKey)
                    .frame(maxWidth: 340)
            }
            HStack {
                Text("Base URL")
                    .fontWeight(.medium)
                Spacer()
                TextField("Optional — OpenAI-compatible endpoints", text: $model.baseUrl)
                    .frame(maxWidth: 340)
            }
            if model.providerId == "gemini" {
                Text("One honest catch: on Google's free tier, Google may use what you send to improve its models — a paid Gemini key removes that. Gemini's endpoint is pinned by the provider; a base URL doesn't move it.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            if model.providerId == "ollama" {
                Text("Ollama runs on your own machine and costs $0 — no key needed.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            HStack {
                Spacer()
                Button("Save provider") { model.saveProvider() }
            }
            Text("Saving goes through the setup step the web wizard uses: the key lands in the encrypted vault under the provider's name and is never shown again, here or anywhere. Leave the key field empty to keep the key already on file.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private func keyStateText(_ state: String) -> String {
        switch state {
        case "stored": return "Stored in the vault"
        case "missing": return "Missing — paste one below"
        default: return "Not required for this provider"
        }
    }
}

struct SettingsShieldView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsPaneTitle(text: "Agent-Shield gate")
            if let s = model.status {
                SettingsRow(title: "Key", value: s.shield.provisioned ? "Provisioned (in the vault)" : "Not provisioned")
                SettingsRow(title: "Endpoint", value: s.shield.baseUrl.isEmpty ? "—" : s.shield.baseUrl)
                Text("The endpoint is launch configuration (GUS_SHIELD_BASE_URL) — shown for the record; it isn't edited here.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Divider()
                Toggle("Gate required — scan before the model sees anything", isOn: $model.shieldRequired)
                Picker("If the Shield is unreachable:", selection: $model.shieldFailMode) {
                    Text("Fail closed — block").tag("closed")
                    Text("Fail open — proceed, flagged, no receipt").tag("open")
                }
                .frame(maxWidth: 380)
                HStack {
                    Spacer()
                    Button("Save gate policy") { model.saveShieldPolicy() }
                }
                if !s.shield.provisioned {
                    Divider()
                    Text("No Shield key yet. Provisioning is free and zero-form: the key is created and stored straight into the vault, and the gate is recorded as required.")
                        .font(.callout)
                        .foregroundColor(.secondary)
                    HStack {
                        Spacer()
                        Button("Provision a free key") { model.provisionShield() }
                    }
                }
            } else {
                Text("The control plane isn't reachable.")
                    .foregroundColor(.secondary)
            }
        }
    }
}

struct SettingsCapsView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsPaneTitle(text: "Spend caps")
            Text("Hard dollar ceilings enforced by the Governor, outside the model. Only you can change them.")
                .font(.callout)
                .foregroundColor(.secondary)
            capRow("Per task", $model.capTask, help: model.help("cap-per-task"))
            capRow("Per day", $model.capDay, help: model.help("cap-per-day"))
            capRow("Per month", $model.capMonth, help: model.help("cap-per-month"))
            if let s = model.status {
                SettingsRow(title: "Spent today", value: GusFormat.usd(s.spendTodayUsd))
                SettingsRow(title: "Spent this month", value: GusFormat.usd(s.spendMonthUsd))
            }
            HStack {
                Spacer()
                Button("Save caps") { model.saveCaps() }
            }
        }
    }

    private func capRow(_ title: String, _ value: Binding<String>, help: PanelHelpEntry?) -> some View {
        HStack(spacing: 6) {
            Text(title)
                .fontWeight(.medium)
            HelpMark(entry: help)
            Spacer()
            Text("$")
                .foregroundColor(.secondary)
            TextField("", text: value)
                .frame(width: 90)
        }
    }
}

struct SettingsGovernorView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsPaneTitle(text: "Governor & delegation")
            HStack(spacing: 6) {
                Text("Governor mode")
                    .font(.headline)
                HelpMark(entry: model.help("governor-mode"))
            }
            if let s = model.status {
                HStack {
                    Button("Enforcing") { model.setMode("enforcing") }
                        .disabled(s.governorMode == "enforcing")
                    Button("Permissive") { model.setMode("permissive") }
                        .disabled(s.governorMode == "permissive")
                    Text("Now: \(s.governorMode)")
                        .foregroundColor(.secondary)
                }
                if s.governorMode == "permissive" && s.permissiveToday.count > 0 {
                    Text("Permissive let \(s.permissiveToday.count) action(s) through today — each one recorded in the panel's let-through report.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            Divider()
            HStack(spacing: 6) {
                Text("Approval delegation")
                    .font(.headline)
                HelpMark(entry: model.help("approval-delegation"))
            }
            Text("Applies only while the Governor is Permissive — in Enforcing, approvals stay with you and this whole section is inert. The floors are never delegable: vault reads, deletes, installs, sends and posts, git push, sudo/kill-class shell, keychain access.")
                .font(.callout)
                .foregroundColor(.secondary)
            Group {
                Toggle("GUS approves delegates' jobs", isOn: $model.delGusDelegates)
                Toggle("GUS approves its own jobs", isOn: $model.delGusOwn)
                Toggle("Delegates may approve (jobs they did not submit)", isOn: $model.delDelegates)
                HStack {
                    Text("Scope")
                    Spacer()
                    Picker("", selection: $model.delScope) {
                        Text("Bounded").tag("bounded")
                        Text("Everything except the floors").tag("all_except_floors")
                    }
                    .frame(maxWidth: 260)
                }
                HStack {
                    Text("Max agent approvals per hour")
                    Spacer()
                    TextField("", text: $model.delMax)
                        .frame(width: 70)
                }
            }
            .disabled(model.status?.governorMode != "permissive")
            // Per-control help for the delegation group, as a
            // compact legend of registry marks — the same tips the
            // web panel's pop-ups show, one click each.
            HStack(spacing: 14) {
                HelpMark(entry: model.help("del-gus-delegates"))
                Text("delegates' jobs").font(.caption).foregroundColor(.secondary)
                HelpMark(entry: model.help("del-gus-own"))
                Text("own jobs").font(.caption).foregroundColor(.secondary)
                HelpMark(entry: model.help("del-delegates"))
                Text("delegates approve").font(.caption).foregroundColor(.secondary)
                HelpMark(entry: model.help("del-scope"))
                Text("scope").font(.caption).foregroundColor(.secondary)
                HelpMark(entry: model.help("del-max-approvals"))
                Text("hourly limit").font(.caption).foregroundColor(.secondary)
            }
            HStack {
                Spacer()
                Button("Save delegation policy") { model.saveDelegation() }
                    .disabled(model.status?.governorMode != "permissive")
            }
        }
    }
}

struct SettingsTelegramView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsPaneTitle(text: "Telegram")
            if let s = model.status {
                SettingsRow(title: "Bot token",
                            value: s.settings.telegramConfigured ? "Stored in the vault" : "Not configured")
            }
            if let detail = model.onboarding?.steps.telegram.detail {
                Text(detail)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Text("Pairing: create a bot with @BotFather in Telegram, paste its token below, and the channel connects on the next GUS start (or immediately if it's already running with this token). Then message your bot — approvals arrive there as buttons, and jobs can be handed to GUS from your phone.")
                .font(.callout)
                .foregroundColor(.secondary)
            HStack {
                SecureField("Bot token (123456789:AA…)", text: $model.tgToken)
                    .frame(maxWidth: 360)
                Button("Store token") {
                    model.saveTelegram()
                }
                .disabled(model.tgToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Text("The token goes straight into the vault — never paste it into a chat (Telegram is not end-to-end encrypted), and it is never shown again.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }
}

/// Voice (v0.9) — Call GUS. The channel's whole configuration:
/// an on/off switch and the operator's own local speech services
/// (OpenAI-compatible endpoints — faster-whisper for ears, Kokoro
/// for the mouth by default). Saving posts /api/voice/settings;
/// the call service re-reads the file per call, so a save is live
/// on the next call with no restart. No secrets live here: the
/// reference services are unauthenticated on the local machine.
/// v0.9.6: each half also picks its engine — Built-in (speech in
/// the app itself; the default, and the only choice that needs
/// nothing running anywhere else) or Endpoint (the fields below).
/// v0.20.0: reorganized into the iPhone's shape — one simple
/// front door (the Enable switch, the two engine pickers, and
/// the picked engine's voice picker, every one of them saving
/// on the spot) with the plumbing (endpoint fields, tests,
/// behavior switches, the form's Save button) under an
/// Advanced disclosure. No capability moved out of reach, and
/// the Identity tab's duplicate voice pickers came home to
/// this pane in the same pass.
struct SettingsVoiceView: View {
    @ObservedObject var model: SettingsModel
    /// v0.11.0: the built-in voice choice — the same
    /// UserDefaults key DesktopModel speaks from
    /// (gus.localTtsVoiceId). v0.20.0: this pane's picker is
    /// the only door onto it (the Identity tab's duplicate
    /// picker came home here).
    @AppStorage("gus.localTtsVoiceId") private var localTtsVoiceId = ""
    /// v0.11.1: the voice list's language filter
    /// (gus.localTtsVoiceLanguage), remembered across visits.
    @AppStorage("gus.localTtsVoiceLanguage") private var localVoiceLanguage = "en"

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsPaneTitle(text: "Voice")
            if let s = model.status {
                SettingsRow(title: "Voice channel",
                            value: s.settings.voice.enabled
                                ? (s.settings.voice.configured ? "On — configured" : "On — an endpoint is missing")
                                : "Off",
                            help: model.help("voice-call"))
            }
            Text("Talk to GUS from the chat window's Call button — a live call, not a recording. This pane is the one front door for voice, shaped like the iPhone's Settings: pick an engine and a voice and the pick saves itself. The endpoint fields, the tests, and the call-behavior switches live under Advanced at the bottom.")
                .font(.callout)
                .foregroundColor(.secondary)
            // v0.20.0: the switch saves on flip — the same
            // write the Protection home's Voice calls toggle
            // makes (SettingsModel.setVoiceEnabled), so the
            // doors can never disagree about whether voice
            // is on. Through v0.19.0 the pane's switch was a
            // draft under the Save button while the home's
            // flip saved at once — one setting, two save
            // behaviors, part of the muddle Glenn named.
            Toggle("Enable voice calls", isOn: Binding(
                get: { model.voiceEnabled },
                set: { model.setVoiceEnabled($0) }
            ))
            Divider()
            Text("Transcription — the ears")
                .font(.headline)
            Picker("Transcription (STT)", selection: $model.voiceSttEngine) {
                Text("Built-in").tag("local")
                Text("Endpoint").tag("endpoint")
            }
            .pickerStyle(.segmented)
            // v0.17.5: engine picks save on select (the model's
            // saveVoiceOnEngineChange — same write path as the
            // Save button below). A pick is live on the next
            // call the moment it's made; there is no unsaved
            // engine state to test against by mistake.
            .onChange(of: model.voiceSttEngine) { _ in model.saveVoiceOnEngineChange() }
            Text("Speech — the voice GUS speaks with")
                .font(.headline)
            Picker("Speech (TTS)", selection: $model.voiceTtsEngine) {
                Text("Built-in").tag("local")
                Text("Endpoint").tag("endpoint")
                // v0.17.2: the bundled Kokoro engine — the
                // real Kokoro model running on this Mac under
                // GUS's own supervision; no server to run, no
                // endpoint to keep reachable. Opt-in: picking
                // it starts the engine (and the one-time model
                // download); every other engine is untouched.
                Text("Built-in Kokoro").tag("bundled")
            }
            .pickerStyle(.segmented)
            .onAppear { model.refreshVoiceSettings() }
            .onChange(of: model.voiceTtsEngine) { _ in model.saveVoiceOnEngineChange() }
            // v0.17.5: ONE Kokoro status line, always shown.
            // The pickers save on select, so the pick above IS
            // the saved state this line describes: when Kokoro
            // is the engine, the supervisor's own status
            // sentence — Downloading… (with progress) / Ready /
            // Unavailable + the reason, verbatim from the
            // control plane; before the first status lands, the
            // saved-state truth. When another engine is the
            // saved one, the line says Kokoro is off and how to
            // turn it on — no more reading "off" under a picker
            // that shows it picked but was never saved.
            if model.voiceTtsEngine == "bundled" {
                Text(model.voiceBundledStatus.isEmpty
                    ? "Built-in Kokoro is the speech engine — it starts on the next call."
                    : model.voiceBundledStatus)
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                Text("Built-in Kokoro is off — select it above to use it.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Text("Built-in speech lives in the app on this Mac — nothing to install, run, or keep reachable. Endpoint speech uses the services under Advanced below; if one doesn't answer when a call starts, that call uses built-in voice instead and says so — the setting itself is never changed for you.")
                .font(.caption)
                .foregroundColor(.secondary)
            if model.voiceTtsEngine == "local" {
                // v0.11.0: the built-in voice picker — the
                // voices installed on this Mac, enumerated
                // live. App-side (the UserDefaults key above),
                // because voice.json's ttsVoice names an
                // ENDPOINT voice; the built-in choice is
                // spoken by the app itself, in calls and in
                // the tests.
                // v0.11.1: a language filter above it (default
                // English, remembered) — the unfiltered list
                // was every language and country variant on
                // the Mac; within a language the premium /
                // enhanced voices sort first and say so. The
                // saved pick stays in the list even outside
                // the filter, so it is never stranded.
                HStack {
                    Text("Voice language")
                        .frame(width: 90, alignment: .leading)
                    Picker("", selection: voiceLanguageSelection) {
                        ForEach(SettingsModel.speechVoiceLanguages, id: \.self) { code in
                            Text(SettingsModel.languageDisplayName(code)).tag(code)
                        }
                    }
                    .frame(maxWidth: 300)
                }
                HStack {
                    Text("Built-in voice")
                        .frame(width: 90, alignment: .leading)
                    Picker("", selection: $localTtsVoiceId) {
                        Text("Mac default voice").tag("")
                        ForEach(SettingsModel.pickerVoices(forLanguage: voiceLanguageSelection.wrappedValue, selectedId: localTtsVoiceId), id: \.identifier) { voice in
                            Text(localVoiceLabel(voice)).tag(voice.identifier)
                        }
                    }
                    .frame(maxWidth: 300)
                    Button("Test voice") { model.testLocalVoice() }
                }
                Text("The voices installed on this Mac for the chosen language (download more in System Settings → Accessibility → Spoken Content). Test voice speaks one sentence with the selected voice; Test mic and speaker under Advanced below runs the full check — mic level, this voice, and the dictation trial.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            if model.voiceTtsEngine != "local" {
                // v0.20.0: the Kokoro voice picker lives in
                // the front door now, beside the engine pick
                // it belongs to (through v0.19.0 it sat inside
                // the endpoint-fields group below, which read
                // as plumbing). v0.15.6: a picker, not the
                // free-text field. v0.23.0: the front door
                // shows the curated three (the full eight are
                // under Advanced below), mirroring the
                // iPhone's simple level. The selection is
                // still voice.json's ttsVoice; a name on file
                // outside the catalog rides along as a custom
                // entry. It shows for BOTH Kokoro engines
                // (endpoint and bundled — the bundled speaker
                // test and the call itself speak with it);
                // under Built-in speech the built-in voice
                // picker above is the voice choice instead.
                HStack {
                    Text("Voice")
                        .frame(width: 90, alignment: .leading)
                    Picker("", selection: $model.voiceTtsVoice) {
                        ForEach(SettingsModel.kokoroVoiceCuratedOptions(current: model.voiceTtsVoice)) { option in
                            Text(option.label).tag(option.id)
                        }
                    }
                    .frame(maxWidth: 300)
                }
                Text("Three voices up front — Heart, Emma (British), and Michael (male) — the same simple level the iPhone shows; the full set of eight is under Advanced below. The pick takes effect on the next call; Save under Advanced writes it with the rest of the form.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Divider()
            // v0.20.0: Advanced — the plumbing behind one
            // clearly-marked door: the endpoint fields, the
            // call-behavior switches, the mic and speaker
            // test, and the Save button for the draft-edited
            // values in this section. The Enable switch, the
            // engine pickers, and the voice pickers above all
            // save themselves.
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 12) {
                    Text("How a call runs: the microphone is open only while the call is, a pause ends your turn, and the reply is spoken sentence by sentence as it's made. Your words are transcribed on your own machine — by the app's built-in speech, or by a speech service you run — then treated like a typed message: same secret-guard, caps, and receipts, and the Shield's fast scan (typed messages get the full review) unless you switch it off below. If endpoint speech fails, you get the reply as text with the reason stated.")
                        .font(.callout)
                        .foregroundColor(.secondary)
                    // v0.23.0: the full Kokoro voice list —
                    // the front door above shows the curated
                    // three; this picker is the same pick
                    // (voice.json's ttsVoice) over all eight,
                    // custom names riding along as before.
                    if model.voiceTtsEngine != "local" {
                        HStack {
                            Text("All voices")
                                .frame(width: 90, alignment: .leading)
                            Picker("", selection: $model.voiceTtsVoice) {
                                ForEach(SettingsModel.kokoroVoiceOptions(current: model.voiceTtsVoice)) { option in
                                    Text(option.label).tag(option.id)
                                }
                            }
                            .frame(maxWidth: 300)
                        }
                        Text("The full set of eight Kokoro voices. Same pick as the front door's three — Save below writes it with the rest of the form.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Toggle("Interrupt GUS when I talk over it (barge-in)", isOn: $model.voiceBargeIn)
                    Text("Barge-in cuts the spoken reply off when you start talking over it. It stops the talking only — never a running job, never an approval.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Toggle("Shield-scan my spoken requests (Agent-Shield)", isOn: $model.voiceShieldScan)
                    Text(model.voiceShieldScan
                         ? "On: what you say gets Agent-Shield's fast scan (deterministic patterns) before it becomes a job — safer, and quick. Typed messages always get the full review."
                         : "Off: spoken turns become jobs WITHOUT the injection scan — faster, and meant for testing and troubleshooting. Nothing checks your spoken words before they reach the agent. Typed messages are still scanned, and caps, approvals, and receipts still apply. Every skipped turn is recorded as scan-skipped-by-operator.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    // v0.17.5: the endpoint fields belong to
                    // the Endpoint engine only — each half's
                    // URL/model fields (and its Test
                    // connection) show only while that half's
                    // engine IS Endpoint, hidden otherwise, so
                    // the section shows only what the picked
                    // engines actually use.
                    Group {
                if model.voiceSttEngine == "endpoint" {
                    Text("Hearing — transcription (STT)")
                        .font(.headline)
                    HStack {
                        Text("Endpoint")
                            .frame(width: 90, alignment: .leading)
                        TextField("http://127.0.0.1:8000/v1", text: $model.voiceSttUrl)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.callout, design: .monospaced))
                    }
                    HStack {
                        Text("Model")
                            .frame(width: 90, alignment: .leading)
                        TextField("whisper-1", text: $model.voiceSttModel)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 240)
                    }
                    HStack {
                        Button("Test connection") {
                            model.testVoiceConnection(kind: "stt")
                        }
                        if let r = model.voiceSttTestResult {
                            Text(r)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
                if model.voiceTtsEngine == "endpoint" {
                    Text("Speech — synthesis (TTS)")
                        .font(.headline)
                    HStack {
                        Text("Endpoint")
                            .frame(width: 90, alignment: .leading)
                        TextField("http://127.0.0.1:8880/v1", text: $model.voiceTtsUrl)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.callout, design: .monospaced))
                    }
                    HStack {
                        Text("Model")
                            .frame(width: 90, alignment: .leading)
                        TextField("kokoro", text: $model.voiceTtsModel)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 240)
                    }
                }
                if model.voiceTtsEngine == "endpoint" {
                    HStack {
                        Button("Test connection") {
                            model.testVoiceConnection(kind: "tts")
                        }
                        if let r = model.voiceTtsTestResult {
                            Text(r)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }
            if model.voiceSttEngine == "endpoint" || model.voiceTtsEngine == "endpoint" {
                Text("Test connection checks the values in the form right now — no need to save first, and nothing is saved or changed by testing.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Divider()
            Text("Test mic and speaker")
                .font(.headline)
            Text("One short check: the microphone level moves while you talk, a test sentence plays through the speech engine selected above, and — when transcription is Built-in — you say a short phrase and see what the recognizer heard, with a speed verdict for this Mac. Nothing is recorded and nothing is sent to GUS.")
                .font(.callout)
                .foregroundColor(.secondary)
            HStack {
                Button(model.voiceTestRunning ? "Stop the test" : "Test mic and speaker") {
                    model.toggleVoiceTest()
                }
                .buttonStyle(.borderedProminent)
                if model.voiceTestRunning {
                    ProgressView(value: model.voiceTestMicLevel)
                        .frame(maxWidth: 220)
                    Text("mic level")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            if let r = model.voiceTestSpeakerResult {
                Text(r)
                    .font(.callout)
                    .foregroundColor(.secondary)
            }
            if let heard = model.voiceTestHeard {
                Text("Heard: “\(heard)”")
                    .font(.callout)
            }
            if let verdict = model.voiceTestVerdict {
                Text(verdict)
                    .font(.callout)
                    .foregroundColor(.secondary)
            }
            Button("Save voice settings") {
                model.saveVoice()
            }
            .buttonStyle(.borderedProminent)
            Text("The Enable switch, the engine picks, and the voice picks above save themselves; this button saves the endpoint fields and the switches in this Advanced section.")
                .font(.caption)
                .foregroundColor(.secondary)
            Text("Approvals by voice are narrow on purpose: a parked job is read back to you, and only an exact \"confirm\" or \"yes, do it\" runs it — a plain \"yes\" runs nothing. \"Stop\" or \"GUS stop\" trips the same kill switch as typing /stop.")
                .font(.caption)
                .foregroundColor(.secondary)
                }
            } label: {
                Text("Advanced — endpoints, tests & call behavior")
                    .font(.headline)
            }
        }
    }

    /// The language filter's binding (v0.11.1): the stored
    /// choice when voices exist for it, else English when
    /// present, else the first language on offer — the
    /// selector never points at a language with no voices.
    private var voiceLanguageSelection: Binding<String> {
        Binding(
            get: {
                let languages = SettingsModel.speechVoiceLanguages
                if languages.contains(localVoiceLanguage) { return localVoiceLanguage }
                return languages.contains("en") ? "en" : (languages.first ?? "en")
            },
            set: { localVoiceLanguage = $0 }
        )
    }

    /// A voice row's label (v0.11.1): name + quality from the
    /// shared helper; a voice riding in from outside the
    /// filter (the saved pick, kept so the selection is never
    /// stranded) also names its language.
    private func localVoiceLabel(_ voice: AVSpeechSynthesisVoice) -> String {
        let label = SettingsModel.speechVoiceLabel(voice)
        if DesktopModel.primaryLanguage(of: voice) != voiceLanguageSelection.wrappedValue {
            return "\(label) (\(voice.language))"
        }
        return label
    }
}

struct SettingsMacBridgeView: View {
    @ObservedObject var model: SettingsModel
    @State private var grantTick = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsPaneTitle(text: "Mac bridge")
            Text("The resident Mac surface: screen, keyboard, shell — inside the jail you name. The helper runs inside this app's bundle, so the grants below belong to GUS.app.")
                .font(.callout)
                .foregroundColor(.secondary)

            grantRow("Accessibility",
                     granted: AXIsProcessTrusted(),
                     detail: "Lets GUS see the accessibility tree and press, type, and scroll. Required for driving.",
                     pane: "com.apple.preference.security?Privacy_Accessibility") {
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                _ = AXIsProcessTrustedWithOptions(options)
            }
            grantRow("Screen Recording",
                     granted: CGPreflightScreenCaptureAccess(),
                     detail: "Adds screenshots to observations and the Watch view. Optional — text observations work without it.",
                     pane: "com.apple.preference.security?Privacy_ScreenCapture") {
                _ = CGRequestScreenCaptureAccess()
            }
            HStack {
                Spacer()
                Button("Re-check grants") { grantTick += 1 }
            }

            Divider()
            Text("Work directories — the file & shell jail")
                .font(.headline)
            if let d = model.detail {
                if d.macWorkDirs.isEmpty {
                    Text("None on file — every Mac file path and shell working directory parks for approval until you name at least one.")
                        .foregroundColor(.secondary)
                } else {
                    ForEach(d.macWorkDirs, id: \.self) { dir in
                        Text(dir)
                            .font(.system(.callout, design: .monospaced))
                    }
                }
                Text("Shell allowlist: \(d.macShellAllowlist.isEmpty ? "none" : d.macShellAllowlist.joined(separator: ", "))")
                    .font(.callout)
                    .foregroundColor(.secondary)
            } else {
                Text("Loading…")
                    .foregroundColor(.secondary)
            }
            Text("Read-only here: the list lives in ~/.gus/state/policy.json (mac.workDirs) and is re-read on every action, so an edit lands live. Editing the list inside the app isn't wired yet — this pane shows exactly what's on file rather than pretending.")
                .font(.caption)
                .foregroundColor(.secondary)
            Button("Reveal policy.json in Finder") {
                model.reveal(NSHomeDirectory() + "/.gus/state/policy.json")
            }
        }
    }

    private func grantRow(_ title: String, granted: Bool, detail: String, pane: String, prompt: @escaping () -> Void) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(title)
                        .fontWeight(.medium)
                    Text(granted ? "✓ Granted" : "✗ Not granted")
                        .foregroundColor(granted ? .green : .secondary)
                }
                Text(detail)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
            Button("Open System Settings") {
                prompt()
                if let url = URL(string: "x-apple.systempreferences:\(pane)") {
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }
}

struct SettingsDelegatesView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsPaneTitle(text: "Delegates")
            Text("Other agents that may hand GUS work in gated conversations, labeled with their origin. A delegate's jobs run under the same scans, classifier, and caps as yours; anything that parks still parks for you.")
                .font(.callout)
                .foregroundColor(.secondary)
            if let d = model.detail {
                if d.delegates.isEmpty {
                    Text("No gated conversations — every conversation is a private operator chat.")
                        .foregroundColor(.secondary)
                } else {
                    ForEach(d.delegates, id: \.conversationId) { conv in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Conversation \(conv.conversationId)")
                                .fontWeight(.medium)
                            Text("Operator: \(conv.operatorId)")
                                .font(.caption)
                                .foregroundColor(.secondary)
                            ForEach(conv.delegates, id: \.senderId) { entry in
                                Text("• \(entry.name) — sender \(entry.senderId)")
                                    .font(.callout)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
                if let bridge = d.bridge {
                    Text("File bridge: requests arrive in conversation \(bridge.conversationId) as sender \(bridge.senderId).")
                        .font(.callout)
                        .foregroundColor(.secondary)
                }
            } else {
                Text("Loading…")
                    .foregroundColor(.secondary)
            }
            Text("Read-only in this release: delegates are named in ~/.gus/state/delegates.json, which is re-read on every event — edits land without a restart.")
                .font(.caption)
                .foregroundColor(.secondary)
            Button("Reveal delegates.json in Finder") {
                model.reveal(NSHomeDirectory() + "/.gus/state/delegates.json")
            }
        }
    }
}

struct SettingsDataView: View {
    @ObservedObject var model: SettingsModel

    private var stateDir: String { NSHomeDirectory() + "/.gus/state" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsPaneTitle(text: "Data controls")
            SettingsRow(title: "State lives at", value: "~/.gus/state")
            Text("Jobs, receipts, the policy, the vault's ciphertext, and every settings file on this Mac. Nothing about your data leaves this machine except the model calls you configured — under your own provider key.")
                .font(.callout)
                .foregroundColor(.secondary)
            HStack {
                Button("Reveal state folder") { model.reveal(stateDir) }
                Button("Reveal policy.json") { model.reveal(stateDir + "/policy.json") }
                Button("Reveal in Finder: ~/.gus") { model.reveal(NSHomeDirectory() + "/.gus") }
            }
            Divider()
            HStack(spacing: 6) {
                Text("Kill switch")
                    .font(.headline)
                HelpMark(entry: model.help("kill-switch"))
            }
            if let s = model.status {
                HStack {
                    Text(s.killed ? "ON — GUS is stopped. No new model calls; running jobs settle failed-loudly." : "Off — GUS is live.")
                        .foregroundColor(.secondary)
                    Spacer()
                    if s.killed {
                        Button("Resume GUS") { model.setKilled(false) }
                    } else {
                        Button("Stop GUS now") { model.setKilled(true) }
                    }
                }
            }
            Text("The Governor's one flag — the same switch as Telegram's /stop and the web panel's. It deletes nothing and changes no setting; resume when you want GUS back.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }
}

struct SettingsHelpView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsPaneTitle(text: "Help & support")
            Text("What every setting does, in plain language — the same help registry the web panel's pop-ups and docs page render from, fetched live from your own control plane.")
                .font(.callout)
                .foregroundColor(.secondary)
            if model.helpEntries.isEmpty {
                Text("The registry hasn't loaded yet — use Reload in General, or open the docs page below.")
                    .foregroundColor(.secondary)
            } else {
                ForEach(model.helpEntries) { entry in
                    DisclosureGroup(entry.title) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(entry.tip)
                                .font(.callout)
                            Text(entry.body)
                                .font(.callout)
                                .foregroundColor(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            Divider()
            HStack {
                Button("Open the full help page in the browser") { model.openPanelPage("/help") }
                Button("Open the web panel") { model.openPanelPage("/") }
            }
        }
    }
}

/// Devices & identity (v0.14.0; the pane began in v0.12.0
/// as the device registry): the ONE GUS identity at the top — its
/// short id, its active provider, and every provider at the
/// seam — and below it the identity's device credentials,
/// enrolled on this Mac and revocable. R1 (v0.13.0) deleted
/// the grant endpoints, so there are no enrollment codes
/// here anymore: no QR, no companion enrollment — a
/// device is a credential OF this identity, and signing in as
/// this identity is how a surface joins it.
struct SettingsDevicesView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                SettingsPaneTitle(text: "Devices & identity")
                HelpMark(entry: model.help("devices"))
            }

            Text("Identity")
                .fontWeight(.semibold)
            if let identity = model.identity {
                SettingsRow(title: "Identity", value: shortId(identity.id))
                if let name = identity.displayName, !name.isEmpty {
                    SettingsRow(title: "Display name", value: name)
                }
                SettingsRow(title: "Active provider", value: identity.provider)
                ForEach(identity.providers, id: \.kind) { provider in
                    SettingsRow(title: "Provider · \(provider.kind)",
                                value: provider.configured ? "Configured" : "Not configured")
                }
                Text("One identity for this install, minted once — every surface authenticates to it, and the devices below are its credentials. Google, Apple, and SSO are seam stubs in this build: listed so the shape is honest, configured nowhere, and the panel refuses them as the active provider.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                // The provider contracts are simple (verified
                // against packages/panel/src/server.ts):
                // POST /api/identity/provider {kind} switches
                // the active provider, and POST
                // /api/identity/password {username, password}
                // sets the local password credential (scrypt
                // digest only, panel-side). Both ride act(), so
                // a refusal lands in the notice verbatim.
                HStack {
                    Text("Active provider")
                        .fontWeight(.medium)
                    Spacer()
                    Picker("", selection: providerSelection) {
                        ForEach(identity.providers, id: \.kind) { provider in
                            Text(provider.kind).tag(provider.kind)
                        }
                    }
                    .frame(maxWidth: 220)
                }
                HStack {
                    Text("Local password")
                        .fontWeight(.medium)
                    Spacer()
                    TextField("Username", text: $model.identityUsername)
                        .frame(maxWidth: 150)
                    SecureField("Password (8+ characters)", text: $model.identityPassword)
                        .frame(maxWidth: 190)
                    Button("Set password") { model.setIdentityPassword() }
                        .disabled(model.identityUsername.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                  || model.identityPassword.isEmpty)
                }
                Text("Setting a password stores only its scrypt digest on the panel side — and does not by itself switch the active provider; switch above when you want the lock on.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                // v0.14.5: the session, beside the provider
                // controls it belongs with. Sign-out exists
                // only where a session gates anything — under
                // no-login local there is nothing to sign out
                // of, and the pane says so instead of offering
                // a button that does nothing.
                if identity.provider == "local-password" {
                    HStack {
                        Text("Session")
                            .fontWeight(.medium)
                        Spacer()
                        Text(model.identitySession?.signedIn == true ? "Signed in" : "Signed out")
                            .foregroundColor(.secondary)
                        if model.identitySession?.signedIn == true {
                            Button("Sign out") { model.signOutIdentity() }
                                .help("Sign out — the login screen shows at the next launch. This window stays open; nothing else about the identity changes.")
                        }
                    }
                    Text("Signed in, GUS opens straight in at launch. Signing out brings the login screen back at the next launch.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    Text("Session: no-login local — the machine is the lock, so there's no session to sign out of. Switch the active provider to local-password above if you want the login screen to gate launches.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            } else {
                Text("The identity hasn't loaded — an older panel may not serve it. Reload from General, or restart GUS from the menu bar.")
                    .foregroundColor(.secondary)
            }

            Divider()
            Text("Devices")
                .fontWeight(.semibold)
            Text("A device holds its own credential OF this identity — not the operator token — enrolled on this Mac and confined by the panel to its own surface. Revoking a device stops its credential immediately; the operator token and this Mac are never affected.")
                .font(.callout)
                .foregroundColor(.secondary)
            if !model.devicesWired {
                Text("This panel doesn't keep a device registry — the services may still be running an older build. Restart GUS from the menu bar and reopen Settings.")
                    .foregroundColor(.secondary)
            } else if model.devices.isEmpty {
                Text("No devices enrolled yet. A device joins by signing in as this identity; its credential then appears here, revocable.")
                    .foregroundColor(.secondary)
            } else {
                ForEach(model.devices) { device in
                    HStack(spacing: 8) {
                        Image(systemName: "iphone")
                            .foregroundColor(.secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(device.name)
                                .fontWeight(.medium)
                            Text("\(device.platform) · enrolled \(GusFormat.time(device.createdAt)) · last seen \(GusFormat.time(device.lastSeenAt))")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                        if device.revoked {
                            Text("revoked")
                                .font(.caption)
                                .fontWeight(.medium)
                                .foregroundColor(.red)
                        } else {
                            Button("Revoke") { model.revokeDevice(device) }
                                .help("Stop this device's credential from working — immediate; the device would have to enroll again under this identity to come back.")
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    /// The identity's short id: the first group of the uuid —
    /// enough to tell two installs apart at a glance, short
    /// enough to read over the phone.
    private func shortId(_ id: String) -> String {
        String(id.split(separator: "-").first ?? Substring(id))
    }

    /// The active-provider picker: reads the identity's active
    /// provider, writes through the panel the moment it
    /// changes (act() reloads, so a refusal snaps the picker
    /// back to what's actually on file).
    private var providerSelection: Binding<String> {
        Binding(
            get: { model.identity?.provider ?? "local" },
            set: { model.setIdentityProvider($0) }
        )
    }
}

/// v0.14.6: the Protection home — a Defender-style front door
/// for the Settings section. One screen, big plain-language
/// toggles over the postures an operator actually flips; the
/// twelve panes in the sidebar are the advanced layer behind
/// it. Every control writes through the panel (SettingsModel's
/// act() reloads), so the home always shows the state on file.
struct ProtectionSettingsView: View {
    @ObservedObject var model: SettingsModel
    @State private var startAtLogin = SMAppService.mainApp.status == .enabled
    @State private var observeTick = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SettingsPaneTitle(text: "Protection")
            Text("The whole posture on one screen. Everything else lives in the sections on the left.")
                .font(.callout)
                .foregroundColor(.secondary)
            if let s = model.status {
                protectionToggle(
                    title: "Governor enforcement",
                    detail: s.governorMode == "enforcing"
                        ? "On — Shield verdicts and approval parks bind."
                        : "Off (permissive) — would-be blocks are recorded, not enforced. Budgets and the kill switch still apply.",
                    isOn: Binding(
                        get: { s.governorMode == "enforcing" },
                        set: { model.setMode($0 ? "enforcing" : "permissive") }
                    )
                )
                budgetRow(s)
                protectionToggle(
                    title: "Shield scanning",
                    detail: s.shield.required
                        ? "On — nothing runs unscanned."
                        : "Off — jobs may proceed if the scanner is unreachable.",
                    isOn: Binding(
                        get: { s.shield.required },
                        set: { model.setShieldRequired($0) }
                    )
                )
            }
            protectionToggle(
                title: "Voice calls",
                detail: "Talk to GUS by voice on this Mac.",
                isOn: Binding(
                    get: { model.voiceEnabled },
                    set: { model.setVoiceEnabled($0) }
                )
            )
            protectionToggle(
                title: "Sign-in at launch",
                detail: "Off — GUS opens straight in (auto-login). A password you set stays set either way.",
                isOn: Binding(
                    get: { model.identitySession?.launchGateEnabled ?? true },
                    set: { model.setLaunchGate($0) }
                )
            )
            protectionToggle(
                title: "Start at login",
                detail: "Open GUS when you log in to this Mac.",
                isOn: startAtLoginBinding
            )
            observeRow
        }
        .onAppear { startAtLogin = SMAppService.mainApp.status == .enabled }
    }

    private func protectionToggle(title: String, detail: String, isOn: Binding<Bool>) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .fontWeight(.medium)
                Text(detail)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
            Toggle("", isOn: isOn)
                .labelsHidden()
        }
    }

    private func budgetRow(_ s: PanelStatus) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                Text("Budget")
                    .fontWeight(.medium)
                Spacer()
                Picker("", selection: Binding(
                    get: { s.budgetProfile ?? "standard" },
                    set: { model.setBudgetProfile($0) }
                )) {
                    Text("Standard").tag("standard")
                    Text("Generous").tag("generous")
                    Text("Max").tag("max")
                    Text("Unlimited").tag("unlimited")
                }
                .pickerStyle(.segmented)
                .frame(width: 360)
            }
            Text("Scales every Governor cap — Standard is your Spend caps exactly · Generous 10× · Max 100× · Unlimited has no budget limits: approvals and the kill switch still bind, and every call is still counted and receipted.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private var startAtLoginBinding: Binding<Bool> {
        Binding(
            get: { startAtLogin },
            set: { want in
                do {
                    if want {
                        try SMAppService.mainApp.register()
                    } else {
                        try SMAppService.mainApp.unregister()
                    }
                } catch {
                    // The re-read below shows the state that
                    // actually landed; the menu-bar toggle has
                    // the same contract.
                }
                startAtLogin = SMAppService.mainApp.status == .enabled
            }
        )
    }

    private var observeRow: some View {
        let granted = AXIsProcessTrusted()
        return HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text("Screen observation")
                        .fontWeight(.medium)
                    Text(granted ? "✓ Granted" : "✗ Not granted")
                        .foregroundColor(granted ? .green : .secondary)
                }
                Text("Lets GUS see and drive other apps (Accessibility).")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
            if !granted {
                Button("Open System Settings") {
                    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                    _ = AXIsProcessTrustedWithOptions(options)
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
            Button("Re-check") { observeTick += 1 }
        }
        .id(observeTick)
    }
}
