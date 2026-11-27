import ShieldKit
import SwiftUI

/// The Shield hub (v0.35.0, Glenn's direction 2026-11-27):
/// the Shield tab stops being only a log and becomes the
/// Agent-Shield front door on this iPhone — the protection
/// controls at the TOP, mirroring the Mac's Protection home
/// (SettingsSections' ProtectionSettingsView), with the log
/// and receipts as the lower half.
///
/// The Mac Protection home's control inventory, and what
/// became of each here:
///  - Governor enforcement (enforcing/permissive) → the
///    POSTURE picker below is its on-device counterpart:
///    posture is how strongly Shield verdicts bind on this
///    iPhone (Permissive is literally "verdicts recorded,
///    not enforced" — the Mac toggle's own words).
///  - Shield scanning (the gate-required toggle) → the
///    Agent Shield on/off toggle below: ShieldSettings.enabled.
///  - Budget profile picker → NOT mirrored: Governor budgets
///    are the core's, spent by jobs on the Mac; this iPhone
///    spends nothing and has no caps of its own to scale.
///  - Voice calls toggle → NOT mirrored: it enables the
///    Mac's own voice surface; on the iPhone calls are a
///    surface, not a setting — there is no toggle to mirror.
///  - Sign-in at launch → NOT mirrored: the Mac's launch
///    gate is a panel identity setting; the iPhone's gate
///    is its sign-in session, which has no such toggle.
///  - Start at login → NOT mirrored: a macOS login-item
///    (SMAppService); iOS has no equivalent surface.
///  - Screen observation row → NOT mirrored: Accessibility
///    observation of other apps does not exist on iOS.
///
/// The toggles write the SAME persisted settings everything
/// else reads — the @AppStorage keys below ARE ShieldSettings'
/// keys (gus.shield.enabled / gus.shield.posture), so the
/// hub, Settings' Security section, the scanner, and the
/// DEFCON derivations can never hold different truths; a
/// change anywhere is live everywhere.
struct ShieldHubView: View {
    @AppStorage("gus.shield.enabled") private var shieldEnabled = true
    @AppStorage("gus.shield.posture") private var shieldPostureRaw = ShieldPosture.standard.rawValue

    private var posture: ShieldPosture {
        ShieldPosture(rawValue: shieldPostureRaw) ?? .standard
    }

    private var postureBinding: Binding<ShieldPosture> {
        Binding(
            get: { posture },
            set: { shieldPostureRaw = $0.rawValue }
        )
    }

    private var status: ShieldProtectionStatus {
        .current(enabled: shieldEnabled, posture: posture)
    }

    var body: some View {
        VStack(spacing: 0) {
            hubHeader
            Divider()
            ShieldLogView(embedded: true)
        }
    }

    /// The hub's fixed head: the DEFCON banner (the posture
    /// page's level-banner shape — the level huge, the label
    /// under it, the level's own color around both) and the
    /// protection controls under it. The log scrolls below;
    /// the head never scrolls away, so the answer to "how
    /// protected am I?" is always on screen in this tab.
    private var hubHeader: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(spacing: 2) {
                Text("DEFCON \(status.level)")
                    .font(.system(size: 34, weight: .heavy))
                    .foregroundColor(status.color)
                Text(status.label)
                    .font(.headline)
                    .tracking(2)
                    .foregroundColor(status.color)
                Text("\(status.gloss) — \(status.deviceSummary(enabled: shieldEnabled, posture: posture))")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 2)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .overlay(
                RoundedRectangle(cornerRadius: 18)
                    .stroke(status.color, lineWidth: 2)
            )

            Toggle(isOn: $shieldEnabled) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Agent Shield")
                        .fontWeight(.medium)
                    Text(shieldEnabled
                         ? "On — chats and calls are scanned both ways, and every scan writes a signed receipt on this iPhone."
                         : "Off — nothing on this iPhone is scanned, and no receipts are written.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            if shieldEnabled {
                VStack(alignment: .leading, spacing: 4) {
                    Picker("Posture", selection: postureBinding) {
                        ForEach(ShieldPosture.allCases) { posture in
                            Text(posture.displayName).tag(posture)
                        }
                    }
                    .pickerStyle(.segmented)
                    Text("Permissive only watches: everything is logged, nothing is stopped. Standard stops known injections and holds suspicious turns for your OK. Strict stops anything suspicious — and anything Shield can't evaluate.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            HStack {
                Text("Bundled rules")
                    .font(.callout)
                Spacer()
                Text(ShieldScanner.rulesVersion)
                    .font(.callout)
                    .foregroundColor(.secondary)
            }
            Text("Rules are bundled with the app; they update with the app. The full settings — connection, voice, models, privacy — live behind Chat's menu (top left).")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(16)
    }
}

/// The compact protection indicator (v0.35.0): the hub's
/// DEFCON status, small enough for the main screens — a
/// colored dot and the level in the level's own color.
/// It derives from the same @AppStorage keys the hub's
/// toggles write, so it moves the moment protection changes
/// anywhere in the app.
struct ProtectionStatusPill: View {
    @AppStorage("gus.shield.enabled") private var shieldEnabled = true
    @AppStorage("gus.shield.posture") private var shieldPostureRaw = ShieldPosture.standard.rawValue

    var body: some View {
        let status = ShieldProtectionStatus.current(
            enabled: shieldEnabled,
            posture: ShieldPosture(rawValue: shieldPostureRaw) ?? .standard
        )
        HStack(spacing: 5) {
            Circle()
                .fill(status.color)
                .frame(width: 8, height: 8)
            Text("DEFCON \(status.level) · \(status.label)")
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundColor(status.color)
        }
        .accessibilityLabel("Protection: DEFCON \(status.level), \(status.label) — \(status.gloss)")
    }
}

extension ShieldProtectionStatus {
    /// The level's color as a SwiftUI Color, from the page's
    /// hex (ShieldKit stays platform-free; the hex is the
    /// shared truth, the Color is this app's rendering of it).
    var color: Color {
        Color(shieldHex: colorHex)
    }
}

extension Color {
    /// A Color from a "#rrggbb" literal.
    init(shieldHex hex: String) {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let value = UInt64(digits, radix: 16) ?? 0
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
