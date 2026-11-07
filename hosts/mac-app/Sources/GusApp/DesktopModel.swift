import Foundation

/// The desktop window's store: a polling read model over the local
/// panel APIs, plus the three actions the window offers (send a
/// chat message, approve, deny). Nothing is cached to disk and
/// nothing is invented — when the panel is unreachable the views
/// say so, with empty data, rather than showing stale success.
///
/// Poll cadence mirrors the web panel (its chat view polls every
/// 2s): one 2.5s timer refreshes status, chat, jobs, and approvals,
/// so a parked job's card appears in the window about as fast as
/// it would on the operator's phone.
final class DesktopModel: ObservableObject {
    enum Section {
        case chat
        case jobs
        case gateways
    }

    @Published var section: Section = .chat
    @Published var reachable = false
    @Published var status: PanelStatus?
    @Published var chatMessages: [PanelChatMessage] = []
    @Published var chatJobs: [PanelJob] = []
    @Published var jobs: [PanelJob] = []
    @Published var approvals: [PanelApproval] = []
    @Published var approvalsHistory: [PanelApprovalHistoryEntry] = []
    @Published var composerText = ""
    /// The last action's outcome, in the panel's own words (or the
    /// transport error). Shown under the composer / sidebar so a
    /// refusal is never silent.
    @Published var notice: String?
    /// Bumped by "New chat": ChatView watches it and focuses the
    /// composer. (The panel chat is one durable operator
    /// conversation; a new chat means a fresh turn in it.)
    @Published var composerFocusToken = 0

    private let client = PanelClient()
    private var timer: Timer?

    init() {
        refreshAll()
        timer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in
            self?.refreshAll()
        }
    }

    deinit {
        timer?.invalidate()
    }

    // MARK: Derived display state

    /// The sidebar's live status line: what GUS is doing right now,
    /// in the Governor's units.
    var statusLine: String {
        guard let status else {
            return reachable ? "…" : "Control plane not reachable"
        }
        if status.killed { return "Kill switch ON — stopped" }
        var parts = ["Running", status.governorMode]
        if status.pendingApprovals > 0 {
            parts.append("\(status.pendingApprovals) waiting for you")
        }
        parts.append("\(GusFormat.usd(status.spendTodayUsd)) today")
        return parts.joined(separator: " · ")
    }

    /// Pending approvals that belong to the chat conversation —
    /// rendered inline above the composer.
    var chatApprovals: [PanelApproval] {
        let ids = Set(chatJobs.map(\.id))
        return approvals.filter { ids.contains($0.jobId) }
    }

    // MARK: Actions

    func newChat() {
        section = .chat
        composerFocusToken += 1
    }

    func sendComposer() {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        composerText = ""
        client.post("/api/chat", jsonBody: ["text": text]) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let r):
                    self.notice = r.detail
                    if !r.ok { self.composerText = text } // refused: hand the words back
                case .failure(let e):
                    self.notice = "Could not reach the panel: \(e.localizedDescription)"
                    self.composerText = text
                }
                self.refreshChat()
            }
        }
    }

    func resolve(_ approval: PanelApproval, approve: Bool) {
        let path = "/api/approvals/\(approval.id)/\(approve ? "approve" : "deny")"
        client.post(path) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let r):
                    self.notice = r.detail
                case .failure(let e):
                    self.notice = "Could not reach the panel: \(e.localizedDescription)"
                }
                self.refreshApprovals()
                self.refreshChat()
                self.refreshStatus()
            }
        }
    }

    // MARK: Polling

    func refreshAll() {
        refreshStatus()
        refreshChat()
        refreshJobs()
        refreshApprovals()
    }

    private func refreshStatus() {
        client.get("/api/status", as: PanelStatus.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let s):
                    self.status = s
                    self.reachable = true
                case .failure:
                    self.status = nil
                    self.reachable = false
                }
            }
        }
    }

    private func refreshChat() {
        client.get("/api/chat/history", as: PanelChatHistory.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let h) = result {
                    self.chatMessages = h.messages
                    self.chatJobs = h.jobs
                }
            }
        }
    }

    private func refreshJobs() {
        client.get("/api/jobs", as: [PanelJob].self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let j) = result { self.jobs = j }
            }
        }
    }

    private func refreshApprovals() {
        client.get("/api/approvals", as: [PanelApproval].self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let a) = result { self.approvals = a }
            }
        }
        client.get("/api/approvals/history", as: [PanelApprovalHistoryEntry].self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success(let h) = result { self.approvalsHistory = h }
            }
        }
    }
}
