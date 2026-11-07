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
        window.minSize = NSSize(width: 980, height: 620)
        super.init(window: window)
        window.contentViewController = NSHostingController(rootView: RootView())
        window.center()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("programmatic window only") }

    func show() {
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}
