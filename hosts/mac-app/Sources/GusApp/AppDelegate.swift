import AppKit
import CryptoKit
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
    private var installStagedItem: NSMenuItem!
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
        installStagedItem = NSMenuItem(title: "Install Staged Update…", action: #selector(installStagedUpdate), keyEquivalent: "")
        menu.addItem(installStagedItem)
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
        if let staged = stagedUpdate(), isNewer(staged.version, than: appVersion) {
            installStagedItem?.title = "Install Staged Update (v\(staged.version))…"
            installStagedItem?.isEnabled = true
        } else {
            installStagedItem?.title = "Install Staged Update…"
            installStagedItem?.isEnabled = false
        }
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

    // MARK: Updates (v0.4 — one-click install from GitHub Releases;
    // the release workflow attaches the DMG + its sha256 to every
    // tagged release, and nothing installs that does not verify)

    private struct ReleaseInfo {
        let version: String
        let dmgURL: String
        let sha256: String
    }

    private var pendingUpdatePath: String {
        NSHomeDirectory() + "/.gus/state/pending-update.json"
    }

    /// The staged update, if the control plane staged one (the
    /// /stageupdate chat command): {version, dmgUrl, sha256}.
    private func stagedUpdate() -> ReleaseInfo? {
        guard let data = FileManager.default.contents(atPath: pendingUpdatePath),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = obj["version"] as? String,
              let dmgUrl = obj["dmgUrl"] as? String,
              let sha = obj["sha256"] as? String else {
            return nil
        }
        return ReleaseInfo(version: version, dmgURL: dmgUrl, sha256: sha)
    }

    @objc private func checkForUpdates() {
        fetchLatestRelease { [weak self] info in
            guard let self else { return }
            guard let info else {
                self.showAlert(
                    title: "Couldn't check for updates",
                    text: "The check didn't reach GitHub, or no release is published yet. Nothing was changed.")
                return
            }
            if self.isNewer(info.version, than: self.appVersion) {
                let alert = NSAlert()
                alert.messageText = "GUS \(info.version) is available"
                alert.informativeText = "You are running GUS \(self.appVersion). Install it now? GUS.app will download the release, verify its checksum, swap itself, and relaunch. The services restart on the new version; your state (vault, policy, jobs, receipts) is never touched by an update."
                alert.addButton(withTitle: "Install Update")
                alert.addButton(withTitle: "Later")
                if alert.runModal() == .alertFirstButtonReturn {
                    self.installUpdate(info)
                }
            } else {
                self.showAlert(
                    title: "GUS is up to date",
                    text: "You are running the latest version, GUS \(self.appVersion).")
            }
        }
    }

    @objc private func installStagedUpdate() {
        guard let info = stagedUpdate() else { return }
        let alert = NSAlert()
        alert.messageText = "Install the staged update to GUS \(info.version)?"
        alert.informativeText = "GUS staged this update (checksum recorded at staging time). It will download, verify, swap, and relaunch — state is never touched."
        alert.addButton(withTitle: "Install Update")
        alert.addButton(withTitle: "Later")
        if alert.runModal() == .alertFirstButtonReturn {
            installUpdate(info)
        }
    }

    private func fetchLatestRelease(completion: @escaping (ReleaseInfo?) -> Void) {
        guard let url = URL(string: "https://api.github.com/repos/startekenterprises-ai/gus/releases/latest") else {
            completion(nil)
            return
        }
        var req = URLRequest(url: url)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { data, _, error in
            var info: ReleaseInfo?
            if error == nil, let data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let tag = obj["tag_name"] as? String,
               let assets = obj["assets"] as? [[String: Any]] {
                let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
                var dmg: String?
                var shaAsset: String?
                for a in assets {
                    guard let name = a["name"] as? String, let dl = a["browser_download_url"] as? String else { continue }
                    if name.hasSuffix(".dmg") { dmg = dl }
                    if name.hasSuffix(".dmg.sha256") { shaAsset = dl }
                }
                if let dmg, let shaAsset {
                    // Fetch the (tiny) checksum file, then hand back.
                    URLSession.shared.dataTask(with: URL(string: shaAsset)!) { shaData, _, _ in
                        let sha = shaData.flatMap { String(data: $0, encoding: .utf8) }?
                            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                        let parsed = sha.split(separator: " ").first.map(String.init) ?? ""
                        DispatchQueue.main.async {
                            completion(parsed.isEmpty ? nil : ReleaseInfo(version: version, dmgURL: dmg, sha256: parsed))
                        }
                    }.resume()
                    return
                }
            }
            DispatchQueue.main.async { completion(info) }
        }.resume()
    }

    /// Download → verify sha256 → mount → stage the new app beside
    /// the old one → swap → boot the services out (the relaunched
    /// app bootstraps them onto the new payload) → relaunch. Any
    /// failure before the swap leaves the running install exactly
    /// as it was; a backup copy survives until the new app exists.
    private func installUpdate(_ info: ReleaseInfo) {
        guard let dmgURL = URL(string: info.dmgURL) else { return }
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("gus-update-\(info.version)")
        try? fm.removeItem(at: work)
        do { try fm.createDirectory(at: work, withIntermediateDirectories: true) } catch {
            showAlert(title: "Update failed", text: "Couldn't create a work folder: \(error.localizedDescription). Nothing was changed.")
            return
        }
        statusMenuItem.title = "GUS: downloading update v\(info.version)…"
        URLSession.shared.downloadTask(with: dmgURL) { [weak self] tmp, _, error in
            guard let self else { return }
            func fail(_ why: String) {
                DispatchQueue.main.async {
                    self.refreshStatus()
                    self.showAlert(title: "Update failed", text: "\(why) Nothing was changed.")
                }
            }
            guard error == nil, let tmp else { fail("The download didn't complete."); return }
            let dmg = work.appendingPathComponent("GUS-\(info.version).dmg")
            do {
                try fm.moveItem(at: tmp, to: dmg)
                let data = try Data(contentsOf: dmg)
                let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                guard digest == info.sha256.lowercased() else {
                    fail("The downloaded DMG's checksum does not match the release's published sha256 (\(info.sha256.prefix(12))…).")
                    return
                }
            } catch {
                fail("Couldn't verify the download: \(error.localizedDescription).")
                return
            }
            // Mount read-only at a known mountpoint.
            let mount = work.appendingPathComponent("mount")
            try? fm.createDirectory(at: mount, withIntermediateDirectories: true)
            let attach = self.runProcess("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount.path, dmg.path])
            guard attach.status == 0 else { fail("Couldn't open the disk image."); return }
            defer { _ = self.runProcess("/usr/bin/hdiutil", ["detach", mount.path, "-force"]) }
            let newApp = mount.appendingPathComponent("GUS.app")
            guard fm.fileExists(atPath: newApp.path) else { fail("The disk image doesn't contain GUS.app."); return }
            // Stage beside the target, keep a backup, then swap.
            let target = Bundle.main.bundlePath
            let staged = work.appendingPathComponent("GUS.app")
            let backup = work.appendingPathComponent("GUS-backup.app")
            do {
                try fm.copyItem(at: newApp, to: staged)
                if fm.fileExists(atPath: target) { try fm.copyItem(at: URL(fileURLWithPath: target), to: backup) }
                try fm.removeItem(at: URL(fileURLWithPath: target))
                do {
                    try fm.moveItem(at: staged, to: URL(fileURLWithPath: target))
                } catch {
                    // Restore the backup — never leave /Applications empty.
                    if fm.fileExists(atPath: backup.path) {
                        try? fm.moveItem(at: backup, to: URL(fileURLWithPath: target))
                    }
                    throw error
                }
            } catch {
                fail("Couldn't swap in the new app: \(error.localizedDescription).")
                return
            }
            try? fm.removeItem(atPath: self.pendingUpdatePath)
            // Boot the services out; the relaunched app bootstraps
            // them onto the new payload (ensureServicesRunning).
            for label in self.labels {
                _ = self.launchctl(["bootout", "\(self.domain)/\(label)"])
            }
            DispatchQueue.main.async {
                let relaunch = Process()
                relaunch.executableURL = URL(fileURLWithPath: "/bin/sh")
                relaunch.arguments = ["-c", "sleep 1; open \"\(target)\""]
                try? relaunch.run()
                NSApp.terminate(nil)
            }
        }.resume()
    }

    private func runProcess(_ path: String, _ args: [String]) -> (status: Int32, output: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do {
            try p.run()
            p.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
        } catch {
            return (-1, error.localizedDescription)
        }
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
