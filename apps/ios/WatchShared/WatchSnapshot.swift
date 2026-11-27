import Foundation

// The Watch snapshot (v0.25.0): everything the wrist view
// shows, computed on the iPhone and carried to the Watch by
// WatchConnectivity's application context. This file is the
// ONE source file both targets compile (the WatchShared
// synchronized group) — Foundation only, no app logic: the
// phone fills the snapshot in, the Watch renders it verbatim.
//
// Freshness is part of the model, not a UI afterthought:
// `generatedAt` is when the PHONE last built the snapshot,
// and the Watch shows that age on its face. A snapshot is a
// statement about the past, never a claim about right now.

/// The WatchConnectivity application-context key the snapshot
/// data rides under.
enum WatchLink {
    static let contextKey = "gusWatchSnapshot"
}

/// One caught Shield item, in plain words for a wrist: what
/// happened ("Blocked a risky request") and where ("In
/// something you said"). Derived from a ShieldReceipt on the
/// phone by the highlights cache; the content itself never
/// leaves the receipt log (receipts store hashes, not text).
struct WatchHighlight: Codable, Identifiable, Sendable {
    /// The receipt's per-device sequence number — stable id.
    let seq: Int
    let date: Date
    let title: String
    let detail: String

    var id: Int { seq }
}

struct WatchSnapshot: Codable, Sendable {
    /// When the phone built this snapshot.
    let generatedAt: Date
    /// Plain words: "Core connected", "Core unreachable",
    /// "On-device only", "No core connected".
    let connectionLine: String
    /// The phone's last word on whether the core answered.
    let coreReachable: Bool
    /// The headline: "Ready", "Ready — on-device",
    /// "Stopped — the kill switch is on", or the setup ask.
    let statusLine: String
    /// The active on-device brain's plain name, when one is
    /// downloaded (the About row's name, v0.22.0).
    let brainName: String?
    /// Every caught item the phone's receipt log holds —
    /// the highlights below are only the newest few.
    let caughtTotal: Int
    /// The newest caught items, newest first, capped for a
    /// wrist. The full log stays on the phone.
    let highlights: [WatchHighlight]

    /// How many highlights ride a snapshot — a wrist shows
    /// a handful, not a history.
    static let highlightLimit = 5
}
