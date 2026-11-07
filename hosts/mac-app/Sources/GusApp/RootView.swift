import SwiftUI

/// The Desktop 1 layout, mapped from the operator's design target:
///
///   [icon rail] [ top bar + section content ] [ identity + approvals ]
///
/// Chat is the home screen (the operator's rule #1: never buried).
/// The right sidebar is persistent, like the target's: GUS's
/// identity and live status over the Approvals queue and its
/// resolution history.
struct RootView: View {
    @StateObject private var model = DesktopModel()

    var body: some View {
        HStack(spacing: 0) {
            RailView(model: model)
            Divider()
            VStack(spacing: 0) {
                TopBarView()
                Divider()
                Group {
                    switch model.section {
                    case .chat:
                        ChatView(model: model)
                    case .jobs:
                        JobsView(model: model)
                    case .gateways:
                        GatewaysView(model: model)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            SidebarView(model: model)
        }
        .frame(minWidth: 980, minHeight: 620)
        // v0.8: the first-run setup flow, in the app — auto-shown
        // once by the model when a fresh install can't think yet,
        // and re-openable from the menu or Settings → General.
        .sheet(isPresented: $model.setupPresented) {
            SetupFlowView(model: model)
        }
    }
}

/// The window's top bar: the conversation title, plus the Call and
/// Invite buttons the layout target has. Both are DISABLED with an
/// explanation — visible because the layout calls for them, honest
/// because they do not pretend to work before their builds land.
struct TopBarView: View {
    var body: some View {
        HStack(spacing: 10) {
            Text("Chats")
                .font(.headline)
            Spacer()
            Button {
            } label: {
                Label("Call", systemImage: "phone")
            }
            .disabled(true)
            .help("Voice calls arrive with the Call GUS build — this button is a placeholder until then.")
            Button {
            } label: {
                Label("Invite", systemImage: "person.badge.plus")
            }
            .disabled(true)
            .help("Delegate invites arrive in Desktop 3 — delegates are named in ~/.gus/state/delegates.json today (see Settings → Delegates).")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

/// The slim icon rail: Chat · Search (Desktop 2, disabled) · Jobs ·
/// Gateways · New chat. Icon-only, always visible.
struct RailView: View {
    @ObservedObject var model: DesktopModel

    var body: some View {
        VStack(spacing: 14) {
            railButton(symbol: "bubble.left.and.bubble.right", label: "Chat",
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
            .help("Search arrives in Desktop 2")
            railButton(symbol: "checklist", label: "Jobs",
                       selected: model.section == .jobs) {
                model.section = .jobs
            }
            railButton(symbol: "square.grid.2x2", label: "Gateways",
                       selected: model.section == .gateways) {
                model.section = .gateways
            }
            Divider()
                .frame(width: 26)
            railButton(symbol: "square.and.pencil", label: "New chat",
                       selected: false) {
                model.newChat()
            }
            Spacer()
            // v0.8: Settings lives in the app now — the gear opens
            // the native Settings window (the app delegate owns it).
            railButton(symbol: "gearshape", label: "Settings",
                       selected: false) {
                NotificationCenter.default.post(name: .gusOpenSettings, object: nil)
            }
        }
        .padding(.vertical, 14)
        .frame(width: 58)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private func railButton(symbol: String, label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 16))
                .frame(width: 34, height: 34)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(selected ? Color.accentColor.opacity(0.22) : Color.clear)
                )
                .foregroundColor(selected ? .accentColor : .secondary)
        }
        .buttonStyle(.plain)
        .help(label)
    }
}
