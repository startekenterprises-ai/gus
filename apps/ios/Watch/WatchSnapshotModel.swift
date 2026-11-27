import Foundation
import WatchConnectivity

/// The Watch half of the link: receives snapshots from the
/// iPhone's application context and keeps the latest one.
///
/// The last received snapshot is persisted on the Watch, so
/// a relaunch shows the last known picture immediately —
/// with its original `generatedAt`, so its age is honest
/// rather than silently reset. A snapshot is never refreshed
/// from anywhere but the phone: if the phone has been quiet,
/// the view's staleness line says so.
@MainActor
final class WatchSnapshotModel: NSObject, ObservableObject {
    @Published private(set) var snapshot: WatchSnapshot?

    /// Where a wrist resolution stands, per approval id
    /// (v0.27.0). The snapshot stays the source of truth for
    /// WHAT is pending; this only records what the core
    /// answered about a decision the operator already made
    /// from this wrist — so the row can show the core's own
    /// words ("Approved — executing exactly that.", or the
    /// refusal's reason) instead of vanishing on a guess.
    enum ResolutionOutcome: Equatable {
        case sending
        case answered(ok: Bool, detail: String)
    }

    @Published private(set) var outcomes: [String: ResolutionOutcome] = [:]

    private static let defaultsKey = "gus.watch.lastSnapshot"

    override init() {
        super.init()
        if let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
           let saved = try? JSONDecoder().decode(WatchSnapshot.self, from: data) {
            snapshot = saved
        }
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        // A context delivered before this launch is already
        // waiting in the session — take it now rather than
        // waiting for the next phone-side publish.
        if let data = session.receivedApplicationContext[WatchLink.contextKey] as? Data {
            apply(data)
        }
    }

    private func apply(_ data: Data) {
        guard let decoded = try? JSONDecoder().decode(WatchSnapshot.self, from: data)
        else { return }
        snapshot = decoded
        UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        // Outcomes for approvals the new snapshot no longer
        // lists have done their job — the row is gone, and a
        // kept outcome could only attach yesterday's answer
        // to a recycled id. An in-flight send keeps its entry
        // until its answer lands.
        let live = Set(decoded.pendingApprovals.map(\.id))
        outcomes = outcomes.filter { live.contains($0.key) || $0.value == .sending }
    }

    /// Send a resolution to the iPhone and record the
    /// answer (v0.27.0). A live message, deliberately: the
    /// phone performs the resolution through the core's own
    /// approval path (which re-validates the id — a stale
    /// snapshot's approval resolves nothing) and replies
    /// with the core's verdict. If the phone can't be
    /// reached, the send fails here and the outcome says so;
    /// the Watch holds no credentials and talks to no core,
    /// so there is no other path and no quiet retry.
    func resolve(_ approval: WatchApproval, approve: Bool) {
        if outcomes[approval.id] == .sending { return }
        outcomes[approval.id] = .sending
        let session = WCSession.default
        guard WCSession.isSupported(), session.activationState == .activated else {
            outcomes[approval.id] = .answered(
                ok: false, detail: "Couldn't reach your iPhone — open GUS there and try again.")
            return
        }
        let message: [String: Any] = [
            WatchLink.resolutionKey: ["id": approval.id, "approve": approve],
        ]
        session.sendMessage(message, replyHandler: { [weak self] reply in
            let ok = reply["ok"] as? Bool ?? false
            let detail = reply["detail"] as? String
                ?? "The iPhone didn't say — nothing is confirmed."
            Task { @MainActor in
                self?.outcomes[approval.id] = .answered(ok: ok, detail: detail)
            }
        }, errorHandler: { [weak self] _ in
            Task { @MainActor in
                self?.outcomes[approval.id] = .answered(
                    ok: false, detail: "Couldn't reach your iPhone — open GUS there and try again.")
            }
        })
    }
}

// MARK: WCSessionDelegate

extension WatchSnapshotModel: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        if activationState == .activated,
           let data = session.receivedApplicationContext[WatchLink.contextKey] as? Data {
            Task { @MainActor in self.apply(data) }
        }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveApplicationContext applicationContext: [String: Any]
    ) {
        guard let data = applicationContext[WatchLink.contextKey] as? Data else { return }
        Task { @MainActor in self.apply(data) }
    }
}
