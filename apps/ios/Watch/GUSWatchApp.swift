import SwiftUI

/// GUS on the wrist (v0.25.0, Watch view v1): a glance —
/// is GUS up, which brain, and what Shield last caught.
/// The Watch holds no credentials and talks to no core:
/// everything it shows arrived from the iPhone as a
/// WatchSnapshot (see WatchShared/WatchSnapshot.swift), and
/// the snapshot's age is printed on its face.
///
/// v0.27.0 adds the one action this surface takes:
/// resolving parked approvals. Even that goes through the
/// iPhone — the wrist sends the decision to the phone, the
/// phone resolves it through the core's own approval path
/// (which re-validates everything), and the row shows the
/// core's answer. Approvals only: no job control lives here.
@main
struct GUSWatchApp: App {
    var body: some Scene {
        WindowGroup {
            WatchRootView()
        }
    }
}
