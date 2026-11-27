import Foundation

/// The DEFCON-style protection status (v0.35.0) — the
/// glanceable answer to "how protected is this device right
/// now?", in the Agent-Shield posture page's own language
/// (agent-shield-connector/worker/src/index.ts: POSTURE_LEVELS
/// and POSTURE_COLORS — the level numbers, labels, glosses,
/// and colors below are the page's, verbatim).
///
/// The page computes its level from the hosted service's
/// health (scanner canary, KV probes). A GUS device has no
/// hosted service to probe — its honest local inputs are its
/// own Shield settings — so the levels are ADAPTED, not
/// copied: the scale reads "how much protection is actually
/// in force on this device", computed from this device's
/// settings only, never from another device's state.
///
/// The iPhone mapping (ShieldSettings: enabled + posture):
///   Shield off        → 1 DARK     — nothing is scanned,
///                                    no receipts are written.
///   Permissive        → 2 DEGRADED — scans run and are
///                                    logged, but every
///                                    verdict downgrades to
///                                    warn-and-log: the
///                                    page's "scans continue;
///                                    guards are reduced",
///                                    word for word.
///   Standard          → 4 WATCH    — all protections active
///                                    at the normal strictness.
///   Strict            → 5 STEADY   — full protection, fail
///                                    closed: the strictest
///                                    setting the device has.
/// Level 3 (STRAIN — protection on but intermittently
/// degraded) has NO iPhone state: the on-device scanner is
/// in-process, so when Shield is on it is simply there —
/// nothing flickers. The Mac's mapping (ProtectionStatus in
/// the Mac app, the same table mirrored) does reach 3, for
/// the state where jobs may proceed unscanned while the
/// scanner is unreachable. Not every level is reachable on
/// every device; that is the honest shape of the adaptation.
public enum ShieldProtectionStatus: Int, CaseIterable, Sendable {
    case dark = 1
    case degraded = 2
    case strain = 3
    case watch = 4
    case steady = 5

    /// The DEFCON number, 1–5 (5 is calmest, as on the page).
    public var level: Int { rawValue }

    /// The page's one-word name for the level.
    public var label: String {
        switch self {
        case .steady: return "STEADY"
        case .watch: return "WATCH"
        case .strain: return "STRAIN"
        case .degraded: return "DEGRADED"
        case .dark: return "DARK"
        }
    }

    /// The page's gloss for the level.
    public var gloss: String {
        switch self {
        case .steady: return "Calm"
        case .watch: return "Watchful"
        case .strain: return "Strained"
        case .degraded: return "Impaired"
        case .dark: return "Down"
        }
    }

    /// The page's color for the level (POSTURE_COLORS).
    public var colorHex: String {
        switch self {
        case .steady: return "#137333"
        case .watch: return "#6a9a00"
        case .strain: return "#b06000"
        case .degraded: return "#c2410c"
        case .dark: return "#d93025"
        }
    }

    /// The status for a device with these Shield settings —
    /// the one derivation every iOS surface reads (the hub's
    /// banner, the compact pill in Chat), so they can never
    /// disagree with each other or with the scanner.
    public static func current(enabled: Bool, posture: ShieldPosture) -> ShieldProtectionStatus {
        guard enabled else { return .dark }
        switch posture {
        case .permissive: return .degraded
        case .standard: return .watch
        case .strict: return .steady
        }
    }

    /// The status from the persisted settings themselves.
    public static var currentFromSettings: ShieldProtectionStatus {
        current(enabled: ShieldSettings.enabled, posture: ShieldSettings.posture)
    }

    /// What the level means on THIS iPhone, in plain words —
    /// the hub banner's second line.
    public func deviceSummary(enabled: Bool, posture: ShieldPosture) -> String {
        switch self {
        case .steady:
            return "Full protection on this iPhone — Strict posture stops anything suspicious, and anything Shield can't evaluate."
        case .watch:
            return "Protection on this iPhone — Standard posture stops known injections and holds suspicious turns for your OK."
        case .strain:
            return "Protection is on, but intermittently degraded."
        case .degraded:
            return "Shield is watching only on this iPhone — Permissive posture logs everything and stops nothing."
        case .dark:
            return "Shield is off on this iPhone — chats and calls are not scanned, and no receipts are written."
        }
    }
}
