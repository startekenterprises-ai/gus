import AppKit
import Foundation
import ServiceManagement

/// Menu-bar presence for GUS: a status item whose menu shows the
/// version and whether the control plane is running, starts/stops
/// the launchd agents, opens the setup panel, checks for updates,
/// and quits. Starting GUS.app also starts GusMacHost from
/// Contents/Helpers and stops it on quit; on an installed machine
/// the app bootstraps any service that is not loaded, so opening
/// the app means GUS is on.
final class GusAppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var statusMenuItem: NSMenuItem!
    private var startItem: NSMenuItem!
    private var restartItem: NSMenuItem!
    private var stopItem: NSMenuItem!
    private var loginItem: NSMenuItem!
    private var modeEnforcingItem: NSMenuItem!
    private var modePermissiveItem: NSMenuItem!
    private var helperProcess: Process?
    private var setupWindow: SetupWindowController?
    private var statusTimer: Timer?

    private let labels = [
        "com.startekenterprises.gus.control-plane",
        "com.startekenterprises.gus.runtime",
    ]
    private var domain: String { "gui/\(getuid())" }
    private var agentsDir: String { NSHomeDirectory() + "/Library/LaunchAgents" }
    private var socketPath: String {
        NSHomeDirectory() + "/.gus/comm/mac-host.sock"
    }
    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        startHelper()
        buildMenu()
        refreshStatus()
        statusTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
        // First run (no GUS home yet) opens the setup window on its
        // own; after that it is one menu click away.
        if !FileManager.default.fileExists(atPath: NSHomeDirectory() + "/.gus/state") {
            showSetup()
        } else {
            // Auto-start on an installed machine: bootstrap whatever
            // is not loaded. Loaded services are left alone — opening
            // the app to peek must never bounce running work.
            ensureServicesRunning()
            refreshStatus()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        helperProcess?.terminate()
    }

    // MARK: Menu

    private func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "GUS"

        let menu = NSMenu()
        statusMenuItem = NSMenuItem(title: "GUS: …", action: nil, keyEquivalent: "")
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())
        startItem = NSMenuItem(title: "Start GUS", action: #selector(startGus), keyEquivalent: "")
        menu.addItem(startItem)
        restartItem = NSMenuItem(title: "Restart GUS", action: #selector(startGus), keyEquivalent: "")
        menu.addItem(restartItem)
        stopItem = NSMenuItem(title: "Stop GUS", action: #selector(stopGus), keyEquivalent: "")
        menu.addItem(stopItem)
        menu.addItem(.separator())
        loginItem = NSMenuItem(title: "Start at Login", action: #selector(toggleLoginItem), keyEquivalent: "")
        menu.addItem(loginItem)
        menu.addItem(.separator())
        let modeHeader = NSMenuItem(title: "Governor Mode", action: nil, keyEquivalent: "")
        modeHeader.isEnabled = false
        menu.addItem(modeHeader)
        modeEnforcingItem = NSMenuItem(title: "Enforcing", action: #selector(setEnforcing), keyEquivalent: "")
        menu.addItem(modeEnforcingItem)
        modePermissiveItem = NSMenuItem(title: "Permissive (record, don't block)", action: #selector(setPermissive), keyEquivalent: "")
        menu.addItem(modePermissiveItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Setup & Permissions…", action: #selector(showSetup), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Open Setup Panel", action: #selector(openPanel), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "About GUS", action: #selector(showAbout), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit GUS.app", action: #selector(quit), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        statusItem.menu = menu
    }

    private func refreshStatus() {
        let running = isLoaded(labels[0])
        let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "—"
        statusMenuItem.title = running
            ? "GUS v\(appVersion): running · front app: \(front)"
            : "GUS v\(appVersion): stopped"
        statusItem.button?.title = running ? "GUS ●" : "GUS ○"
        // State you can read at a glance: what cannot be done is grey.
        startItem?.isEnabled = !running
        restartItem?.isEnabled = running
        stopItem?.isEnabled = running
        loginItem?.state = SMAppService.mainApp.status == .enabled ? .on : .off
        let permissive = governorMode() == "permissive"
        modeEnforcingItem?.state = permissive ? .off : .on
        modePermissiveItem?.state = permissive ? .on : .off
    }

    // MARK: Governor mode (v0.4 — same state file the control plane,
    // the panel, and the /mode chat command read and write)

    private var governorModePath: String {
        NSHomeDirectory() + "/.gus/state/governor-mode.json"
    }

    private func governorMode() -> String {
        guard let data = FileManager.default.contents(atPath: governorModePath),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let mode = obj["mode"] as? String else {
            return "enforcing"
        }
        return mode == "permissive" ? "permissive" : "enforcing"
    }

    private func setGovernorMode(_ mode: String) {
        let obj: [String: Any] = [
            "mode": mode,
            "setBy": "gus-app-menu",
            "ts": Int(Date().timeIntervalSince1970 * 1000),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) {
            try? data.write(to: URL(fileURLWithPath: governorModePath))
        }
        refreshStatus()
    }

    @objc private func setEnforcing() { setGovernorMode("enforcing") }
    @objc private func setPermissive() { setGovernorMode("permissive") }

    // MARK: launchd control

    @discardableResult
    private func launchctl(_ args: [String]) -> (status: Int32, output: String) {
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

    private func isLoaded(_ label: String) -> Bool {
        launchctl(["print", "\(domain)/\(label)"]).status == 0
    }

    private func ensureServicesRunning() {
        for label in labels where !isLoaded(label) {
            _ = launchctl(["bootstrap", domain, "\(agentsDir)/\(label).plist"])
        }
    }

    @objc private func startGus() {
        for label in labels {
            let plist = "\(agentsDir)/\(label).plist"
            if !isLoaded(label) {
                _ = launchctl(["bootstrap", domain, plist])
            }
            _ = launchctl(["kickstart", "-k", "\(domain)/\(label)"])
        }
        startHelper()
        refreshStatus()
    }

    @objc private func stopGus() {
        for label in labels.reversed() {
            _ = launchctl(["bootout", "\(domain)/\(label)"])
        }
        refreshStatus()
    }

    @objc private func toggleLoginItem() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            NSLog("GUS: login item toggle failed: \(error.localizedDescription)")
        }
        refreshStatus()
    }

    // MARK: Helper

    private func startHelper() {
        guard helperProcess?.isRunning != true else { return }
        // The socket FILE existing proves nothing: a terminated
        // helper leaves it behind, and the old file-exists guard then
        // skipped starting the helper forever (field bug, 2026-11-05:
        // the 0.3.0 helper's stale socket blocked every 0.3.1 launch
        // until it was deleted by hand). This app owns the helper as
        // a child process; if we are not running one, the file is a
        // leftover — clear it and spawn. (The helper also unlinks
        // before it binds, so clearing is safe even against an
        // orphaned helper: the path is what callers connect to.)
        if FileManager.default.fileExists(atPath: socketPath) {
            try? FileManager.default.removeItem(atPath: socketPath)
        }
        let helperURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/GusMacHost")
        guard FileManager.default.isExecutableFile(atPath: helperURL.path) else { return }
        let process = Process()
        process.executableURL = helperURL
        process.standardError = FileHandle.standardError
        do {
            try process.run()
            helperProcess = process
        } catch {
            NSLog("GUS: could not start GusMacHost: \(error.localizedDescription)")
        }
    }

    // MARK: Updates & about

    @objc private func checkForUpdates() {
        guard let url = URL(string: "https://raw.githubusercontent.com/startekenterprises-ai/gus/main/site-facts.json") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self else { return }
                let current = self.appVersion
                guard error == nil, let data,
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let gus = obj["gus"] as? [String: Any],
                      let latest = gus["version"] as? String
                else {
                    self.showAlert(
                        title: "Couldn't check for updates",
                        text: "The check didn't reach GitHub. Nothing was changed.")
                    return
                }
                if self.isNewer(latest, than: current) {
                    let alert = NSAlert()
                    alert.messageText = "GUS \(latest) is available"
                    alert.informativeText = "You are running GUS \(current). New versions are published on the GUS GitHub releases page."
                    alert.addButton(withTitle: "Open Releases Page")
                    alert.addButton(withTitle: "Later")
                    if alert.runModal() == .alertFirstButtonReturn,
                       let page = URL(string: "https://github.com/startekenterprises-ai/gus/releases") {
                        NSWorkspace.shared.open(page)
                    }
                } else {
                    self.showAlert(
                        title: "GUS is up to date",
                        text: "You are running the latest version, GUS \(current).")
                }
            }
        }.resume()
    }

    private func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }
        let pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0
            let y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    @objc private func showAbout() {
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        showAlert(
            title: "GUS v\(appVersion)",
            text: "A secure open-source AI agent.\nBuild \(build) · StarTek Enterprise Solutions LLC\n\nHard spend caps the model can't touch, credentials in a vault, and every tool call through the Agent-Shield gate.")
    }

    private func showAlert(title: String, text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    // MARK: Windows & links

    @objc private func showSetup() {
        if setupWindow == nil { setupWindow = SetupWindowController() }
        setupWindow?.show()
    }

    @objc private func openPanel() {
        if let url = URL(string: "http://127.0.0.1:8731") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }
}
