import Foundation

/// Builds the Watch snapshot (v0.25.0) and keeps it fresh
/// while the app is alive: on launch, on every sign-in state
/// change, on every return to the foreground, and on a slow
/// timer — the wrist should never show a picture the phone
/// itself has moved past without the timestamp saying so.
///
/// Every refresh is cheap where it counts: the Shield side
/// folds only the receipts past the highlights cache's
/// watermark (never a log re-read), and the core side is the
/// status probe — the same /api/status the Activity tab
/// already uses — plus, when signed in, the approvals and
/// jobs reads that fill the wrist's approvals section
/// (v0.27.0). Nothing here touches the voice path.
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
        // Watch approvals (v0.27.0): the bridge hands wrist
        // resolutions here, where the session state and the
        // client live. The resolution itself is the core's —
        // this closure only gates on the operator being
        // signed in on THIS phone and carries the core's
        // answer back verbatim; then the snapshot rebuilds,
        // so the wrist's list reflects what actually happened.
        WatchBridge.shared.approvalResolver = { [weak self] id, approve in
            guard let self else {
                return (ok: false, detail: "GUS isn't ready on this iPhone — nothing was resolved.")
            }
            guard case .signedIn = self.stateProvider() else {
                return (ok: false, detail: "Open GUS on your iPhone and sign in to resolve approvals.")
            }
            do {
                let result = try await GUSClient.shared.resolveApproval(id: id, approve: approve)
                self.refreshNow()
                return (ok: result.ok, detail: result.detail)
            } catch {
                return (ok: false, detail: "Couldn't reach the core — nothing was resolved. (\(error.localizedDescription))")
            }
        }
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

        // Parked approvals ride the snapshot (v0.27.0) when
        // the operator is signed in and the core answered
        // this pass: the panel's own approvals list, with
        // the job's kind joined in from the jobs list when
        // it can be named (the same two reads the Activity
        // tab makes). Any other state — signed out, core
        // unreachable — publishes an empty list under a
        // connection line that already says why, so the
        // wrist never shows a stale queue as a live one:
        // approvals expire, and yesterday's list presented
        // as today's would invite resolving ghosts. (A tap
        // on a genuinely stale entry is still safe — the
        // core re-validates at resolution — but the list
        // itself only ever claims what this pass just read.)
        var pendingApprovals: [WatchApproval] = []
        var pendingApprovalTotal = 0
        if case .signedIn = state, coreReachable,
           let pending = try? await GUSClient.shared.approvals() {
            pendingApprovalTotal = pending.count
            let kinds = Dictionary(
                ((try? await GUSClient.shared.jobs()) ?? []).map { ($0.id, $0.kind) },
                uniquingKeysWith: { first, _ in first })
            pendingApprovals = pending.prefix(WatchSnapshot.approvalLimit).map { approval in
                WatchApproval(
                    id: approval.id,
                    jobLabel: kinds[approval.jobId] ?? "A job",
                    summary: approval.summary,
                    reason: approval.reason,
                    createdAt: Date(timeIntervalSince1970: approval.createdAt / 1000),
                    expiresAt: Date(timeIntervalSince1970: approval.expiresAt / 1000))
            }
        }

        let snapshot = WatchSnapshot(
            generatedAt: Date(),
            connectionLine: connectionLine,
            coreReachable: coreReachable,
            statusLine: statusLine,
            brainName: ActiveBrain.resolved()?.plainName,
            caughtTotal: cache.caughtTotal,
            highlights: Array(cache.highlights.prefix(WatchSnapshot.highlightLimit)),
            pendingApprovals: pendingApprovals,
            pendingApprovalTotal: pendingApprovalTotal)
        WatchBridge.shared.publish(snapshot)
    }
}
