import Foundation
import ShieldKit

/// The incremental Shield highlights cache (v0.25.0): the
/// caught/stopped highlights the Watch view shows, kept
/// current WITHOUT ever re-reading the receipt log.
///
/// The discipline is the one the Mac panel learned the hard
/// way (v0.14.0, log-cache.ts): derivation runs once per
/// appended line, never once per poll over the whole file.
/// The cache holds a watermark — the highest receipt seq it
/// has folded — and each refresh folds only the receipts
/// past it, read from ShieldReceiptLog's in-memory chain
/// (the JSONL is parsed once per process by the log itself;
/// `receipts(afterSeq:)` never touches the file).
///
/// Bounded by construction: at most `capacity` highlights
/// are kept, newest first. The full receipt history stays
/// in ShieldReceiptLog, one tap away in the phone's Shield
/// log — this cache is a window, not a copy.
///
/// The phone's Logs surface may read from this cache later;
/// in v0.25.0 its only consumer is the Watch snapshot
/// builder, and the Shield log UI is deliberately untouched.
final class ShieldHighlightsCache {
    /// Highlights kept. The snapshot takes the newest five;
    /// the cache keeps a little slack so a burst of catches
    /// doesn't churn the window on every fold.
    static let capacity = 12

    /// The newest caught items, newest first.
    private(set) var highlights: [WatchHighlight] = []
    /// Every caught item folded since the log began — the
    /// count the Watch header reports ("3 caught").
    private(set) var caughtTotal = 0
    /// Highest receipt seq folded so far (-1: none yet).
    private var foldedSeq = -1

    /// Fold every receipt newer than the watermark into the
    /// cache. Returns true when anything changed. Cheap by
    /// design: with no new receipts this is one watermark
    /// comparison against the log's in-memory chain.
    @discardableResult
    func foldNewReceipts() -> Bool {
        let fresh = ShieldReceiptLog.shared.receipts(afterSeq: foldedSeq)
        guard !fresh.isEmpty else { return false }
        var changed = false
        for receipt in fresh { // oldest first
            foldedSeq = receipt.seq
            guard receipt.isCaught else { continue }
            caughtTotal += 1
            highlights.insert(Self.highlight(for: receipt), at: 0)
            changed = true
        }
        if highlights.count > Self.capacity {
            highlights.removeLast(highlights.count - Self.capacity)
        }
        return changed
    }

    /// A receipt in plain words for a wrist — the same
    /// verdicts the Shield log shows, worded the way the
    /// consumer demo rule asks: what happened, no jargon.
    static func highlight(for receipt: ShieldReceipt) -> WatchHighlight {
        let title: String
        switch receipt.verdict {
        case .block:
            title = "Blocked a risky request"
        case .quarantine:
            title = "Held a request for your review"
        case .allow:
            // Caught but let through by posture — the receipt
            // keeps the would-be verdict, and the highlight
            // must not pretend otherwise.
            title = "Allowed with a warning"
        }
        let detail = receipt.direction == .user
            ? "In something you said"
            : "In a reply from GUS"
        return WatchHighlight(
            seq: receipt.seq, date: receipt.date, title: title, detail: detail)
    }
}
