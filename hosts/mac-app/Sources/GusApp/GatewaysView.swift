import SwiftUI

/// Gateways: the governed connections on file, read-only in
/// Desktop 1 — the same "Settings on file" readout the web panel
/// shows (provider, Shield, channels, caps), rendered natively.
/// Editing stays in the setup panel until Desktop 2; this view
/// never shows a secret value, because the panel API never sends
/// one: key state arrives as stored / missing / not-required.
struct GatewaysView: View {
    @ObservedObject var model: DesktopModel

    var body: some View {
        Group {
            if let status = model.status {
                List {
                    Section("On file — read-only in Desktop 1; edit in the setup panel") {
                        row("Model provider",
                            "\(status.provider.id) · \(status.provider.model)",
                            "API key: \(status.settings.providerKey)")
                        row("Agent-Shield gate",
                            status.shield.provisioned ? "Provisioned" : "Not provisioned",
                            "Required: \(status.shield.required ? "yes" : "no") · if unavailable: \(status.shield.onUnavailable)"
                                + (status.shield.baseUrl.isEmpty ? "" : " · \(status.shield.baseUrl)"))
                        row("Telegram",
                            status.settings.telegramConfigured ? "Configured" : "Not configured",
                            "Approvals and chat from your phone")
                        row("Mac bridge",
                            "\(status.settings.macWorkDirs) work director\(status.settings.macWorkDirs == 1 ? "y" : "ies") on file",
                            "The resident Mac surface: screen, keyboard, shell — inside the named folders")
                        row("Delegates",
                            "\(status.settings.delegates) named",
                            "Other agents that may hand GUS work, labeled with their origin")
                        row("Governor",
                            status.governorMode.capitalized,
                            "Caps: \(GusFormat.usdCap(status.settings.caps.maxUsdPerTask)) / task · "
                                + "\(GusFormat.usdCap(status.settings.caps.maxUsdPerDay)) / day · "
                                + "\(GusFormat.usdCap(status.settings.caps.maxUsdPerMonth)) / month")
                        row("Kill switch",
                            status.killed ? "ON — GUS is stopped" : "Off — GUS is live",
                            "Stop and resume live in the menu bar")
                    }
                }
            } else {
                Text("The panel isn't reachable yet — the gateways on file appear when the control plane responds.")
                    .foregroundColor(.secondary)
                    .padding(16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }

    private func row(_ title: String, _ value: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title)
                    .fontWeight(.semibold)
                Spacer()
                Text(value)
                    .foregroundColor(.secondary)
            }
            Text(detail)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 2)
    }
}
