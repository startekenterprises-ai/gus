import SwiftUI

/// The DEFCON-style protection status (v0.35.0) — the
/// glanceable answer to "how protected is this Mac right
/// now?", in the Agent-Shield posture page's own language.
/// The level table below (numbers, labels, glosses, colors)
/// is the page's verbatim (agent-shield-connector's
/// POSTURE_LEVELS / POSTURE_COLORS) and is MIRRORED exactly
/// from the iPhone's ShieldProtectionStatus (ShieldKit) —
/// the two apps can't share the code (separate packages),
/// so the suite pins both copies to the same literals.
///
/// The page computes its level from the hosted service's
/// health; a GUS device's honest local inputs are its own
/// protection settings, so the levels are adapted: the
/// scale reads "how much protection is actually in force
/// on this device", computed here from this Mac's panel
/// status — the same state the Protection home displays.
///
/// The Mac mapping (worst applicable state wins):
///   Kill switch on, or no Shield provisioned → 1 DARK
///     — the page's own meaning: the scanner core is not
///     answering; don't trust verdicts. (A stopped GUS is
///     dark by the same logic: nothing runs, nothing scans.)
///   Governor permissive                      → 2 DEGRADED
///     — verdicts are recorded, not enforced: scans
///     continue, guards are turned down.
///   Gate not required                        → 3 STRAIN
///     — protection is on, but a job may proceed unscanned
///     while the scanner is unreachable: it flickers.
///   Gate required, fail-open                 → 4 WATCH
///     — all protections active; the one relaxation is
///     that an unreachable scanner fails open (flagged,
///     no receipt) instead of closed.
///   Enforcing + required + fail-closed       → 5 STEADY
///     — full protection, the strictest this Mac has.
/// The iPhone reaches 1, 2, 4, 5 from its own settings
/// (its scanner is in-process, so nothing flickers and 3
/// has no iPhone state); the scale is one, the reachable
/// levels are each device's honest subset.
enum ProtectionStatus: Int, CaseIterable {
    case dark = 1
    case degraded = 2
    case strain = 3
    case watch = 4
    case steady = 5

    /// The DEFCON number, 1–5 (5 is calmest, as on the page).
    var level: Int { rawValue }

    /// The page's one-word name for the level.
    var label: String {
        switch self {
        case .steady: return "STEADY"
        case .watch: return "WATCH"
        case .strain: return "STRAIN"
        case .degraded: return "DEGRADED"
        case .dark: return "DARK"
        }
    }

    /// The page's gloss for the level.
    var gloss: String {
        switch self {
        case .steady: return "Calm"
        case .watch: return "Watchful"
        case .strain: return "Strained"
        case .degraded: return "Impaired"
        case .dark: return "Down"
        }
    }

    /// The page's color for the level (POSTURE_COLORS).
    var colorHex: String {
        switch self {
        case .steady: return "#137333"
        case .watch: return "#6a9a00"
        case .strain: return "#b06000"
        case .degraded: return "#c2410c"
        case .dark: return "#d93025"
        }
    }

    var color: Color {
        Color(shieldHex: colorHex)
    }

    /// The status for this Mac, from its panel status — the
    /// one derivation the main screen's badge reads.
    static func current(status s: PanelStatus) -> ProtectionStatus {
        if s.killed || !s.shield.provisioned { return .dark }
        if s.governorMode == "permissive" { return .degraded }
        if !s.shield.required { return .strain }
        if s.shield.onUnavailable != "closed" { return .watch }
        return .steady
    }

    /// What the level means on THIS Mac, in plain words —
    /// the badge's tooltip, worded for the state that
    /// actually produced the level.
    func summary(status s: PanelStatus) -> String {
        switch self {
        case .steady:
            return "Full protection on this Mac — the Governor enforces, the Shield gate is required, and an unreachable scanner fails closed."
        case .watch:
            return "Protection on this Mac — the Governor enforces and the gate is required; if the scanner is unreachable, jobs fail open, flagged, with no receipt."
        case .strain:
            return "Protection is on, but the Shield gate is not required — a job may proceed unscanned while the scanner is unreachable."
        case .degraded:
            return "The Governor is permissive on this Mac — Shield verdicts are recorded, not enforced."
        case .dark:
            if s.killed {
                return "The kill switch is on — GUS is stopped. Nothing runs, and nothing is scanned."
            }
            return "No Shield scanner is provisioned on this Mac — verdicts can't be trusted until it is."
        }
    }
}

/// The compact protection indicator for the main screen
/// (v0.35.0): a colored dot and the level, in the level's
/// own color — the same readout the iPhone's Chat carries,
/// computed from this Mac's own settings.
struct ProtectionStatusBadge: View {
    let status: PanelStatus

    var body: some View {
        let level = ProtectionStatus.current(status: status)
        HStack(spacing: 5) {
            Circle()
                .fill(level.color)
                .frame(width: 8, height: 8)
            Text("DEFCON \(level.level) · \(level.label)")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(level.color)
        }
        .help(level.summary(status: status))
    }
}

extension Color {
    /// A Color from a "#rrggbb" literal — the posture
    /// colors ride as hex strings so the level table reads
    /// identically on both platforms.
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
