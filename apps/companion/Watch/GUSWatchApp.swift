import SwiftUI

/// GUS on the wrist: the two things an operator reaches for away
/// from the desk — "is it alive and in what mode" and "approve or
/// deny the thing it's waiting on." Same panel API, same hash-bound
/// resolutions; the watch holds the same Keychain token (synced by
/// iCloud Keychain when enabled, or entered via the phone app).
@main
struct GUSWatchApp: App {
    var body: some Scene {
        WindowGroup {
            WatchRootView()
        }
    }
}

struct WatchRootView: View {
    var body: some View {
        TabView {
            WatchStatusView()
            WatchApprovalsView()
        }
        .tabViewStyle(.verticalPage)
    }
}
