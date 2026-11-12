import ApplicationServices
import SwiftUI

/// The Settings window's panes (v0.8). Every control posts the
/// panel endpoint the web surface uses for the same setting —
/// see SettingsModel. Read-only where the panel has no write API
/// (Mac work dirs, delegates), and the pane says so in words.

struct SettingsGeneralView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsPaneTitle(text: "General")
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
struct SettingsVoiceView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsPaneTitle(text: "Voice — Call GUS")
            if let s = model.status {
                SettingsRow(title: "Voice channel",
                            value: s.settings.voice.enabled
                                ? (s.settings.voice.configured ? "On — endpoints on file" : "On — an endpoint is missing")
                                : "Off",
                            help: model.help("voice-call"))
            }
            Text("Talk to GUS from the chat window's Call button — a live call, not a recording: the microphone is open only while the call is, a pause ends your turn, and the reply is spoken sentence by sentence as it's made. Your words are transcribed by a speech service on your own machine, then treated exactly like a typed message — same secret-guard, Shield scan, caps, and receipts. If a speech service fails, you get the reply as text with the reason stated.")
                .font(.callout)
                .foregroundColor(.secondary)
            Toggle("Enable voice calls", isOn: $model.voiceEnabled)
            Toggle("Interrupt GUS when I talk over it (barge-in)", isOn: $model.voiceBargeIn)
            Text("Barge-in cuts the spoken reply off when you start talking over it. It stops the talking only — never a running job, never an approval.")
                .font(.caption)
                .foregroundColor(.secondary)
            Group {
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
                HStack {
                    Text("Voice")
                        .frame(width: 90, alignment: .leading)
                    TextField("af_heart", text: $model.voiceTtsVoice)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 240)
                }
            }
            Button("Save voice settings") {
                model.saveVoice()
            }
            .buttonStyle(.borderedProminent)
            Text("Approvals by voice are narrow on purpose: a parked job is read back to you, and only an exact \"confirm\" or \"yes, do it\" runs it — a plain \"yes\" runs nothing. \"Stop\" or \"GUS stop\" trips the same kill switch as typing /stop.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
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
