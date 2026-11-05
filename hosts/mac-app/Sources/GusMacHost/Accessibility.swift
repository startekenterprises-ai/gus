import AppKit
import ApplicationServices
import Foundation

/// Accessibility helpers for GusMacHost: front-app state, a bounded
/// tree walk in the contract's text form, element search by label,
/// and focus/raise. Everything here reads the FRONT app only — the
/// pack drives the desktop the operator is looking at, not every
/// app's private tree.

func axAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let value = axAttribute(element, attribute) as? String, !value.isEmpty else { return nil }
    return value
}

func axElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    guard let value = axAttribute(element, attribute) else { return nil }
    guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    guard let value = axAttribute(element, kAXChildrenAttribute as String) as? [AXUIElement] else {
        return []
    }
    return value
}

/// The human-facing label of an element: title, else description,
/// else a string value, else the identifier. This is the name the
/// agent clicks by and the name observe reports.
func elementLabel(_ element: AXUIElement) -> String? {
    if let title = axString(element, kAXTitleAttribute as String) { return title }
    if let desc = axString(element, kAXDescriptionAttribute as String) { return desc }
    if let value = axAttribute(element, kAXValueAttribute as String) as? String, !value.isEmpty {
        return value
    }
    if let ident = axString(element, kAXIdentifierAttribute as String) { return ident }
    return nil
}

struct FrontApp {
    let running: NSRunningApplication
    let element: AXUIElement
    var name: String { running.localizedName ?? running.bundleIdentifier ?? "unknown" }
}

func frontApp() -> FrontApp? {
    guard let running = NSWorkspace.shared.frontmostApplication else { return nil }
    return FrontApp(running: running, element: AXUIElementCreateApplication(running.processIdentifier))
}

func focusedWindow(of appElement: AXUIElement) -> AXUIElement? {
    axElement(appElement, kAXFocusedWindowAttribute as String)
}

func focusedElement(of appElement: AXUIElement) -> AXUIElement? {
    axElement(appElement, kAXFocusedUIElementAttribute as String)
}

/// Bounded depth-first walk of the front app's tree, rendered one
/// element per line as `role "label"` (indented by depth) — the
/// text form MacService shows the model after the Shield gate.
/// Bounds keep a pathological app from producing a pathological
/// observation: depth 8, 400 nodes.
func treeText(of root: AXUIElement) -> String {
    var lines: [String] = []
    var budget = 400
    func walk(_ element: AXUIElement, depth: Int) {
        guard budget > 0, depth <= 8 else { return }
        budget -= 1
        let role = axString(element, kAXRoleAttribute as String) ?? "element"
        let indent = String(repeating: "  ", count: depth)
        if let label = elementLabel(element) {
            lines.append("\(indent)\(role) \"\(label)\"")
        } else {
            lines.append("\(indent)\(role)")
        }
        for child in axChildren(element) {
            walk(child, depth: depth + 1)
        }
    }
    walk(root, depth: 0)
    return lines.joined(separator: "\n")
}

/// First element (depth-first, same bounds as the walk) whose label
/// matches exactly. The agent names elements from observe output, so
/// the search reads the same labels the walk prints.
func findElement(in root: AXUIElement, label target: String) -> AXUIElement? {
    var budget = 2000
    func search(_ element: AXUIElement, depth: Int) -> AXUIElement? {
        guard budget > 0, depth <= 10 else { return nil }
        budget -= 1
        if elementLabel(element) == target { return element }
        for child in axChildren(element) {
            if let hit = search(child, depth: depth + 1) { return hit }
        }
        return nil
    }
    return search(root, depth: 0)
}

/// True when the front app currently shows a sheet or a dialog
/// window — the precondition for pickerSelect being meaningful.
func frontAppHasDialog(_ appElement: AXUIElement) -> Bool {
    if let sheets = axAttribute(appElement, "AXSheets") as? [AXUIElement], !sheets.isEmpty {
        return true
    }
    let windows = axAttribute(appElement, kAXWindowsAttribute as String) as? [AXUIElement] ?? []
    for window in windows {
        let subrole = axString(window, kAXSubroleAttribute as String) ?? ""
        if subrole.contains("Dialog") { return true }
        if let sheets = axAttribute(window, "AXSheets") as? [AXUIElement], !sheets.isEmpty {
            return true
        }
    }
    return false
}

enum HostError: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self {
        case .message(let text): return text
        }
    }
}

func requireAccessibility() throws {
    guard AXIsProcessTrusted() else {
        throw HostError.message(
            "Accessibility permission is not granted to GUS — enable GUS in System Settings > Privacy & Security > Accessibility, then retry"
        )
    }
}
