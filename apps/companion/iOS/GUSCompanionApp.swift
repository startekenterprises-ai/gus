import SwiftUI

/// GUS Companion — the operator's pocket surface for their own GUS:
/// status at a glance, approvals on the go (the same hash-bound
/// resolutions the panel and Telegram perform), the Governor mode,
/// and the kill switch. It holds no credentials of GUS's — only the
/// panel token, in the Keychain.
@main
struct GUSCompanionApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
