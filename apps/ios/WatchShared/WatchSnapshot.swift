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

    /// The Watch → phone message key for an approval
    /// resolution (v0.27.0): the message's value is a
    /// dictionary with "id" (the core's approval id) and
    /// "approve" (Bool). The phone answers through the
    /// message's reply handler with "ok" (Bool) and "detail"
    /// (the core's own words) — the Watch displays exactly
    /// that answer and nothing it invented.
    static let resolutionKey = "gusWatchApprovalResolution"
}

/// One parked approval, in plain words for a wrist (v0.27.0):
/// the same record the panel's approvals list shows — what
/// job it belongs to, what it wants to do, why it needs the
/// operator, and its two clocks (parked since, expires at) —
/// carried in the snapshot so the operator can decide from
/// the Watch. The id is the core's approval id, verbatim:
/// resolution re-validates it at the core, so a stale
/// snapshot's id resolves nothing it shouldn't.
struct WatchApproval: Codable, Identifiable, Sendable {
    let id: String
    /// What job: the job's kind when the phone could name
    /// it from the jobs list, else a plain fallback.
    let jobLabel: String
    /// What it wants to do (the panel's summary).
    let summary: String
    /// Why it needs approval (the classifier's reason).
    let reason: String
    let createdAt: Date
    let expiresAt: Date
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
    /// Parked approvals the operator can resolve from the
    /// wrist (v0.27.0), oldest first — the order the panel
    /// lists them, and the order they expire in. Capped like
    /// the highlights; the total says how many there really
    /// are, so a long queue is never hidden by the cap.
    let pendingApprovals: [WatchApproval]
    /// Every parked approval the core holds, capped or not.
    let pendingApprovalTotal: Int

    /// How many highlights ride a snapshot — a wrist shows
    /// a handful, not a history.
    static let highlightLimit = 5

    /// How many approvals ride a snapshot. Approvals are
    /// decisions, not a feed: five is a lot to make from a
    /// wrist, and the rest wait on the phone, counted above.
    static let approvalLimit = 5
}

extension WatchSnapshot {
    /// Decoding that tolerates snapshots written before
    /// v0.27.0 (the Watch persists its last snapshot across
    /// app updates): a missing approvals field decodes as
    /// "none known", never as a failed snapshot that would
    /// blank the wrist's last picture. Encoding stays the
    /// synthesized one — the wire keys are the property
    /// names either way.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try c.decode(Date.self, forKey: .generatedAt)
        connectionLine = try c.decode(String.self, forKey: .connectionLine)
        coreReachable = try c.decode(Bool.self, forKey: .coreReachable)
        statusLine = try c.decode(String.self, forKey: .statusLine)
        brainName = try c.decodeIfPresent(String.self, forKey: .brainName)
        caughtTotal = try c.decode(Int.self, forKey: .caughtTotal)
        highlights = try c.decode([WatchHighlight].self, forKey: .highlights)
        pendingApprovals = try c.decodeIfPresent([WatchApproval].self, forKey: .pendingApprovals) ?? []
        pendingApprovalTotal = try c.decodeIfPresent(Int.self, forKey: .pendingApprovalTotal) ?? pendingApprovals.count
    }
}
