import AppKit
import CryptoKit
import Foundation
import ServiceManagement

/// Presence for GUS: a main window (v0.7, Desktop 1) plus the
/// menu-bar status item whose menu shows the version and whether
/// the control plane is running, starts/stops the launchd agents,
/// opens the setup panel, checks for updates, and quits. Starting
/// GUS.app also starts GusMacHost from Contents/Helpers and stops
/// it on quit; on an installed machine the app bootstraps any
/// service that is not loaded, so opening the app means GUS is on.
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
    private var mainWindow: MainWindowController?
    private var statusTimer: Timer?
    /// The periodic auto-update check (first prompt v0.15.6;
    /// the full Sparkle-shaped flow v0.19.0), the guard that
    /// keeps two update prompts from stacking, and the guard
    /// that keeps two background downloads from racing.
    private var updateTimer: Timer?
    private var updatePromptVisible = false
    private var updateDownloadInFlight = false

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
        // v0.8: the SwiftUI windows ask for app-owned surfaces via
        // notifications — Settings was a window the delegate owned,
        // and Check for Updates is the delegate's own machinery.
        // v0.14.0: Settings is a section of the main window now —
        // the observer shows that window and forwards the request
        // (userInfo and all, so a pane deep link survives) as
        // .gusShowSettingsSection, which DesktopModel answers.
        NotificationCenter.default.addObserver(forName: .gusOpenSettings, object: nil, queue: .main) { [weak self] note in
            self?.showSettingsSection(userInfo: note.userInfo)
        }
        NotificationCenter.default.addObserver(forName: .gusCheckForUpdates, object: nil, queue: .main) { [weak self] _ in
            self?.checkForUpdates()
        }
        startHelper()
        buildMenu()
        refreshStatus()
        statusTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
        // v0.7 (Desktop 1): opening the app shows the main window —
        // the app is a real desktop application now, not a menu-bar
        // extra with a panel page. The menu bar stays, with every
        // behavior it already had.
        showMainWindow()
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
            // v0.15.6: the auto-update prompt — a first check a
            // few seconds after launch (never in the first-run
            // flow: this branch is installed machines only), then
            // every six hours, so a long-running GUS still hears
            // about a new release. See autoCheckForUpdates().
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                self?.autoCheckForUpdates()
            }
            updateTimer = Timer.scheduledTimer(withTimeInterval: 6 * 60 * 60, repeats: true) { [weak self] _ in
                self?.autoCheckForUpdates()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Install-on-quit (v0.19.0): an update the operator
        // armed from the prompt (or automatic updates armed
        // silently) swaps in now, synchronously, and the new
        // app opens as this one exits. The cached DMG is
        // re-verified against the release checksum before
        // anything moves; a failed verification or swap leaves
        // the current install exactly as it was, and the record
        // is cleared either way — a quit never loops on a
        // broken update.
        if let armed = armedInstallOnQuit() {
            clearInstallOnQuit()
            if verifyDMG(at: armed.dmg, sha256: armed.info.sha256),
               swapInVerifiedUpdate(armed.info, dmg: armed.dmg) == nil {
                relaunchAfterSwap()
            }
        }
        helperProcess?.terminate()
    }

    /// Clicking the Dock icon (or relaunching) reopens the main
    /// window — the behavior a desktop app is expected to have.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMainWindow()
        return true
    }

    // MARK: Menu

    private func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "GUS"

        let menu = NSMenu()
        statusMenuItem = NSMenuItem(title: "GUS: …", action: nil, keyEquivalent: "")
        menu.addItem(statusMenuItem)
        menu.addItem(NSMenuItem(title: "Open GUS…", action: #selector(showMainWindow), keyEquivalent: ""))
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
        menu.addItem(NSMenuItem(title: "Settings…", action: #selector(showSettings), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "First-Run Setup…", action: #selector(runFirstRunSetup), keyEquivalent: ""))
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

    // MARK: Automatic updates (v0.19.0 — the Sparkle shape,
    // Glenn's ask 2026-11-27, modeled on the Muse updater
    // dialog in his screenshot; the v0.15.6 prompt it replaces
    // offered the install before anything was downloaded).
    // A check that finds a newer release downloads the DMG in
    // the background and verifies its checksum FIRST; only a
    // verified DMG already on disk in the cache is ever
    // offered, in a prompt with Skip This Version / Install
    // on Quit / Install and Relaunch and the "Automatically
    // download and install updates in the future" checkbox.
    // With that preference on (default off), there is no
    // prompt at all: the verified download is armed to swap
    // in when the app quits (applicationWillTerminate above).
    // Every failure in this path — network, missing assets,
    // checksum mismatch — is silent: no prompt, no nagging.
    // The menu's manual check still reports in words.

    private var skippedUpdateVersion: String? {
        get { UserDefaults.standard.string(forKey: "gus.updateSkippedVersion") }
        set { UserDefaults.standard.set(newValue, forKey: "gus.updateSkippedVersion") }
    }

    private var automaticUpdates: Bool {
        get { UserDefaults.standard.bool(forKey: "gus.updateAutomatically") }
        set { UserDefaults.standard.set(newValue, forKey: "gus.updateAutomatically") }
    }

    private var updateCacheDir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("GUS/updates", isDirectory: true)
    }

    private func cachedDMGURL(for version: String) -> URL {
        updateCacheDir.appendingPathComponent(version, isDirectory: true)
            .appendingPathComponent("GUS-\(version).dmg")
    }

    private func pruneUpdateCache(keeping version: String) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: updateCacheDir, includingPropertiesForKeys: nil) else { return }
        for entry in entries where entry.lastPathComponent != version {
            try? fm.removeItem(at: entry)
        }
    }

    /// The install-on-quit record: a verified update's version,
    /// cached DMG path and checksum, persisted so the arm
    /// survives relaunches until it lands (or is cleared by
    /// any successful install).
    private func armInstallOnQuit(_ info: ReleaseInfo, dmg: URL) {
        UserDefaults.standard.set(
            ["version": info.version, "path": dmg.path, "sha256": info.sha256],
            forKey: "gus.updateInstallOnQuit")
    }

    private func clearInstallOnQuit() {
        UserDefaults.standard.removeObject(forKey: "gus.updateInstallOnQuit")
    }

    private func armedInstallOnQuit() -> (info: ReleaseInfo, dmg: URL)? {
        guard let record = UserDefaults.standard.dictionary(forKey: "gus.updateInstallOnQuit"),
              let version = record["version"] as? String,
              let path = record["path"] as? String,
              let sha = record["sha256"] as? String else { return nil }
        let dmg = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: dmg.path) else { return nil }
        return (ReleaseInfo(version: version, dmgURL: "", sha256: sha), dmg)
    }

    private func autoCheckForUpdates() {
        guard !updatePromptVisible, !updateDownloadInFlight else { return }
        fetchLatestRelease { [weak self] info in
            guard let self, let info else { return }
            guard self.isNewer(info.version, than: self.appVersion) else { return }
            // A skipped version is never offered again; a
            // still-newer release offers itself normally.
            guard self.skippedUpdateVersion != info.version else { return }
            // The control plane's staged update owns this
            // version if it staged one — never double-prompt.
            guard self.stagedUpdate()?.version != info.version else { return }
            // Already armed to install on quit: nothing to do.
            guard self.armedInstallOnQuit()?.info.version != info.version else { return }
            let cached = self.cachedDMGURL(for: info.version)
            if FileManager.default.fileExists(atPath: cached.path) {
                // A cache entry is only ever offered after it
                // re-verifies (hashed off the main queue).
                DispatchQueue.global(qos: .utility).async { [weak self] in
                    guard let self, self.verifyDMG(at: cached, sha256: info.sha256) else { return }
                    self.offerVerifiedUpdate(info, dmg: cached)
                }
                return
            }
            self.updateDownloadInFlight = true
            self.pruneUpdateCache(keeping: info.version)
            self.downloadAndVerify(info, into: cached.deletingLastPathComponent()) { [weak self] dmg in
                guard let self else { return }
                self.updateDownloadInFlight = false
                guard let dmg else { return } // silent: no prompt, no nagging
                self.offerVerifiedUpdate(info, dmg: dmg)
            }
        }
    }

    /// A newer release's DMG is on disk and verified: act on
    /// it. Automatic updates arm it for quit with no prompt;
    /// otherwise the Sparkle-shaped prompt asks.
    private func offerVerifiedUpdate(_ info: ReleaseInfo, dmg: URL) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard !self.updatePromptVisible else { return }
            guard self.armedInstallOnQuit()?.info.version != info.version else { return }
            if self.automaticUpdates {
                self.armInstallOnQuit(info, dmg: dmg)
                return
            }
            self.updatePromptVisible = true
            let alert = NSAlert()
            alert.messageText = "A new version of GUS is ready to install!"
            alert.informativeText = "GUS \(info.version) has been downloaded and is ready to use. Would you like to install it and relaunch GUS now?"
            let autoCheckbox = NSButton(checkboxWithTitle: "Automatically download and install updates in the future", target: nil, action: nil)
            autoCheckbox.state = self.automaticUpdates ? .on : .off
            alert.accessoryView = autoCheckbox
            // NSAlert buttons stack right-to-left in the order
            // added (the first added is the default, at the
            // right edge), so adding in this order makes the
            // row read Skip This Version / Install on Quit /
            // Install and Relaunch, as in Sparkle's dialog.
            alert.addButton(withTitle: "Install and Relaunch")
            alert.addButton(withTitle: "Install on Quit")
            alert.addButton(withTitle: "Skip This Version")
            let response = alert.runModal()
            self.updatePromptVisible = false
            // The checkbox is a standing preference, saved
            // whichever way the prompt was answered.
            self.automaticUpdates = autoCheckbox.state == .on
            switch response {
            case .alertFirstButtonReturn:
                if let failure = self.swapInVerifiedUpdate(info, dmg: dmg) {
                    self.showAlert(title: "Update failed", text: "\(failure) Nothing was changed.")
                    return
                }
                self.clearInstallOnQuit()
                self.relaunchAfterSwap()
                NSApp.terminate(nil)
            case .alertSecondButtonReturn:
                self.armInstallOnQuit(info, dmg: dmg)
            default:
                self.skippedUpdateVersion = info.version
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
            DispatchQueue.main.async { completion(nil) }
        }.resume()
    }

    /// Install stage 1 (split out v0.19.0): download the
    /// release DMG into `directory` and verify its sha256
    /// against the release's published checksum. The completion
    /// fires on a background queue with the verified file's
    /// URL, or nil on ANY failure — no UI in here; each caller
    /// decides whether a failure deserves an alert (the manual
    /// and staged flows) or silence (automatic checks).
    private func downloadAndVerify(_ info: ReleaseInfo, into directory: URL,
                                   completion: @escaping (URL?) -> Void) {
        guard let dmgURL = URL(string: info.dmgURL) else { completion(nil); return }
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        URLSession.shared.downloadTask(with: dmgURL) { tmp, _, error in
            guard error == nil, let tmp else { completion(nil); return }
            let dmg = directory.appendingPathComponent("GUS-\(info.version).dmg")
            do {
                if fm.fileExists(atPath: dmg.path) { try fm.removeItem(at: dmg) }
                try fm.moveItem(at: tmp, to: dmg)
                let data = try Data(contentsOf: dmg)
                let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                guard digest == info.sha256.lowercased() else { completion(nil); return }
            } catch {
                completion(nil); return
            }
            completion(dmg)
        }.resume()
    }

    /// Verify a DMG already on disk (the automatic flow's
    /// cache) against a release checksum.
    private func verifyDMG(at url: URL, sha256: String) -> Bool {
        guard let data = try? Data(contentsOf: url) else { return false }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return digest == sha256.lowercased()
    }

    /// Install stage 2 (split out v0.19.0): mount a VERIFIED
    /// DMG → stage the new app beside the old one → swap →
    /// boot the services out (the relaunched app bootstraps
    /// them onto the new payload). Synchronous; returns nil on
    /// success or the failure in words. Any failure before the
    /// swap leaves the running install exactly as it was; a
    /// backup copy survives until the new app exists.
    /// Relaunching is the caller's job.
    private func swapInVerifiedUpdate(_ info: ReleaseInfo, dmg: URL) -> String? {
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("gus-update-swap-\(info.version)")
        try? fm.removeItem(at: work)
        do { try fm.createDirectory(at: work, withIntermediateDirectories: true) } catch {
            return "Couldn't create a work folder: \(error.localizedDescription)."
        }
        // Mount read-only at a known mountpoint.
        let mount = work.appendingPathComponent("mount")
        try? fm.createDirectory(at: mount, withIntermediateDirectories: true)
        let attach = runProcess("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount.path, dmg.path])
        guard attach.status == 0 else { return "Couldn't open the disk image." }
        defer { _ = runProcess("/usr/bin/hdiutil", ["detach", mount.path, "-force"]) }
        let newApp = mount.appendingPathComponent("GUS.app")
        guard fm.fileExists(atPath: newApp.path) else { return "The disk image doesn't contain GUS.app." }
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
            return "Couldn't swap in the new app: \(error.localizedDescription)."
        }
        try? fm.removeItem(atPath: pendingUpdatePath)
        // Boot the services out; the relaunched app bootstraps
        // them onto the new payload (ensureServicesRunning).
        for label in labels {
            _ = launchctl(["bootout", "\(domain)/\(label)"])
        }
        return nil
    }

    /// The relaunch half of every install path: a detached
    /// shell reopens the (new) app once this process is gone.
    private func relaunchAfterSwap() {
        let target = Bundle.main.bundlePath
        let relaunch = Process()
        relaunch.executableURL = URL(fileURLWithPath: "/bin/sh")
        relaunch.arguments = ["-c", "sleep 1; open \"\(target)\""]
        try? relaunch.run()
    }

    /// The one-click install the menu's manual check and the
    /// staged-update flow run: stage 1 into a scratch folder,
    /// then stage 2, then relaunch — failures in words, and
    /// any failure before the swap leaves the running install
    /// exactly as it was.
    private func installUpdate(_ info: ReleaseInfo) {
        let work = FileManager.default.temporaryDirectory.appendingPathComponent("gus-update-\(info.version)")
        statusMenuItem.title = "GUS: downloading update v\(info.version)…"
        downloadAndVerify(info, into: work) { [weak self] dmg in
            guard let self else { return }
            guard let dmg else {
                DispatchQueue.main.async {
                    self.refreshStatus()
                    self.showAlert(title: "Update failed", text: "The download didn't complete, or the downloaded DMG's checksum does not match the release's published sha256 (\(info.sha256.prefix(12))…). Nothing was changed.")
                }
                return
            }
            DispatchQueue.main.async {
                if let failure = self.swapInVerifiedUpdate(info, dmg: dmg) {
                    self.refreshStatus()
                    self.showAlert(title: "Update failed", text: "\(failure) Nothing was changed.")
                    return
                }
                self.clearInstallOnQuit()
                self.relaunchAfterSwap()
                NSApp.terminate(nil)
            }
        }
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

    @objc private func showMainWindow() {
        if mainWindow == nil { mainWindow = MainWindowController() }
        mainWindow?.show()
    }

    @objc private func showSetup() {
        if setupWindow == nil { setupWindow = SetupWindowController() }
        setupWindow?.show()
    }

    /// v0.8 (Desktop 2): the native Settings window — setup and
    /// settings live in the app now, over the same panel APIs.
    /// v0.14.0: there is no Settings window anymore — Settings
    /// is a section of the main window, so this brings that
    /// window forward and forwards the request to the model,
    /// which selects the section (and the pane named in
    /// userInfo["section"], when one rides along). The menu
    /// items keep calling this; only the landing changed.
    @objc private func showSettings() {
        showSettingsSection(userInfo: nil)
    }

    /// Distinct name, not an overload of showSettings(): a
    /// same-base-name pair makes #selector(showSettings)
    /// ambiguous and the Swift build fails (hit on the iMac's
    /// first v0.14.2 build, 2026-11-19).
    private func showSettingsSection(userInfo: [AnyHashable: Any]?) {
        showMainWindow()
        NotificationCenter.default.post(name: .gusShowSettingsSection, object: nil, userInfo: userInfo)
    }

    /// The first-run wizard as a sheet on the main window (the
    /// model presents it); the menu entry just brings the window
    /// forward and posts the request.
    @objc private func runFirstRunSetup() {
        showMainWindow()
        NotificationCenter.default.post(name: .gusRunSetup, object: nil)
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
