import SwiftUI

/// First-run setup, in the app (v0.8) — the panel wizard's five
/// steps as a native sheet: Shield → Telegram → provider → caps →
/// first job. Every button is the panel's own onboarding endpoint,
/// the same call the web wizard makes: the Shield key is
/// provisioned straight into the vault, the Telegram token and the
/// provider key travel app → local panel → vault over 127.0.0.1,
/// caps land in the Governor. Nothing is stored by the app, and a
/// key field is cleared the moment its step succeeds.
///
/// Presented automatically once when a fresh install can't think
/// yet (DesktopModel.needsSetup), and any time from the menu
/// (First-Run Setup…) or Settings → General.
struct SetupFlowView: View {
    @ObservedObject var model: DesktopModel

    @State private var failMode = "closed"
    @State private var tgToken = ""
    @State private var provider = "gemini"
    @State private var modelName = "gemini-3.5-flash"
    @State private var apiKey = ""
    @State private var baseUrl = ""
    @State private var capTask = ""
    @State private var capDay = ""
    @State private var capMonth = ""
    @State private var seeded = false

    /// Starter models per provider — mirrors the web wizard's map
    /// (which mirrors SUGGESTED_MODELS in the control plane).
    static let suggestedModels: [String: String] = [
        "gemini": "gemini-3.5-flash",
        "anthropic": "claude-sonnet-5",
        "openai": "gpt-5-mini",
        "ollama": "llama3.1:8b",
        "gateway": "llama3.1:8b",
        "stub": "stub-v0",
    ]
    static let providers = ["gemini", "anthropic", "openai", "ollama", "gateway", "stub"]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Set up GUS")
                        .font(.title2)
                        .fontWeight(.semibold)
                    Text("Five steps, the same ones as the web setup panel — keys go straight into the encrypted vault on this Mac and are never shown again.")
                        .font(.callout)
                        .foregroundColor(.secondary)
                }
                Spacer()
                Button("Done") { model.setupPresented = false }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(20)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let ob = model.onboarding {
                        shieldStep(done: ob.steps.shield.done, detail: ob.steps.shield.detail)
                        telegramStep(done: ob.steps.telegram.done, detail: ob.steps.telegram.detail)
                        providerStep(done: ob.steps.provider.done, detail: ob.steps.provider.detail)
                        capsStep(done: ob.steps.caps.done, detail: ob.steps.caps.detail)
                        firstJobStep(done: ob.steps.firstJob.done, detail: ob.steps.firstJob.detail)
                    } else {
                        Text("Waiting for the control plane… setup steps appear here as soon as the panel answers.")
                            .foregroundColor(.secondary)
                    }
                    if let notice = model.notice {
                        Text(notice)
                            .font(.callout)
                            .foregroundColor(.secondary)
                    }
                }
                .padding(20)
            }
        }
        .frame(width: 580, height: 660)
        .onAppear(perform: seed)
        .onChange(of: model.onboarding?.steps.provider.done) { _, _ in seed() }
    }

    /// Pre-fill drafts once from the onboarding read model: the
    /// saved provider (if any) and the suggested caps.
    private func seed() {
        guard !seeded, let ob = model.onboarding else { return }
        seeded = true
        if let current = ob.currentProvider {
            provider = current.provider
            modelName = current.model
            baseUrl = current.baseUrl ?? ""
        }
        capTask = trimNum(ob.suggestedCaps.maxUsdPerTask)
        capDay = trimNum(ob.suggestedCaps.maxUsdPerDay)
        capMonth = trimNum(ob.suggestedCaps.maxUsdPerMonth)
    }

    private func trimNum(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(v)
    }

    // MARK: Steps

    private func stepHeader(_ n: Int, _ title: String, done: Bool, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                if done {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.green)
                }
                Text("\(n) · \(title)")
                    .font(.headline)
            }
            if let detail {
                Text(detail)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }

    private func shieldStep(done: Bool, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            stepHeader(1, "Agent-Shield gate", done: done, detail: detail)
            Text("GUS's non-optional gate: every message and observation is scanned before the model can see it. This provisions a free key straight into the vault.")
                .font(.callout)
                .foregroundColor(.secondary)
            HStack {
                Picker("If the Shield is unreachable:", selection: $failMode) {
                    Text("Fail closed — block").tag("closed")
                    Text("Fail open — proceed, flagged").tag("open")
                }
                .frame(maxWidth: 320)
                Button("Provision & turn on the gate") { model.setupShield(failMode: failMode) }
            }
        }
    }

    private func telegramStep(done: Bool, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            stepHeader(2, "Telegram — approvals in your pocket", done: done, detail: detail)
            Text("Create a bot with @BotFather in Telegram, then paste its token here. It goes straight into the vault — never paste a token into a chat; Telegram is not end-to-end encrypted. A token stored here takes effect on the next GUS start if the channel isn't already connected.")
                .font(.callout)
                .foregroundColor(.secondary)
            HStack {
                SecureField("Bot token (123456789:AA…)", text: $tgToken)
                    .frame(maxWidth: 340)
                Button("Store token") {
                    model.setupTelegram(token: tgToken.trimmingCharacters(in: .whitespacesAndNewlines))
                    tgToken = ""
                }
                .disabled(tgToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func providerStep(done: Bool, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            stepHeader(3, "Provider & model", done: done, detail: detail)
            HStack {
                Picker("Provider", selection: $provider) {
                    ForEach(Self.providers, id: \.self) { p in Text(p).tag(p) }
                }
                .frame(maxWidth: 200)
                .onChange(of: provider) { _, newValue in
                    modelName = Self.suggestedModels[newValue] ?? ""
                }
                TextField("Model", text: $modelName)
                    .frame(maxWidth: 220)
            }
            HStack {
                SecureField("API key — straight into the vault", text: $apiKey)
                    .frame(maxWidth: 340)
                TextField("Base URL (optional)", text: $baseUrl)
                    .frame(maxWidth: 220)
            }
            if provider == "gemini" {
                Text("One honest catch: on Google's free tier, Google may use what you send to improve its models — a paid Gemini key removes that.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            if provider == "ollama" {
                Text("Ollama runs on your own machine and costs $0 — no key needed.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Button("Save provider") {
                model.setupProvider(
                    provider: provider,
                    model: modelName.trimmingCharacters(in: .whitespacesAndNewlines),
                    apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines),
                    baseUrl: baseUrl.trimmingCharacters(in: .whitespacesAndNewlines))
                apiKey = ""
            }
        }
    }

    private func capsStep(done: Bool, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            stepHeader(4, "Spend caps", done: done, detail: detail)
            Text("Hard dollar ceilings, enforced by the Governor outside the model. The agent cannot change them — only you can, here.")
                .font(.callout)
                .foregroundColor(.secondary)
            HStack(spacing: 14) {
                capField("Per task $", $capTask)
                capField("Per day $", $capDay)
                capField("Per month $", $capMonth)
                Button("Save caps") {
                    model.setupCaps(
                        task: Double(capTask) ?? 2,
                        day: Double(capDay) ?? 10,
                        month: Double(capMonth) ?? 100)
                }
            }
        }
    }

    private func capField(_ label: String, _ value: Binding<String>) -> some View {
        HStack(spacing: 4) {
            Text(label).foregroundColor(.secondary)
            TextField("", text: value)
                .frame(width: 70)
        }
    }

    private func firstJobStep(done: Bool, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            stepHeader(5, "First job — the proof", done: done, detail: detail)
            Text("Runs the daily digest through the whole pipeline — gate, Governor, verification, receipt — read-only. Watch it settle in Chat and Jobs.")
                .font(.callout)
                .foregroundColor(.secondary)
            Button("Run the first job") { model.setupFirstJob() }
        }
    }
}
