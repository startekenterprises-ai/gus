import Foundation

/// Builds the Watch snapshot (v0.25.0) and keeps it fresh
/// while the app is alive: on launch, on every sign-in state
/// change, on every return to the foreground, and on a slow
/// timer — the wrist should never show a picture the phone
/// itself has moved past without the timestamp saying so.
///
/// Every refresh is cheap where it counts: the Shield side
/// folds only the receipts past the highlights cache's
/// watermark (never a log re-read), and the core side is one
/// status probe — the same /api/status the Activity tab
/// already uses. Nothing here touches the voice path.
@MainActor
final class WatchSnapshotBuilder: ObservableObject {
    private let cache = ShieldHighlightsCache()
    private var stateProvider: () -> SessionModel.State = { .checking }
    private var timer: Timer?
    private var started = false

    /// Begin keeping the snapshot fresh. RootView calls this
    /// once, with a provider for the session model's current
    /// state (the builder never owns the session — the launch
    /// gate does).
    func start(stateProvider: @escaping () -> SessionModel.State) {
        guard !started else { return }
        started = true
        self.stateProvider = stateProvider
        WatchBridge.shared.activate()
        refreshNow()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
            Task { @MainActor [weak self] in self?.refreshNow() }
        }
    }

    func refreshNow() {
        Task { await build() }
    }

    private func build() async {
        cache.foldNewReceipts()

        let state = stateProvider()
        var coreReachable = false
        var killed = false
        if GUSSettings.isConfigured,
           let status = try? await GUSClient.shared.status() {
            coreReachable = true
            killed = status.killed
        }

        let connectionLine: String
        let statusLine: String
        switch state {
        case .checking:
            connectionLine = "Checking…"
            statusLine = "One moment…"
        case .needsConnection:
            connectionLine = "No core connected"
            statusLine = "Open GUS on your iPhone to set up"
        case .needsLogin:
            connectionLine = coreReachable ? "Core connected" : "Core unreachable"
            statusLine = "Open GUS on your iPhone to sign in"
        case .signedIn:
            connectionLine = coreReachable ? "Core connected" : "Core not answering"
            statusLine = killed ? "Stopped — the kill switch is on" : "Ready"
        case .signedInOffline:
            connectionLine = "Core unreachable — on-device only"
            statusLine = "Ready — on-device"
        }

        let snapshot = WatchSnapshot(
            generatedAt: Date(),
            connectionLine: connectionLine,
            coreReachable: coreReachable,
            statusLine: statusLine,
            brainName: ActiveBrain.resolved()?.plainName,
            caughtTotal: cache.caughtTotal,
            highlights: Array(cache.highlights.prefix(WatchSnapshot.highlightLimit)))
        WatchBridge.shared.publish(snapshot)
    }
}
