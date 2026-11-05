import AppKit
import Foundation

/// Menu-bar presence for GUS: a status item whose menu shows
/// whether the control plane is running, starts/stops the launchd
/// agents, opens the setup panel, and quits. Starting GUS.app also
/// starts GusMacHost from Contents/Helpers and stops it on quit.
final class GusAppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var statusMenuItem: NSMenuItem!
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
        menu.addItem(NSMenuItem(title: "Start GUS", action: #selector(startGus), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Stop GUS", action: #selector(stopGus), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Setup & Permissions…", action: #selector(showSetup), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Open Setup Panel", action: #selector(openPanel), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit GUS.app", action: #selector(quit), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        statusItem.menu = menu
    }

    private func refreshStatus() {
        let running = isLoaded(labels[0])
        let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "—"
        statusMenuItem.title = running
            ? "GUS: running · front app: \(front)"
            : "GUS: stopped"
        statusItem.button?.title = running ? "GUS ●" : "GUS ○"
    }

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

    // MARK: Helper

    private func startHelper() {
        guard helperProcess?.isRunning != true else { return }
        guard !FileManager.default.fileExists(atPath: socketPath) else { return }
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
