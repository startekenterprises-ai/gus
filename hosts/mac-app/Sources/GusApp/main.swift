import AppKit

/// GUS.app (Phase 8) — the menu-bar shell around the resident GUS.
///
/// It is deliberately thin: the brains live in the control plane
/// (Node, launchd) and the hands live in GusMacHost, which this app
/// launches from inside the bundle so the Accessibility and Screen
/// Recording grants the operator gives GUS.app cover the helper.
/// This process owns presence (menu bar), the first-run permissions
/// window, and Start/Stop of the two launchd agents.
let app = NSApplication.shared
let delegate = GusAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
