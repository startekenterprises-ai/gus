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
