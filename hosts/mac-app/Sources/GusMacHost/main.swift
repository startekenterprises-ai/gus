import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

/// GusMacHost — the native hands of GUS on the resident Mac
/// (Phase 8). A long-lived helper, launched by GUS.app from inside
/// the bundle (so the Accessibility and Screen Recording grants
/// attach to GUS.app), speaking newline-delimited JSON over a unix
/// socket:
///
///   ~/.gus/comm/mac-host.sock   (0600; override GUS_MAC_HOST_SOCKET)
///
///   request:  {"id": 1, "method": "click", "params": {"element": "Save"}}
///   response: {"id": 1, "ok": true, "result": "clicked element \"Save\""}
///           | {"id": 1, "ok": false, "error": "..."}
///
/// Methods map 1:1 to the Node adapter (packages/control-plane/src/
/// mac-native.ts): observe, probe, click, type, key, scroll,
/// openApp, focusWindow, pickerSelect. Files and shell never come
/// here — the control plane executes those itself on this host.
///
/// Mutating methods return EXACTLY the canonical receipt strings of
/// macActionReceipt (packages/control-plane/src/mac.ts). The service
/// compares the receipt to the action it requested; a drift here is
/// a failed-loudly job there, by design. The protocol tests
/// (test/fixtures/mock-mac-host.mjs) pin the same strings.

// MARK: - Receipts (canonical — mirror macActionReceipt in mac.ts)

/// Format a JSON number the way JS String(number) would for the
/// values this protocol carries (integral values print bare).
func fmtNum(_ value: Any?) -> String {
    guard let number = value as? NSNumber else { return "?" }
    let d = number.doubleValue
    if d == d.rounded() && abs(d) < 1e15 { return String(Int64(d)) }
    return String(d)
}

func stringParam(_ params: [String: Any], _ key: String) -> String? {
    guard let value = params[key] as? String, !value.isEmpty else { return nil }
    return value
}

// MARK: - Helper state

/// The last path this process selected in a file dialog. probe
/// reports it so MacService can verify a picker.select landed;
/// there is no AX attribute for "the picker's selection" once the
/// dialog closes, so the helper remembers what it did.
var pickerSelection: String?

// MARK: - Screenshot (ScreenCaptureKit, macOS 14+)

func screenshotBase64PNG() -> String? {
    guard CGPreflightScreenCaptureAccess() else { return nil }
    var encoded: String?
    let semaphore = DispatchSemaphore(value: 0)
    Task {
        defer { semaphore.signal() }
        guard
            let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true),
            let display = content.displays.first
        else { return }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
        config.showsCursor = false
        guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        else { return }
        let rep = NSBitmapImageRep(cgImage: image)
        if let data = rep.representation(using: .png, properties: [:]) {
            encoded = data.base64EncodedString()
        }
    }
    _ = semaphore.wait(timeout: .now() + 5)
    return encoded
}

// MARK: - Method handlers

func handleObserve() throws -> [String: Any] {
    try requireAccessibility()
    guard let front = frontApp() else {
        throw HostError.message("no frontmost application to observe")
    }
    var result: [String: Any] = [
        "app": front.name,
        "text": treeText(of: front.element),
    ]
    if let window = focusedWindow(of: front.element), let title = axString(window, kAXTitleAttribute as String) {
        result["windowTitle"] = title
    }
    if let focused = focusedElement(of: front.element), let label = elementLabel(focused) {
        result["focusedElement"] = label
    }
    // Optional: present only when Screen Recording is granted. The
    // service contract's text form is unchanged either way.
    if let shot = screenshotBase64PNG() {
        result["screenshotPngBase64"] = shot
    }
    return result
}

func handleProbe() -> [String: Any] {
    var result: [String: Any] = [:]
    if let front = frontApp() {
        result["frontApp"] = front.name
        if let window = focusedWindow(of: front.element), let title = axString(window, kAXTitleAttribute as String) {
            result["windowTitle"] = title
        }
        if let focused = focusedElement(of: front.element), let label = elementLabel(focused) {
            result["focusedElement"] = label
        }
    } else {
        result["frontApp"] = ""
    }
    if let selection = pickerSelection {
        result["pickerSelection"] = selection
    }
    return result
}

func handleClick(params: [String: Any]) throws -> String {
    try requireAccessibility()
    if let label = stringParam(params, "element") {
        guard let front = frontApp() else {
            throw HostError.message("no frontmost application to click in")
        }
        guard let element = findElement(in: front.element, label: label) else {
            throw HostError.message("no element labeled \"\(label)\" is visible in the front app (\"\(front.name)\")")
        }
        let action = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard action == .success else {
            throw HostError.message("the element \"\(label)\" refused AXPress (error \(action.rawValue))")
        }
        return "clicked element \"\(label)\""
    }
    guard let x = params["x"] as? NSNumber, let y = params["y"] as? NSNumber else {
        throw HostError.message("click needs an element label or an x/y point")
    }
    try clickAtPoint(x: x.doubleValue, y: y.doubleValue)
    return "clicked point (\(fmtNum(x)), \(fmtNum(y)))"
}

func handleType(params: [String: Any]) throws -> String {
    try requireAccessibility()
    let text = params["text"] as? String ?? ""
    try typeUnicode(text)
    // JS .length counts UTF-16 units — match it exactly.
    return "typed \(text.utf16.count) chars"
}

func handleKey(params: [String: Any]) throws -> String {
    try requireAccessibility()
    let combo = stringParam(params, "combo") ?? stringParam(params, "key") ?? ""
    guard !combo.isEmpty else { throw HostError.message("key needs a combo (e.g. \"cmd+enter\")") }
    try postKeyCombo(combo)
    return "pressed \(combo)"
}

func handleScroll(params: [String: Any]) throws -> String {
    try requireAccessibility()
    let direction = stringParam(params, "direction") ?? "down"
    let amount = params["amount"] as? NSNumber ?? 3
    try scroll(direction: direction, amount: amount.intValue)
    return "scrolled \(direction) by \(fmtNum(amount))"
}

func applicationURL(for name: String) -> URL? {
    if let byBundle = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) {
        return byBundle
    }
    let fileManager = FileManager.default
    let searchDirs = ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"]
    for dir in searchDirs {
        let candidate = "\(dir)/\(name).app"
        if fileManager.fileExists(atPath: candidate) { return URL(fileURLWithPath: candidate) }
        // Case-insensitive display-name match within the folder.
        if let entries = try? fileManager.contentsOfDirectory(atPath: dir) {
            for entry in entries where entry.lowercased() == "\(name).app".lowercased() {
                return URL(fileURLWithPath: "\(dir)/\(entry)")
            }
        }
    }
    return nil
}

func handleOpenApp(params: [String: Any]) throws -> String {
    let app = stringParam(params, "app") ?? ""
    guard !app.isEmpty else { throw HostError.message("openApp needs an app name") }
    guard let url = applicationURL(for: app) else {
        throw HostError.message("application \"\(app)\" was not found in /Applications or by bundle id")
    }
    var failure: String?
    let semaphore = DispatchSemaphore(value: 0)
    NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
        if let error { failure = error.localizedDescription }
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 10)
    if let failure { throw HostError.message("opening \"\(app)\" failed: \(failure)") }
    // Activate and give it a moment to come front — MacService
    // verifies front-app state with probe, and a slow launch should
    // not read as a failed open when it is merely still starting.
    if let running = NSWorkspace.shared.runningApplications.first(where: {
        $0.bundleURL == url || $0.localizedName == app
    }) {
        running.activate(options: [.activateIgnoringOtherApps])
        for _ in 0..<20 {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier { break }
            usleep(100_000)
        }
    }
    return "opened \"\(app)\""
}

func handleFocusWindow(params: [String: Any]) throws -> String {
    try requireAccessibility()
    let appName = stringParam(params, "app")
    let title = stringParam(params, "title")
    guard appName != nil || title != nil else {
        throw HostError.message("focusWindow needs an app and/or a window title")
    }
    let front = frontApp()
    let running: NSRunningApplication?
    if let appName {
        running = NSWorkspace.shared.runningApplications.first(where: {
            $0.localizedName == appName || $0.bundleIdentifier == appName
        }) ?? (front?.name == appName ? front?.running : nil)
    } else {
        running = front?.running
    }
    guard let target = running else {
        throw HostError.message("application \"\(appName ?? "")\" is not running")
    }
    target.activate(options: [.activateIgnoringOtherApps])
    if let title {
        let appElement = AXUIElementCreateApplication(target.processIdentifier)
        let windows = axAttribute(appElement, kAXWindowsAttribute as String) as? [AXUIElement] ?? []
        guard let window = windows.first(where: { axString($0, kAXTitleAttribute as String) == title }) else {
            throw HostError.message("application \"\(target.localizedName ?? appName ?? "")\" has no window titled \"\(title)\"")
        }
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        return "focused window \"\(title)\""
    }
    return "focused app \"\(appName ?? target.localizedName ?? "")\""
}

func handlePickerSelect(params: [String: Any]) throws -> String {
    try requireAccessibility()
    let path = stringParam(params, "path") ?? ""
    guard !path.isEmpty else { throw HostError.message("pickerSelect needs a path") }
    guard let front = frontApp() else {
        throw HostError.message("no frontmost application — no file dialog to drive")
    }
    guard frontAppHasDialog(front.element) else {
        throw HostError.message("no file dialog is open in the front app (\"\(front.name)\") — picker.select drives an open panel; nothing was selected")
    }
    // Go to the path (Cmd+Shift+G opens the path field in open
    // panels), type it, confirm with Return, then press the dialog's
    // Open button by AX when it is there to press.
    try postKeyCombo("cmd+shift+g")
    usleep(400_000)
    try typeUnicode(path)
    try postKeyCombo("return")
    usleep(500_000)
    if let refreshed = frontApp(), let openButton = findElement(in: refreshed.element, label: "Open") {
        AXUIElementPerformAction(openButton, kAXPressAction as CFString)
        usleep(300_000)
    }
    pickerSelection = path
    return "selected \"\(path)\""
}

// MARK: - Dispatch

func dispatch(method: String, params: [String: Any]) throws -> Any {
    switch method {
    case "observe": return try handleObserve()
    case "probe": return handleProbe()
    case "click": return try handleClick(params: params)
    case "type": return try handleType(params: params)
    case "key": return try handleKey(params: params)
    case "scroll": return try handleScroll(params: params)
    case "openApp": return try handleOpenApp(params: params)
    case "focusWindow": return try handleFocusWindow(params: params)
    case "pickerSelect": return try handlePickerSelect(params: params)
    default: throw HostError.message("unknown method \"\(method)\"")
    }
}

func respond(to line: String) -> String {
    let fallback = "{\"id\":0,\"ok\":false,\"error\":\"malformed request\"}\n"
    guard
        let data = line.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data),
        let request = object as? [String: Any],
        let method = request["method"] as? String
    else { return fallback }
    let id = (request["id"] as? NSNumber)?.intValue ?? 0
    let params = request["params"] as? [String: Any] ?? [:]
    var response: [String: Any] = ["id": id]
    do {
        response["ok"] = true
        response["result"] = try dispatch(method: method, params: params)
    } catch {
        response["ok"] = false
        response["error"] = String(describing: error)
    }
    guard
        let out = try? JSONSerialization.data(withJSONObject: response),
        let text = String(data: out, encoding: .utf8)
    else { return fallback }
    return text + "\n"
}

// MARK: - Socket server

let environment = ProcessInfo.processInfo.environment
let socketPath = environment["GUS_MAC_HOST_SOCKET"]
    ?? (NSHomeDirectory() + "/.gus/comm/mac-host.sock")

let commDir = (socketPath as NSString).deletingLastPathComponent
try? FileManager.default.createDirectory(atPath: commDir, withIntermediateDirectories: true)
_ = chmod(commDir, 0o700)
unlink(socketPath)

let listenFD = socket(AF_UNIX, SOCK_STREAM, 0)
guard listenFD >= 0 else {
    FileHandle.standardError.write("GusMacHost: socket() failed (\(errno))\n".data(using: .utf8)!)
    exit(1)
}

var address = sockaddr_un()
address.sun_family = sa_family_t(AF_UNIX)
let pathBytes = Array(socketPath.utf8)
guard pathBytes.count < 104 else {
    FileHandle.standardError.write("GusMacHost: socket path too long: \(socketPath)\n".data(using: .utf8)!)
    exit(1)
}
withUnsafeMutablePointer(to: &address.sun_path) { pointer in
    pointer.withMemoryRebound(to: CChar.self, capacity: 104) { dest in
        for (index, byte) in pathBytes.enumerated() { dest[index] = CChar(bitPattern: byte) }
        dest[pathBytes.count] = 0
    }
}
let addressLength = socklen_t(MemoryLayout<sockaddr_un>.offset(of: \.sun_path)! + pathBytes.count)
let bound = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
        bind(listenFD, sockaddrPointer, addressLength)
    }
}
guard bound == 0 else {
    FileHandle.standardError.write("GusMacHost: bind(\(socketPath)) failed (\(errno))\n".data(using: .utf8)!)
    exit(1)
}
_ = chmod(socketPath, 0o600)
guard listen(listenFD, 8) == 0 else {
    FileHandle.standardError.write("GusMacHost: listen() failed (\(errno))\n".data(using: .utf8)!)
    exit(1)
}
FileHandle.standardError.write("GusMacHost: listening on \(socketPath)\n".data(using: .utf8)!)

// Serial accept loop: the control plane is the only client and its
// calls are sequential; one connection at a time keeps helper state
// (above all the picker selection) unambiguous.
while true {
    let conn = accept(listenFD, nil, nil)
    if conn < 0 { continue }
    var buffer = ""
    var chunk = [UInt8](repeating: 0, count: 8192)
    while true {
        let count = recv(conn, &chunk, chunk.count, 0)
        if count <= 0 { break }
        buffer += String(decoding: chunk.prefix(count), as: UTF8.self)
        while let newline = buffer.firstIndex(of: "\n") {
            let line = String(buffer[..<newline])
            buffer = String(buffer[buffer.index(after: newline)...])
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            let reply = respond(to: line)
            reply.withCString { cString in
                _ = send(conn, cString, strlen(cString), 0)
            }
        }
    }
    close(conn)
}
