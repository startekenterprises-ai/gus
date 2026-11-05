import AppKit
import ApplicationServices
import Foundation

/// The first-run window: a checklist, checked live, in the order
/// the operator must clear it —
///
///   1. Accessibility   (AXIsProcessTrusted) — the helper's hands.
///   2. Screen Recording (CGPreflightScreenCaptureAccess) — observe's
///      screenshots. Optional for text observations; the checklist
///      says so rather than blocking on it.
///   3. Node ≥ 22        — the control plane's runtime.
///   4. GUS services     — layout, the Nova policy seed, and the two
///      launchd agents, installed from the bundle's Resources.
///
/// Each row carries its own "Open System Settings" / action button;
/// nothing here asks for a password or reaches outside the user's
/// own account.
final class SetupWindowController: NSWindowController {
    private var accessibilityStatus = NSTextField(labelWithString: "")
    private var screenStatus = NSTextField(labelWithString: "")
    private var nodeStatus = NSTextField(labelWithString: "")
    private var installStatus = NSTextField(labelWithString: "")

    private var gusHome: String { NSHomeDirectory() + "/.gus" }
    private var stateDir: String { gusHome + "/state" }

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 430),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "GUS — Setup"
        super.init(window: window)
        buildContent(window)
        refresh()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("programmatic window only") }

    func show() {
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        refresh()
    }

    // MARK: Layout

    private func row(title: String, detail: String, status: NSTextField, buttonTitle: String, action: Selector) -> NSStackView {
        let titleField = NSTextField(labelWithString: title)
        titleField.font = .boldSystemFont(ofSize: 13)
        let detailField = NSTextField(wrappingLabelWithString: detail)
        detailField.textColor = .secondaryLabelColor
        detailField.font = .systemFont(ofSize: 11)
        let textStack = NSStackView(views: [titleField, detailField, status])
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 2
        let button = NSButton(title: buttonTitle, target: self, action: action)
        let rowStack = NSStackView(views: [textStack, NSView(), button])
        rowStack.orientation = .horizontal
        rowStack.alignment = .top
        return rowStack
    }

    private func buildContent(_ window: NSWindow) {
        let heading = NSTextField(labelWithString: "Before GUS can drive this Mac")
        heading.font = .boldSystemFont(ofSize: 16)
        let intro = NSTextField(wrappingLabelWithString:
            "GUS controls this Mac only through the permissions below, and every consequential action still parks for an approval on your phone. Grant the permissions to GUS.app — the helper that does the work runs inside this bundle and inherits them.")
        intro.font = .systemFont(ofSize: 12)

        let stack = NSStackView(views: [
            heading,
            intro,
            row(title: "1 · Accessibility",
                detail: "Lets GUS see the accessibility tree and press, type, and scroll. Required.",
                status: accessibilityStatus,
                buttonTitle: "Open System Settings", action: #selector(openAccessibilitySettings)),
            row(title: "2 · Screen Recording",
                detail: "Adds a screenshot to desktop observations. Optional — text observations work without it.",
                status: screenStatus,
                buttonTitle: "Open System Settings", action: #selector(openScreenSettings)),
            row(title: "3 · Node.js 22 or newer",
                detail: "The GUS control plane and runtime are Node programs bundled in this app.",
                status: nodeStatus,
                buttonTitle: "Re-check", action: #selector(recheck)),
            row(title: "4 · GUS services",
                detail: "Creates ~/.gus, seeds the Nova policy (edit mac.workDirs in ~/.gus/state/policy.json before first use — the template approves no file access until you do), and loads the two launchd agents.",
                status: installStatus,
                buttonTitle: "Install GUS services", action: #selector(installServices)),
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
        ])
        window.contentView = content
    }

    // MARK: Checks

    @objc private func recheck() { refresh() }

    private func refresh() {
        let ax = AXIsProcessTrusted()
        accessibilityStatus.stringValue = ax ? "✓ Granted" : "✗ Not granted — use the button, or the prompt under the menu bar app."
        screenStatus.stringValue = CGPreflightScreenCaptureAccess()
            ? "✓ Granted"
            : "✗ Not granted (observations will be text-only)"
        if let node = findNode() {
            nodeStatus.stringValue = node.ok
                ? "✓ \(node.version) at \(node.path)"
                : "✗ \(node.version) at \(node.path) — GUS needs Node 22 or newer"
        } else {
            nodeStatus.stringValue = "✗ Node not found in /usr/local/bin, /opt/homebrew/bin, or /usr/bin"
        }
        installStatus.stringValue = FileManager.default.fileExists(atPath: stateDir + "/policy.json")
            ? "✓ Installed (state at ~/.gus/state — policy.json is yours to edit)"
            : "Not installed yet"
    }

    /// The first Node on the standard install paths, with its major
    /// version and whether it clears the ≥ 22 bar. A too-old Node is
    /// reported (not silently skipped) so the operator sees why.
    private func findNode() -> (path: String, version: String, ok: Bool)? {
        for candidate in ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"] {
            guard FileManager.default.isExecutableFile(atPath: candidate) else { continue }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: candidate)
            process.arguments = ["-p", "process.versions.node.split('.')[0]"]
            let pipe = Pipe()
            process.standardOutput = pipe
            guard (try? process.run()) != nil else { continue }
            process.waitUntilExit()
            let major = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if let majorNumber = Int(major) {
                return (candidate, "Node \(majorNumber).x", majorNumber >= 22)
            }
        }
        return nil
    }

    // MARK: Settings links

    @objc private func openAccessibilitySettings() {
        // Prompt once (macOS adds GUS to the list), then deep-link.
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        openSettings("com.apple.preference.security?Privacy_Accessibility")
    }

    @objc private func openScreenSettings() {
        _ = CGRequestScreenCaptureAccess()
        openSettings("com.apple.preference.security?Privacy_ScreenCapture")
    }

    private func openSettings(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: Install

    /// The bundled-install steps, mirroring hosts/mac-resident/
    /// install.sh without a shell: layout, policy seed (never
    /// overwriting an existing policy), rendered plists, load.
    @objc private func installServices() {
        do {
            try performInstall()
            installStatus.stringValue = "✓ Installed and loaded — next: open the Setup Panel from the menu and store the Telegram bot token."
        } catch {
            installStatus.stringValue = "✗ \(error.localizedDescription)"
        }
        refresh()
        if installStatus.stringValue.hasPrefix("✗") { return }
    }

    private func performInstall() throws {
        let fileManager = FileManager.default
        guard let resources = Bundle.main.resourceURL?.appendingPathComponent("gus") else {
            throw NSError(domain: "gus.setup", code: 1, userInfo: [NSLocalizedDescriptionKey: "the bundled GUS payload is missing from this app"])
        }
        guard let node = findNode(), node.ok else {
            throw NSError(domain: "gus.setup", code: 2, userInfo: [NSLocalizedDescriptionKey: "Node ≥ 22 is required and was not found"])
        }
        let commDir = gusHome + "/comm"
        let workspaceDir = gusHome + "/workspace"
        for dir in [stateDir, stateDir + "/logs", commDir, workspaceDir] {
            try fileManager.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir)
        }
        // Policy seed — only if none exists. An operator's policy is
        // never overwritten by an installer.
        let policyPath = stateDir + "/policy.json"
        if !fileManager.fileExists(atPath: policyPath) {
            let template = resources.appendingPathComponent("docs/mac-policy-template.json")
            try fileManager.copyItem(at: template, to: URL(fileURLWithPath: policyPath))
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: policyPath)
        }
        // Render + load the launchd agents.
        let agentsDir = NSHomeDirectory() + "/Library/LaunchAgents"
        try fileManager.createDirectory(atPath: agentsDir, withIntermediateDirectories: true)
        let domain = "gui/\(getuid())"
        for label in ["com.startekenterprises.gus.control-plane", "com.startekenterprises.gus.runtime"] {
            let templateURL = resources.appendingPathComponent("hosts/mac-resident/\(label).plist")
            var plist = try String(contentsOf: templateURL, encoding: .utf8)
            plist = plist
                .replacingOccurrences(of: "__NODE_BIN__", with: node.path)
                .replacingOccurrences(of: "__REPO_DIR__", with: resources.path)
                .replacingOccurrences(of: "__STATE_DIR__", with: stateDir)
                .replacingOccurrences(of: "__COMM_DIR__", with: commDir)
                .replacingOccurrences(of: "__WORKSPACE_DIR__", with: workspaceDir)
            let dest = "\(agentsDir)/\(label).plist"
            try plist.write(toFile: dest, atomically: true, encoding: .utf8)
            _ = runLaunchctl(["bootout", "\(domain)/\(label)"])
            let (status, output) = runLaunchctl(["bootstrap", domain, dest])
            guard status == 0 else {
                throw NSError(domain: "gus.setup", code: 3, userInfo: [NSLocalizedDescriptionKey: "launchctl could not load \(label): \(output)"])
            }
        }
    }

    @discardableResult
    private func runLaunchctl(_ args: [String]) -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
        } catch {
            return (-1, error.localizedDescription)
        }
    }
}
