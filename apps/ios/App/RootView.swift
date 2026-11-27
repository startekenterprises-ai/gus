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
                // here. Tabs: Chat, Activity, Settings.
                TabView {
                    ChatView()
                        .tabItem { Label("Chat", systemImage: "message") }
                    ActivityView()
                        .tabItem { Label("Activity", systemImage: "list.bullet.rectangle") }
                    SettingsView(model: session)
                        .tabItem { Label("Settings", systemImage: "gearshape") }
                }
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
