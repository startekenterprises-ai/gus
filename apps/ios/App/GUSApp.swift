import SwiftUI

/// GUS — the unified iPhone app (v0.15.0, "the front door",
/// redo R4). One app, one identity: this replaces the retired
/// companion (apps/companion) and its pairing flow. The phone
/// signs in with the same GUS identity as the Mac, and its
/// front door is a live voice call — see CallView.
@main
struct GUSApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
