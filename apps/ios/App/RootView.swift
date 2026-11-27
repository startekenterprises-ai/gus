import SwiftUI

/// The app's root: the launch gate in front, the tabs behind
/// it. Until the core reports a live identity session, the
/// only thing on screen is LoginView — no call, chat, or
/// activity behind it (the Mac app's gate discipline, v0.14.5).
/// One deliberate opening (chunk 2): an install that has signed
/// in before may open OFFLINE when the core is unreachable, so
/// an on-device call works in airplane mode; a never-signed-in
/// install still meets the gate.
struct RootView: View {
    @StateObject private var session = SessionModel()
    @StateObject private var watchBuilder = WatchSnapshotBuilder()
    @Environment(\.scenePhase) private var scenePhase
    @State private var showBrainSetup = false

    var body: some View {
        Group {
            switch session.state {
            case .checking:
                ProgressView("One moment…")
            case .needsConnection, .needsLogin:
                LoginView(model: session)
            case .signedIn, .signedInOffline:
                // Chat is home (v0.29.0, Glenn — Muse's shape):
                // there is no Call tab anymore; the call is a
                // full-screen cover presented from Chat's
                // header phone button, and ending it returns
                // here. v0.30.0: five tabs, Muse's count —
                // the Shield log and the persona picker move
                // out of Settings' depths to the top level.
                // v0.35.0: Settings LEAVES the tab bar — it
                // lives behind Chat's top-left hamburger now
                // (with New Chat and About), so four tabs
                // remain: Chat, Activity, Shield, Personas.
                // The Shield tab is the Shield HUB: the
                // protection controls on top, the log below
                // (ShieldHubView hosts the same ShieldLogView
                // Settings links to). The Settings doors to
                // the log and the picker stay where they were.
                //
                // Tab-bar visibility (v0.32.0): nothing in
                // this app ever asks to hide the bar — no
                // toolbar placement, no appearance hack —
                // yet on 0.30.0+ it sometimes vanished and
                // only a fresh presentation cycle (Glenn's
                // photo-picker open-and-cancel) brought it
                // back. The bar is the floating iOS 26-style
                // bar, which the system minimizes
                // contextually; after the call's
                // full-screen cover (or a stack of sheets)
                // dismisses, that minimized state can stick
                // instead of restoring, and a new
                // presentation forces the toolbar
                // reconciliation that unsticks it — which is
                // exactly why the picker trick worked. The
                // fix pins both ends: the TabView refuses
                // contextual minimizing outright (iOS 26+;
                // older systems have no minimize behavior
                // to refuse), and every tab root asserts the
                // bar visible, so whichever tab the operator
                // returns to re-asserts it the moment a
                // presentation leaves it hidden. The
                // assertions live here, on the four roots —
                // the only places they're set, on purpose.
                TabView {
                    ChatView(session: session)
                        .toolbar(.visible, for: .tabBar)
                        .tabItem { Label("Chat", systemImage: "message") }
                    ActivityView()
                        .toolbar(.visible, for: .tabBar)
                        .tabItem { Label("Activity", systemImage: "list.bullet.rectangle") }
                    NavigationStack {
                        ShieldHubView()
                    }
                    .toolbar(.visible, for: .tabBar)
                    .tabItem { Label("Shield", systemImage: "shield") }
                    NavigationStack {
                        PersonaPickerView()
                            .navigationTitle("Personas")
                            .navigationBarTitleDisplayMode(.inline)
                    }
                    .toolbar(.visible, for: .tabBar)
                    .tabItem { Label("Personas", systemImage: "person.2") }
                }
                .tabBarNeverMinimizes()
                // Kokoro prepares itself (Glenn, 2026-11-20 —
                // no "Prepare voice" tap): warm-up starts the
                // moment the signed-in shell opens, on the
                // offline gate too, so the voice is ready
                // before the first call. warmUp() is idempotent.
                .onAppear {
                    KokoroRuntime.shared.warmUp()
                    // First-launch brain setup (v0.21.0): a
                    // phone with NO brain on it gets the
                    // friendly download prompt the moment the
                    // shell opens — nobody should have to hunt
                    // Settings for it (Glenn, 2026-11-27). A
                    // phone with any brain never sees it.
                    if !ActiveBrain.anyPresent {
                        showBrainSetup = true
                    }
                }
                .sheet(isPresented: $showBrainSetup) {
                    BrainSetupSheet()
                }
            }
        }
        .task {
            if session.state == .checking {
                await session.refresh()
            }
            // Watch view v1 (v0.25.0): keep the wrist's
            // snapshot fresh from the moment the app opens —
            // the builder folds the Shield highlights cache
            // incrementally and republishes on state changes,
            // foregrounding, and a slow timer.
            watchBuilder.start { session.state }
        }
        .onChange(of: session.state) { _, _ in
            watchBuilder.refreshNow()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                watchBuilder.refreshNow()
            }
        }
    }
}

/// The TabView half of the v0.32.0 tab-bar fix (see the
/// TabView comment in RootView): the floating bar's
/// contextual minimize behavior is iOS 26's, and the app
/// deploys to iOS 17, so the refusal is availability-
/// wrapped — on older systems there is no minimize
/// behavior and the modifier is a pass-through. `.never`
/// is the whole point: the bar is this app's way home,
/// and it does not get to wander off on scroll or after a
/// presentation dismisses.
private struct TabBarNeverMinimizes: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.tabBarMinimizeBehavior(.never)
        } else {
            content
        }
    }
}

extension View {
    fileprivate func tabBarNeverMinimizes() -> some View {
        modifier(TabBarNeverMinimizes())
    }
}
