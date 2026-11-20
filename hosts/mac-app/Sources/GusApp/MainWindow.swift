import AppKit
import SwiftUI

/// The main GUS window (v0.7, Desktop 1): a real application
/// window, hosted SwiftUI over the panel APIs. The app keeps its
/// menu-bar presence and every menu behavior (status, Start/Stop,
/// Governor mode, updates, kill paths) — the window is the front
/// door, not a replacement for them.
final class MainWindowController: NSWindowController {
    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "GUS"
        // GUI polish (2026-11-16): the floor is a compact
        // chat-only size now — RootView folds the right sidebar
        // away below ~780 pt wide, so the window can shrink to
        // a Muse-app-like footprint instead of stopping at the
        // full three-pane width. Keep in step with RootView's
        // .frame(minWidth:minHeight:).
        window.minSize = NSSize(width: 440, height: 420)
        super.init(window: window)
        window.contentViewController = NSHostingController(rootView: RootView())
        // v0.11.0: pin the DEFAULT launch size explicitly. The
        // contentRect above asks for 1180×760, but a hosting
        // controller sizes its window to the SwiftUI view's
        // fitting size on first layout — and with the v0.10.0
        // floor at 440×420 that is what a fresh window opened
        // at (the operator's report: the app opens too small).
        // Setting the content size after the controller is in
        // place makes the default the pre-v0.10.0 three-pane
        // size again; RootView's ideal size says the same to
        // SwiftUI. The 440×420 floor is untouched — small is
        // still one drag away, it is just not the default.
        window.setContentSize(NSSize(width: 1180, height: 760))
        window.center()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("programmatic window only") }

    func show() {
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}
