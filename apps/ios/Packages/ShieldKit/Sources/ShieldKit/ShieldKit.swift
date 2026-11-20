import Foundation

// ShieldKit — Agent Shield on the phone (v0.15.7, Glenn's
// direction 2026-11-20, panel-approved the same night: Spark YES,
// Gemini YES WITH CHANGES — the sharpenings are requirements and
// are implemented here: canonicalization before rules with
// un-evaluable input quarantined, never silently passed; a Strict
// posture that fails closed; per-device receipt streams only,
// never a merged cross-device chain).
//
// The scanner is a faithful port of the production deterministic
// engine, agent-shield-connector/worker/src/detect.ts. Rules are
// BUNDLED with the app — remote signed rule bundles are a later
// chunk and are not faked here; the Settings screen says so.

/// The bundled rules version, pinned into every receipt so a
/// verdict can always be tied to the exact rules that produced it.
public let shieldRulesVersion = "heuristic_v5-shieldkit.1"

/// What the rules themselves concluded, before posture.
/// Mirrors detect.ts enforce-mode actions (malicious → block,
/// suspicious → review, clean → allow) plus the canonicalization
/// failure case detect.ts never has but a phone scanner must
/// answer for: input that could not be evaluated at all.
public enum ShieldRawVerdict: String, Codable, Sendable {
    case allow
    case quarantine
    case block
    case unevaluable
}

/// The verdict the app acts on, after the posture mapping.
public enum ShieldVerdict: String, Codable, Sendable {
    case allow
    case quarantine
    case block
}

/// Which way a scanned turn was travelling.
public enum ShieldDirection: String, Codable, Sendable {
    /// The operator's words, on their way to the brain.
    case user
    /// The brain's reply, on its way to the voice.
    case assistant
}

/// The Shield posture — the same language as the Mac Governor's
/// postures (Glenn, 2026-11-20: "could I also have permissive
/// abilities?"). Persisted in Settings; recorded on every receipt.
public enum ShieldPosture: String, CaseIterable, Codable, Identifiable, Sendable {
    case permissive
    case standard
    case strict

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .permissive: return "Permissive"
        case .standard: return "Standard"
        case .strict: return "Strict"
        }
    }

    /// The whole posture contract in one function:
    /// - strict: quarantine becomes block, un-evaluable becomes
    ///   block (fail closed — the airplane-mode evasion answer).
    /// - standard: block / quarantine-with-one-time-override /
    ///   allow per rule severity; un-evaluable = quarantine
    ///   (fail open WITH a warning, never a silent pass).
    /// - permissive: every verdict downgrades to warn-and-log —
    ///   nothing is blocked or held, the conversation always
    ///   flows, and the receipt keeps the would-be verdict.
    public func effectiveVerdict(for raw: ShieldRawVerdict) -> ShieldVerdict {
        switch self {
        case .strict:
            switch raw {
            case .allow: return .allow
            case .quarantine, .block, .unevaluable: return .block
            }
        case .standard:
            switch raw {
            case .allow: return .allow
            case .quarantine, .unevaluable: return .quarantine
            case .block: return .block
            }
        case .permissive:
            return .allow
        }
    }
}

/// Shield's persisted settings. When Shield is OFF there is no
/// scanning and no receipts — the toggle is real, and the posture
/// is irrelevant while it is off.
public enum ShieldSettings {
    private static let enabledKey = "gus.shield.enabled"
    private static let postureKey = "gus.shield.posture"

    public static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    public static var posture: ShieldPosture {
        get {
            let raw = UserDefaults.standard.string(forKey: postureKey) ?? ""
            return ShieldPosture(rawValue: raw) ?? .standard
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: postureKey) }
    }
}
