import SwiftUI

/// GUS on the wrist (v0.25.0, Watch view v1): a read-only
/// glance — is GUS up, which brain, and what Shield last
/// caught. The Watch holds no credentials and talks to no
/// core: everything it shows arrived from the iPhone as a
/// WatchSnapshot (see WatchShared/WatchSnapshot.swift), and
/// the snapshot's age is printed on its face.
///
/// Approving from the wrist is deliberately NOT here — that
/// gets its own build, with its own care.
@main
struct GUSWatchApp: App {
    var body: some Scene {
        WindowGroup {
            WatchRootView()
        }
    }
}
