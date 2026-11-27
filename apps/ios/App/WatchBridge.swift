import Foundation
import WatchConnectivity

/// The phone half of the Watch link (v0.25.0): hands each
/// new WatchSnapshot to WatchConnectivity as the application
/// context — the system's latest-state channel. The Watch
/// gets the newest snapshot when it wakes, and only the
/// newest: contexts replace, they don't queue, which is
/// exactly right for a status glance.
///
/// The bridge holds the last published snapshot so a Watch
/// that activates its session late (first launch, a reboot)
/// still receives the current picture the moment it checks
/// in, without waiting for the next rebuild.
final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()

    private var lastSnapshot: WatchSnapshot?
    private var activated = false

    /// Performs a Watch-requested approval resolution
    /// (v0.27.0), installed by the snapshot builder — the
    /// component that owns the session state and the core
    /// client. The bridge itself resolves nothing: it carries
    /// the wrist's request to the resolver and the resolver's
    /// answer back, verbatim. Nil until the builder starts;
    /// a request that arrives before that is answered
    /// honestly rather than dropped.
    var approvalResolver: (@MainActor (String, Bool) async -> (ok: Bool, detail: String))?

    private override init() { super.init() }

    func activate() {
        guard WCSession.isSupported(), !activated else { return }
        activated = true
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    /// Publish a snapshot to the paired Watch. A phone with
    /// no Watch paired is a no-op — the snapshot is kept for
    /// a later activation, and nothing here may ever fail
    /// loudly into the phone's own flows.
    func publish(_ snapshot: WatchSnapshot) {
        lastSnapshot = snapshot
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated,
              let data = try? JSONEncoder().encode(snapshot)
        else { return }
        // Throws when no Watch is paired or the Watch app
        // isn't installed — a normal state, not an error
        // worth surfacing.
        try? session.updateApplicationContext([WatchLink.contextKey: data])
    }

    // MARK: WCSessionDelegate

    /// A resolution request from the Watch (v0.27.0). The
    /// Watch sends it as a live message precisely so it gets
    /// a live answer: the reply handler carries the core's
    /// own verdict (ok + its words) back to the wrist, and
    /// if this phone can't be reached the Watch's send fails
    /// on its side and says so — a resolution is never queued
    /// silently for later, because the operator decided NOW,
    /// about the approval as it stands NOW.
    func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        guard let payload = message[WatchLink.resolutionKey] as? [String: Any],
              let id = payload["id"] as? String, !id.isEmpty,
              let approve = payload["approve"] as? Bool
        else {
            replyHandler(["ok": false, "detail": "That request couldn't be read — nothing was resolved."])
            return
        }
        guard let approvalResolver else {
            replyHandler(["ok": false, "detail": "Open GUS on your iPhone to resolve approvals."])
            return
        }
        Task { @MainActor in
            let result = await approvalResolver(id, approve)
            replyHandler(["ok": result.ok, "detail": result.detail])
        }
    }

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        if activationState == .activated, let lastSnapshot {
            publish(lastSnapshot)
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        // The pairing changed under us — re-activate so the
        // new Watch starts receiving snapshots.
        WCSession.default.activate()
    }
}
