import AppKit

/// GUS.app (Phase 8; Desktop 1 in v0.7) — the Mac face of the
/// resident GUS: a real desktop window (chat-first, with the
/// approvals sidebar) plus the menu-bar presence it has always had.
///
/// It is deliberately thin: the brains live in the control plane
/// (Node, launchd) and the hands live in GusMacHost, which this app
/// launches from inside the bundle so the Accessibility and Screen
/// Recording grants the operator gives GUS.app cover the helper.
/// This process owns presence (window + menu bar), the first-run
/// permissions window, and Start/Stop of the two launchd agents.
/// The window is a surface over the local panel APIs — it holds no
/// authority of its own.
let app = NSApplication.shared
let delegate = GusAppDelegate()
app.delegate = delegate
// .regular: a Dock presence and a real window. (Pre-Desktop 1 the
// app ran .accessory as a menu-bar-only resident.)
app.setActivationPolicy(.regular)
app.run()
