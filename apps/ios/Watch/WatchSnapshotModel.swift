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
