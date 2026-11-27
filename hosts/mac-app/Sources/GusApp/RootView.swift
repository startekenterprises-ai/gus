import SwiftUI

/// The Desktop 1 layout, mapped from the operator's design target:
///
///   [icon rail] [ top bar + section content ] [ tabbed sidebar ]
///
/// Chat is the home screen (the operator's rule #1: never buried).
/// The right sidebar is persistent at full width, like the
/// target's — v0.10.1 gives it tabs (Activity · Approvals ·
/// Identity) where it used to stack identity over approvals —
/// and folds away when the window is shrunk narrow (GUI polish,
/// 2026-11-16; see body). The conversation list is not in a
/// sidebar at all anymore: the top bar's Chats button slides it
/// over the window (v0.10.1, the Muse app's arrangement).
struct RootView: View {
    @StateObject private var model = DesktopModel()
    /// v0.14.0: the Settings section's model, owned here (the
    /// Settings section is part of this window now). Constructing
    /// it is cheap — its load() fires from SettingsRootView's
    /// onAppear, not at app launch.
    @StateObject private var settingsModel = SettingsModel()

    var body: some View {
        // v0.14.5: the launch gate stands in front of the main
        // window — a neutral placeholder until the session
        // readout lands, the login screen while the gate is
        // active, and the window itself once this launch may
        // pass. The frame, polling, and setup-sheet modifiers
        // apply to whichever face is up.
        Group {
            if !model.sessionChecked {
                launchPlaceholder
            } else if model.loginGateActive {
                LoginView(model: model)
            } else {
                mainContent
            }
        }
        .frame(minWidth: 440, idealWidth: 1180, maxWidth: .infinity,
               minHeight: 420, idealHeight: 760, maxHeight: .infinity)
        // v0.14.0 (shell performance): the desktop poll runs
        // only while the root view is on screen.
        .onAppear { model.pollingSuspended = false }
        .onDisappear { model.pollingSuspended = true }
        // v0.8: the first-run setup flow, in the app — auto-shown
        // once by the model when a fresh install can't think yet,
        // and re-openable from the menu or Settings → General.
        .sheet(isPresented: $model.setupPresented) {
            SetupFlowView(model: model)
        }
    }

    /// The launch placeholder: shown for the moment between
    /// the window opening and the session readout landing, so
    /// the main window never flashes ahead of its own gate.
    private var launchPlaceholder: some View {
        VStack(spacing: 10) {
            ProgressView()
            Text("Starting GUS…")
                .font(.callout)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var mainContent: some View {
        // GUI polish (2026-11-16): the window shrinks to a
        // compact, Muse-app-like size now. Below ~780 pt wide
        // the right sidebar folds away — chat stays whole, and
        // nothing is lost that can't be reached: chat-job
        // approvals still surface inline above the composer,
        // the rail's Approvals entry carries the parked count
        // as a badge, and widening the window brings the
        // sidebar back. The floor (440×420, mirrored in
        // MainWindow's minSize) is rail + a usable chat column.
        // v0.11.0: the FLOOR stays, the DEFAULT grows back —
        // with only a min frame, the hosting controller opened
        // the window at the compact floor, and the operator's
        // field report was that the app now opens too small.
        // The ideal size below (the pre-v0.10.0 full three-pane
        // size) is what a fresh window opens at; shrinking to
        // the floor by hand works exactly as before.
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                HStack(spacing: 0) {
                    RailView(model: model)
                    Divider()
                    VStack(spacing: 0) {
                        TopBarView(model: model)
                        Divider()
                        Group {
                            switch model.section {
                            case .chat:
                                ChatView(model: model)
                            case .jobs:
                                JobsView(model: model)
                            case .approvals:
                                ApprovalsView(model: model)
                            case .gateways:
                                GatewaysView(model: model)
                            case .settings:
                                SettingsRootView(
                                    model: settingsModel,
                                    section: settingsSectionBinding
                                )
                            }
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    // v0.14.0: the Settings section needs the
                    // width — its own pane list rides inside it —
                    // so the right sidebar stands down there.
                    if proxy.size.width >= 780 && model.section != .settings {
                        Divider()
                        SidebarView(model: model)
                    }
                }
                if model.chatsPanelPresented {
                    ChatsSlideOver(model: model)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(.easeInOut(duration: 0.18), value: model.chatsPanelPresented)
        }
    }

    /// v0.14.0: the Settings pane selection as the optional
    /// binding SettingsRootView's List wants — the model's
    /// non-optional settingsSection underneath (a nil selection
    /// in the List reads as General, exactly as the old
    /// window's `section ?? .general` did).
    private var settingsSectionBinding: Binding<SettingsSection?> {
        Binding(
            get: { model.settingsSection },
            set: { model.settingsSection = $0 ?? .general }
        )
    }
}

/// The window's top bar: the Chats slide-over toggle, the
/// conversation title, the Call button, and the Invite
/// button. The Call button MOVED here from the composer (GUI
/// polish, 2026-11-16, the operator's layout call — the Muse
/// app's arrangement: Call up top, beside Invite). History,
/// so the next reader doesn't re-litigate it: the top bar's
/// first Call was a disabled Desktop-1 placeholder; v0.9.8
/// unified both bars on one VoiceCallButton; v0.9.9 removed
/// this bar's copy because TWO working Call buttons confused
/// more than they helped. That rule stands — there is still
/// exactly ONE Call button, the same VoiceCallButton, wired
/// to the same action and state. It just lives here now.
/// Invite was the bar's other placeholder (a delegate
/// invite, disabled with its reason) until v0.10.1 made it
/// real on its honest terms: GUS has no accounts, so it
/// shares the public GUS page through the Mac's share sheet
/// (see DesktopModel.invite).
struct TopBarView: View {
    @ObservedObject var model: DesktopModel

    var body: some View {
        HStack(spacing: 10) {
            Button {
                model.chatsPanelPresented.toggle()
            } label: {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 15))
            }
            .buttonStyle(.plain)
            .help("Chats — slide out the conversation list. GUS keeps one durable conversation; this is where it lives, with New chat beside it.")
            Text("Chats")
                .font(.headline)
            Spacer()
            // v0.35.0: the protection shortcut + the DEFCON
            // status, on the main screen (Glenn's direction):
            // how protected this Mac is, at a glance, from its
            // own settings — and one click to the Protection
            // home that shows the whole posture. The badge
            // waits for the first status readout; the button
            // is always there.
            if let status = model.status {
                ProtectionStatusBadge(status: status)
            }
            Button {
                model.settingsSection = .protection
                model.section = .settings
            } label: {
                Label("Protection", systemImage: "shield.fill")
            }
            .buttonStyle(.bordered)
            .help("Protection — the whole posture on one screen: Governor enforcement, the Shield gate, budget, and the rest (Settings → Protection).")
            VoiceCallButton(model: model)
            Button {
                model.invite()
            } label: {
                Label("Invite", systemImage: "person.badge.plus")
            }
            .buttonStyle(.bordered)
            .help("Invite someone to get GUS — opens this Mac's share sheet with a line about GUS and the public page link, to send by Messages, Mail, or AirDrop. GUS has no accounts, so there is nothing to join; the invite points at where to get it.")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

/// The Chats slide-over (v0.10.1 — the operator's layout
/// call, the Muse app's arrangement): the conversation
/// list slides over the window from the top bar's button
/// instead of living in a sidebar, and the sidebar keeps
/// only the icon rail and navigation. Honest contents: the
/// panel keeps ONE durable operator conversation — this
/// window, Telegram, and voice all land in it — so the list
/// is that conversation, shown with its live shape (last
/// words, message count, last activity), plus New chat.
/// Selecting the conversation goes to Chat and closes the
/// panel; a tap on the scrim closes it too.
struct ChatsSlideOver: View {
    @ObservedObject var model: DesktopModel

    var body: some View {
        ZStack(alignment: .leading) {
            Color.black.opacity(0.25)
                .onTapGesture { model.chatsPanelPresented = false }
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Chats")
                        .font(.headline)
                    Spacer()
                    Button {
                        model.chatsPanelPresented = false
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.plain)
                    .help("Close the chat list")
                }
                .padding(12)
                Divider()
                Button {
                    model.section = .chat
                    model.chatsPanelPresented = false
                } label: {
                    conversationRow
                }
                .buttonStyle(.plain)
                .help("Open the conversation — the Chat home screen shows the whole transcript")
                Button {
                    model.newChat()
                    model.chatsPanelPresented = false
                } label: {
                    Label("New chat", systemImage: "square.and.pencil")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .help("New chat — a fresh turn in the same durable conversation, with the composer focused and ready")
                Divider()
                Text("GUS keeps one durable conversation: messages from this window, Telegram, and voice calls all land in it, and the transcript is the record. A new chat is a fresh turn in that conversation, not a separate thread.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(12)
                Spacer()
            }
            .frame(width: 280)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(Color(nsColor: .windowBackgroundColor))
            .shadow(radius: 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .transition(.move(edge: .leading))
    }

    private var conversationRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Current conversation")
                .fontWeight(.semibold)
            if let last = model.chatMessages.last {
                Text(last.text)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
                Text("\(model.chatMessages.count) message\(model.chatMessages.count == 1 ? "" : "s") · last at \(GusFormat.time(last.ts))")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            } else {
                Text("No messages yet — say hello from the Chat screen.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(model.section == .chat ? Color.accentColor.opacity(0.12) : Color.clear)
    }
}

/// The slim icon rail: Chat · Search (Desktop 2, disabled) ·
/// Jobs · Approvals · Gateways · New chat, and at the bottom
/// Check for updates · Menu · Settings. Icon-only, always
/// visible. GUI polish (2026-11-16) brought it to parity with
/// the layout target's rail — under the house rule that every
/// entry is either a real destination/action or an honest
/// disabled placeholder: Approvals opens the queue + history
/// as a section (the same records the right sidebar carries),
/// the download icon runs the app's real Check for Updates,
/// and the hamburger is a menu of real actions (no dead
/// entries anywhere). v0.10.1: every entry's tooltip is a
/// real blurb — what it is and what it does — not the bare
/// name the icon already implies (the operator's field
/// report: the side panel's buttons explained nothing).
struct RailView: View {
    @ObservedObject var model: DesktopModel

    var body: some View {
        VStack(spacing: 8) {
            railButton(symbol: "bubble.left.and.bubble.right", label: "Chat",
                       help: "Chat — the home screen: talk to GUS here. Every message goes through the same scan, caps, and receipts as any channel.",
                       selected: model.section == .chat) {
                model.section = .chat
            }
            // Search is a Desktop 2 feature — present in the layout,
            // disabled with the reason rather than fake-working.
            Button {
            } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 16))
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .disabled(true)
            .help("Search — find a past message or job. Arrives in Desktop 2; today the Chat transcript and the Jobs list are the record.")
            railButton(symbol: "checklist", label: "Jobs",
                       help: "Jobs — everything GUS has run, newest first: state, cost in dollars, outcome, and the settlement receipt for each job.",
                       selected: model.section == .jobs) {
                model.section = .jobs
            }
            // Approvals & history as a section (GUI polish,
            // 2026-11-16): the pending queue and its resolution
            // history, badged with the parked count — which is
            // also what keeps parked approvals visible when the
            // window is narrow and the right sidebar is folded.
            railButton(symbol: "doc.text", label: "Approvals",
                       help: "Approvals — consequential actions parked for your yes or no, with the history of how past ones were resolved. The badge counts what's waiting.",
                       selected: model.section == .approvals,
                       badge: model.approvals.count) {
                model.section = .approvals
            }
            railButton(symbol: "square.grid.2x2", label: "Gateways",
                       help: "Gateways — the connections on file: model provider, the Agent-Shield gate, Telegram, the Mac bridge, delegates, and the Governor's caps.",
                       selected: model.section == .gateways) {
                model.section = .gateways
            }
            Divider()
                .frame(width: 26)
            railButton(symbol: "square.and.pencil", label: "New chat",
                       help: "New chat — jump to Chat with the composer focused, ready for a fresh message.",
                       selected: false) {
                model.newChat()
            }
            Spacer()
            // The layout target's download icon: the app's real
            // Check for Updates — the same notification the
            // Settings → General button posts; the app delegate
            // owns the check (and the install prompt after it).
            railButton(symbol: "arrow.down.circle", label: "Check for updates",
                       help: "Check for updates — ask whether a newer GUS release is out. Nothing installs without your approval.",
                       selected: false) {
                NotificationCenter.default.post(name: .gusCheckForUpdates, object: nil)
            }
            // The bottom hamburger: a menu, and every item in
            // it is a real action the app already has.
            Menu {
                Button("New chat") { model.newChat() }
                Button("Setup guide") {
                    NotificationCenter.default.post(name: .gusRunSetup, object: nil)
                }
                Button("Check for updates") {
                    NotificationCenter.default.post(name: .gusCheckForUpdates, object: nil)
                }
                Button("Settings") {
                    NotificationCenter.default.post(name: .gusOpenSettings, object: nil)
                }
            } label: {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 16))
                    .frame(width: 34, height: 34)
                    .foregroundColor(.secondary)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 34, height: 34)
            .help("Menu — New chat, the setup guide, Check for updates, and Settings.")
            // v0.8: Settings lives in the app now. v0.14.0: the
            // gear selects the Settings section of this window
            // (the app delegate forwards the request to the model).
            railButton(symbol: "gearshape", label: "Settings",
                       help: "Settings — provider and model, the Shield gate, spend caps, Governor and delegation, Telegram, Voice, the Mac bridge, delegates, and data controls.",
                       selected: false) {
                NotificationCenter.default.post(name: .gusOpenSettings, object: nil)
            }
        }
        .padding(.vertical, 10)
        .frame(width: 58)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private func railButton(symbol: String, label: String, help: String, selected: Bool, badge: Int = 0, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 16))
                .frame(width: 34, height: 34)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(selected ? Color.accentColor.opacity(0.22) : Color.clear)
                )
                .foregroundColor(selected ? .accentColor : .secondary)
                .overlay(alignment: .topTrailing) {
                    if badge > 0 {
                        Text("\(badge)")
                            .font(.caption2)
                            .fontWeight(.bold)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.orange))
                            .foregroundColor(.white)
                    }
                }
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(label)
    }
}
