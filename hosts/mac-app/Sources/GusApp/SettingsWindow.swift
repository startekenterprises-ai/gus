import AppKit
import SwiftUI

/// The Settings window (v0.8, Desktop 2) — Glenn's direction:
/// setup and settings move out of the files and the web panel
/// and into the app, in the Muse app's settings shape (a section
/// sidebar, one pane per area).
///
/// It is a SURFACE MOVE, nothing more: every control is a call to
/// the same local panel API the web panel and wizard already use
/// (onboarding endpoints for provider/caps/Telegram, /api/kill,
/// /api/governor-mode, /api/approver-policy, /api/shield-policy).
/// Same settings, same landings (vault, Governor, policy file),
/// new home. The app stores nothing itself; API keys exist only
/// in the SecureField's memory between paste and save, and are
/// cleared on save.
final class SettingsWindowController: NSWindowController {
    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "GUS Settings"
        window.minSize = NSSize(width: 860, height: 580)
        super.init(window: window)
        window.contentViewController = NSHostingController(rootView: SettingsRootView())
        window.center()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("programmatic window only") }

    func show() {
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}

enum SettingsSection: String, CaseIterable, Identifiable {
    case general, provider, shield, caps, governor, telegram, macBridge, delegates, dataControls, help

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: return "General"
        case .provider: return "Provider & model"
        case .shield: return "Agent-Shield gate"
        case .caps: return "Spend caps"
        case .governor: return "Governor & delegation"
        case .telegram: return "Telegram"
        case .macBridge: return "Mac bridge"
        case .delegates: return "Delegates"
        case .dataControls: return "Data controls"
        case .help: return "Help & support"
        }
    }

    var symbol: String {
        switch self {
        case .general: return "gearshape"
        case .provider: return "cpu"
        case .shield: return "shield"
        case .caps: return "dollarsign.circle"
        case .governor: return "slider.horizontal.3"
        case .telegram: return "paperplane"
        case .macBridge: return "desktopcomputer"
        case .delegates: return "person.2"
        case .dataControls: return "folder"
        case .help: return "questionmark.circle"
        }
    }
}

/// The Settings window's store: one load of the panel's read
/// models (status, onboarding, help registry, settings detail)
/// plus the editable drafts the panes bind to. Drafts seed once
/// from what is on file; a save posts the panel's own endpoint
/// and reloads, so the pane always ends up showing the panel's
/// answer — including its refusal text, verbatim, as the notice.
final class SettingsModel: ObservableObject {
    @Published var status: PanelStatus?
    @Published var onboarding: PanelOnboarding?
    @Published var helpEntries: [PanelHelpEntry] = []
    @Published var detail: PanelSettingsDetail?
    @Published var notice: String?
    @Published var reachable = false

    // Drafts (seeded once from what is on file).
    @Published var providerId = "gemini"
    @Published var modelName = ""
    @Published var apiKey = ""
    @Published var baseUrl = ""
    @Published var shieldRequired = true
    @Published var shieldFailMode = "closed"
    @Published var capTask = ""
    @Published var capDay = ""
    @Published var capMonth = ""
    @Published var delGusDelegates = false
    @Published var delGusOwn = false
    @Published var delDelegates = false
    @Published var delScope = "bounded"
    @Published var delMax = "30"
    @Published var tgToken = ""

    let client = PanelClient()
    private var seeded = false

    var helpById: [String: PanelHelpEntry] {
        Dictionary(uniqueKeysWithValues: helpEntries.map { ($0.id, $0) })
    }

    func help(_ id: String) -> PanelHelpEntry? { helpById[id] }

    func load() {
        client.get("/api/status", as: PanelStatus.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let s):
                    self.status = s
                    self.reachable = true
                    self.seed(from: s)
                case .failure:
                    self.status = nil
                    self.reachable = false
                }
            }
        }
        client.get("/api/onboarding", as: PanelOnboarding.self) { [weak self] result in
            DispatchQueue.main.async {
                if case .success(let o) = result { self?.onboarding = o }
            }
        }
        client.get("/api/help", as: PanelHelpResponse.self) { [weak self] result in
            DispatchQueue.main.async {
                if case .success(let h) = result { self?.helpEntries = h.entries }
            }
        }
        client.get("/api/settings-detail", as: PanelSettingsDetail.self) { [weak self] result in
            DispatchQueue.main.async {
                if case .success(let d) = result { self?.detail = d }
            }
        }
    }

    private func seed(from s: PanelStatus) {
        guard !seeded else { return }
        seeded = true
        providerId = s.provider.id
        modelName = s.provider.model
        shieldRequired = s.shield.required
        shieldFailMode = s.shield.onUnavailable
        let caps = s.settings.caps
        capTask = caps.maxUsdPerTask.map(trimNum) ?? ""
        capDay = caps.maxUsdPerDay.map(trimNum) ?? ""
        capMonth = caps.maxUsdPerMonth.map(trimNum) ?? ""
        let p = s.settings.approverPolicy
        delGusDelegates = p.gusApprovesDelegates
        delGusOwn = p.gusApprovesOwn
        delDelegates = p.delegatesMayApprove
        delScope = p.scope
        delMax = String(p.maxApprovalsPerHour)
    }

    func trimNum(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(v)
    }

    /// One settings action: POST the panel endpoint, surface its
    /// detail verbatim (success or refusal), then reload so the
    /// pane reflects what is actually on file.
    func act(_ path: String, body: [String: Any] = [:]) {
        client.post(path, jsonBody: body) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let r):
                    self.notice = r.detail
                case .failure(let e):
                    self.notice = "Could not reach the panel: \(e.localizedDescription)"
                }
                self.load()
            }
        }
    }

    // MARK: Actions (one per control; all panel endpoints)

    func saveProvider() {
        var body: [String: Any] = ["provider": providerId, "model": modelName]
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !key.isEmpty { body["apiKey"] = key }
        let base = baseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        if !base.isEmpty { body["baseUrl"] = base }
        apiKey = "" // the field never keeps a key after a save attempt
        act("/api/onboarding/provider", body: body)
    }

    func saveShieldPolicy() {
        act("/api/shield-policy", body: ["required": shieldRequired, "onUnavailable": shieldFailMode])
    }

    func provisionShield() {
        act("/api/onboarding/shield", body: ["onUnavailable": shieldFailMode])
    }

    func saveCaps() {
        let ob = onboarding?.suggestedCaps
        act("/api/onboarding/caps", body: [
            "maxUsdPerTask": Double(capTask) ?? ob?.maxUsdPerTask ?? 2,
            "maxUsdPerDay": Double(capDay) ?? ob?.maxUsdPerDay ?? 10,
            "maxUsdPerMonth": Double(capMonth) ?? ob?.maxUsdPerMonth ?? 100,
        ])
    }

    func setMode(_ mode: String) {
        act("/api/governor-mode", body: ["mode": mode])
    }

    func saveDelegation() {
        act("/api/approver-policy", body: [
            "gusApprovesDelegates": delGusDelegates,
            "gusApprovesOwn": delGusOwn,
            "delegatesMayApprove": delDelegates,
            "scope": delScope,
            "maxApprovalsPerHour": Int(delMax) ?? 30,
        ])
    }

    func saveTelegram() {
        let token = tgToken.trimmingCharacters(in: .whitespacesAndNewlines)
        tgToken = ""
        act("/api/onboarding/telegram", body: ["token": token])
    }

    func setKilled(_ on: Bool) {
        act("/api/kill", body: ["on": on])
    }

    func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    func openPanelPage(_ path: String) {
        NSWorkspace.shared.open(client.panelURL(path))
    }
}

/// The registry's native face: a "?" beside a control; tapping it
/// shows the entry's tip and docs body from GET /api/help — the
/// same text as the web panel's pop-ups, fetched, never copied
/// into Swift. Renders nothing until the registry has loaded and
/// only for ids the registry actually carries.
struct HelpMark: View {
    let entry: PanelHelpEntry?
    @State private var shown = false

    var body: some View {
        if let entry {
            Button {
                shown.toggle()
            } label: {
                Image(systemName: "questionmark.circle")
                    .foregroundColor(.secondary)
            }
            .buttonStyle(.plain)
            .help("What this does")
            .popover(isPresented: $shown, arrowEdge: .trailing) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(entry.title)
                        .font(.headline)
                    Text(entry.tip)
                        .font(.callout)
                    Divider()
                    ScrollView {
                        Text(entry.body)
                            .font(.callout)
                            .foregroundColor(.secondary)
                    }
                    .frame(maxHeight: 240)
                }
                .padding(14)
                .frame(width: 360)
            }
        }
    }
}

/// The window: a section sidebar (Muse-settings shape) + the
/// selected pane, with the last action's outcome pinned under the
/// pane — the panel's own words, so a refusal is never silent.
struct SettingsRootView: View {
    @StateObject private var model = SettingsModel()
    @State private var section: SettingsSection? = .general

    var body: some View {
        HStack(spacing: 0) {
            List(selection: $section) {
                ForEach(SettingsSection.allCases) { s in
                    Label(s.title, systemImage: s.symbol)
                        .tag(s)
                }
            }
            .listStyle(.sidebar)
            .frame(width: 230)

            Divider()

            VStack(spacing: 0) {
                ScrollView {
                    Group {
                        switch section ?? .general {
                        case .general: SettingsGeneralView(model: model)
                        case .provider: SettingsProviderView(model: model)
                        case .shield: SettingsShieldView(model: model)
                        case .caps: SettingsCapsView(model: model)
                        case .governor: SettingsGovernorView(model: model)
                        case .telegram: SettingsTelegramView(model: model)
                        case .macBridge: SettingsMacBridgeView(model: model)
                        case .delegates: SettingsDelegatesView(model: model)
                        case .dataControls: SettingsDataView(model: model)
                        case .help: SettingsHelpView(model: model)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
                }
                if let notice = model.notice {
                    Divider()
                    Text(notice)
                        .font(.callout)
                        .foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 860, minHeight: 580)
        .onAppear { model.load() }
    }
}

/// Shared pane furniture: a titled row with an optional help mark,
/// and a plain value row.
struct SettingsRow: View {
    let title: String
    let value: String
    var help: PanelHelpEntry? = nil

    var body: some View {
        HStack(spacing: 6) {
            Text(title)
                .fontWeight(.medium)
            HelpMark(entry: help)
            Spacer()
            Text(value)
                .foregroundColor(.secondary)
        }
    }
}

struct SettingsPaneTitle: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.title2)
            .fontWeight(.semibold)
            .padding(.bottom, 4)
    }
}
