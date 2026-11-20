import SwiftUI

struct StatusView: View {
    @State private var status: PanelStatus?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                if let s = status {
                    Section("GUS v\(s.version)") {
                        LabeledContent("State", value: s.killed ? "⏹ Stopped (kill switch ON)" : "● Live")
                        LabeledContent("Agent-Shield gate", value: s.shield.provisioned ? "On · fail-\(s.shield.onUnavailable)" : "Not provisioned")
                        LabeledContent("Provider", value: "\(s.provider.id) / \(s.provider.model)")
                        LabeledContent("Approvals waiting", value: "\(s.pendingApprovals)")
                        LabeledContent("Spent today", value: money(s.spendTodayUsd))
                        LabeledContent("Spent this month", value: money(s.spendMonthUsd))
                    }
                    Section("Governor mode") {
                        Picker("Mode", selection: binding(for: s.governorMode)) {
                            Text("🛡 Enforcing").tag("enforcing")
                            Text("⚠️ Permissive").tag("permissive")
                        }
                        .pickerStyle(.segmented)
                        Text(s.governorMode == "permissive"
                             ? "Blocks and parks are recorded, not enforced. Permissive let-throughs today: \(s.permissiveToday.count)."
                             : "Shield verdicts and approval parks bind.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Section("Settings on file") {
                        LabeledContent("Provider key", value: keyState(s.settings.providerKey))
                        LabeledContent("Telegram", value: s.settings.telegramConfigured ? "Configured" : "Not configured")
                        LabeledContent("Delegates", value: "\(s.settings.delegates)")
                        LabeledContent("Mac work folders", value: "\(s.settings.macWorkDirs)")
                    }
                    Section("Kill switch") {
                        Button(s.killed ? "▶ Resume GUS" : "⏹ Stop GUS now") {
                            Task { await setKilled(!s.killed) }
                        }
                        .foregroundStyle(s.killed ? .green : .red)
                        .disabled(busy)
                    }
                } else if let error {
                    Text(error).foregroundStyle(.red)
                    Text("Check Settings: the panel address (your Mac, e.g. its Tailscale name) and the operator token from ~/.gus/state/panel-token.")
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    ProgressView("Asking GUS…")
                }
            }
            .navigationTitle("GUS")
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func binding(for current: String) -> Binding<String> {
        Binding(get: { current }, set: { new in
            Task {
                busy = true
                _ = try? await GUSClient.shared.setGovernorMode(new)
                await load()
                busy = false
            }
        })
    }

    private func setKilled(_ on: Bool) async {
        busy = true
        _ = try? await GUSClient.shared.setKilled(on)
        await load()
        busy = false
    }

    private func load() async {
        do {
            status = try await GUSClient.shared.status()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func money(_ n: Double) -> String { String(format: "$%.4f", n) }
    private func keyState(_ s: String) -> String {
        switch s {
        case "stored": return "Stored in vault ✓"
        case "missing": return "NOT stored"
        default: return "Not required"
        }
    }
}
