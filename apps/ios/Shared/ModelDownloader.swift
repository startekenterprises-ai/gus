import CryptoKit
import Foundation

// The model library (v0.15.0 chunk 2; generalized in v0.21.0;
// background downloads in v0.28.0).
//
// One observable library owns the state Settings shows and
// the call gates on: for EVERY manifest download, notDownloaded
// → downloading(fraction) → verifying → ready | failed(reason).
// Brains coexist on disk — downloading one never touches
// another — and ActiveBrain (ModelManifest.swift) says which
// one loads. One download runs at a time (these are 2.5 GB
// files; parallel downloads would fight over the same pipe),
// tracked by the entry's id in the task's taskDescription.
//
// A download lands in a .partial file first; only a file whose
// sha256 matches the manifest AND whose size matches is moved
// into place — a corrupt or truncated download is deleted and
// reported, never used. Interrupted downloads keep their
// URLSession resume data where the server offered it; where it
// didn't, the retry is clean (from byte zero), never a splice.
//
// v0.28.0 — downloads run on a BACKGROUND URLSession, so a
// 2.5 GB brain keeps downloading while the person uses other
// apps, and even across the app being terminated by the
// system: iOS relaunches the app to deliver the completion,
// and on any later cold start the library reattaches to the
// session's outstanding tasks and reconciles what it finds
// (see reconcileAfterLaunch). The task → model mapping is
// carried three ways, each covering a different gap: the
// task's taskDescription (survives relaunch inside the task
// itself), the in-memory activeTasks map (rebuilt on launch),
// and a persisted record in UserDefaults (task identifier,
// expected size, sha256) so a cold start can tell an orphaned
// record apart from a live download and recover a staged or
// partial file through the same verify-before-use path.

/// Where the AppDelegate parks the system's background-session
/// completion handler until ModelLibrary's delegate has seen
/// every pending event (urlSessionDidFinishEvents). Written by
/// the AppDelegate on the main thread, read and cleared by
/// ModelLibrary on the main actor.
enum GUSBackgroundSessionEvents {
    static var completionHandler: (() -> Void)?
}

@MainActor
final class ModelLibrary: NSObject, ObservableObject {
    static let shared = ModelLibrary()

    /// The background session's identifier. The AppDelegate
    /// matches handleEventsForBackgroundURLSession against it,
    /// and the session is recreated under it on every launch —
    /// that recreation is what reconnects the app to downloads
    /// the system kept running (or finished) while it was away.
    static let backgroundSessionIdentifier = "com.startekenterprises.gus.modeldownloads"

    /// UserDefaults key for the persisted download records:
    /// a JSON object keyed by manifest id, each value holding
    /// the background task's identifier plus the manifest's
    /// expected byte size and sha256 at download start.
    private static let recordsKey = "gus.modelDownloads.records"

    private struct DownloadRecord: Codable {
        var taskIdentifier: Int
        var bytes: Int64
        var sha256: String
    }

    enum EntryState: Equatable {
        case notDownloaded
        case downloading(Double)
        case verifying
        case ready
        case failed(String)
    }

    /// Per-entry state, keyed by manifest id. Every manifest
    /// download has an entry here from init on.
    @Published private(set) var states: [String: EntryState] = [:]

    /// The brain the call/chat will load right now (resolved
    /// through ActiveBrain, presence-aware). Republished
    /// whenever downloads land, brains are deleted, or the
    /// person picks a different one.
    @Published private(set) var activeEntryID: String?

    /// Live download tasks by manifest id. At most one entry
    /// by the one-at-a-time rule, but a map — not a single
    /// optional — because launch reconciliation rebuilds it
    /// from whatever the background session still holds.
    private var activeTasks: [String: URLSessionDownloadTask] = [:]
    private var resumeData: [String: Data] = [:]
    private var records: [String: DownloadRecord] = [:]
    private var session: URLSession!

    override init() {
        super.init()
        records = Self.loadRecords()
        let config = URLSessionConfiguration.background(withIdentifier: Self.backgroundSessionIdentifier)
        config.waitsForConnectivity = true
        // Not discretionary: the person asked for this brain
        // and is waiting on it — the download proceeds now,
        // in the background, not when the system feels like it.
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        refresh()
        reconcileAfterLaunch()
    }

    // MARK: - Persisted records

    private static func loadRecords() -> [String: DownloadRecord] {
        guard let data = UserDefaults.standard.data(forKey: recordsKey),
              let decoded = try? JSONDecoder().decode([String: DownloadRecord].self, from: data)
        else { return [:] }
        return decoded
    }

    private func saveRecords() {
        if records.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.recordsKey)
        } else if let data = try? JSONEncoder().encode(records) {
            UserDefaults.standard.set(data, forKey: Self.recordsKey)
        }
    }

    private func clearRecord(_ id: String) {
        guard records.removeValue(forKey: id) != nil else { return }
        saveRecords()
    }

    // MARK: - Launch reconciliation

    /// Reattach to whatever the background session was doing
    /// while the app was suspended or terminated, and settle
    /// the records of downloads that are no longer live:
    /// a brain whose verified file is on disk is ready no
    /// matter what the task state says; a file that arrived
    /// but was never verified (the app died between arrival
    /// and the integrity check) goes through the same
    /// verify-before-use path as a fresh arrival; anything
    /// else is reported as stopped, never silently resumed
    /// or spliced. Delegate delivery for tasks that finished
    /// while the app was away is authoritative and lands
    /// through the normal callbacks — this pass only rebuilds
    /// the map and mops up what no callback will ever claim.
    private func reconcileAfterLaunch() {
        session.getAllTasks { [weak self] tasks in
            Task { @MainActor in
                guard let self else { return }
                var liveIDs: Set<String> = []
                for task in tasks {
                    guard let downloadTask = task as? URLSessionDownloadTask,
                          let id = downloadTask.taskDescription,
                          let entry = GUSModelManifest.entry(id: id) else { continue }
                    liveIDs.insert(id)
                    self.activeTasks[id] = downloadTask
                    let expected = downloadTask.countOfBytesExpectedToReceive > 0
                        ? downloadTask.countOfBytesExpectedToReceive : entry.bytes
                    let fraction = expected > 0
                        ? min(1, max(0, Double(downloadTask.countOfBytesReceived) / Double(expected))) : 0
                    self.states[id] = .downloading(fraction)
                    if self.records[id]?.taskIdentifier != downloadTask.taskIdentifier {
                        self.records[id] = DownloadRecord(
                            taskIdentifier: downloadTask.taskIdentifier,
                            bytes: entry.bytes, sha256: entry.sha256)
                        self.saveRecords()
                    }
                }
                for id in Array(self.records.keys) where !liveIDs.contains(id) {
                    guard let entry = GUSModelManifest.entry(id: id) else {
                        self.clearRecord(id)
                        continue
                    }
                    if ModelStore.isPresent(entry) {
                        self.states[id] = .ready
                        self.activeEntryID = ActiveBrain.resolved()?.id
                        self.clearRecord(id)
                        continue
                    }
                    let staging = ModelStore.directory.appendingPathComponent(entry.fileName + ".incoming")
                    if FileManager.default.fileExists(atPath: staging.path) {
                        // Arrived while the app was away and
                        // the arrival callback never ran (or
                        // its verify pass never finished).
                        self.finishDownload(entry: entry, location: staging, error: nil)
                        continue
                    }
                    let partial = ModelStore.directory.appendingPathComponent(entry.fileName + ".partial")
                    if FileManager.default.fileExists(atPath: partial.path) {
                        self.states[id] = .verifying
                        self.verifyPartial(entry: entry)
                        self.clearRecord(id)
                        continue
                    }
                    self.states[id] = .failed("The download stopped before it finished. Tap Download to start it again.")
                    self.clearRecord(id)
                }
            }
        }
    }

    func state(of entry: ModelDownloadEntry) -> EntryState {
        states[entry.id] ?? .notDownloaded
    }

    func refresh() {
        for entry in GUSModelManifest.downloads {
            switch states[entry.id] {
            case .downloading, .verifying:
                continue
            default:
                states[entry.id] = ModelStore.isPresent(entry) ? .ready : .notDownloaded
            }
        }
        activeEntryID = ActiveBrain.resolved()?.id
    }

    /// Any brain ready on this phone — the first-launch setup
    /// prompt's dismissal cue once its download lands.
    var anyBrainReady: Bool {
        GUSModelManifest.downloads.contains { state(of: $0) == .ready }
    }

    // MARK: - The standard brain (the pre-library call sites)

    var brainState: EntryState { state(of: GUSModelManifest.brain) }

    var brainReady: Bool { brainState == .ready }

    func downloadBrain() { download(GUSModelManifest.brain) }

    // MARK: - Selection

    /// Make a downloaded brain the one the call and chat
    /// load. Nothing is deleted and nothing moves on disk;
    /// the brain loads once per app run, so a switch lands
    /// the next time the app starts (Settings says so).
    func useBrain(_ entry: ModelDownloadEntry) {
        guard ModelStore.isPresent(entry) else { return }
        ActiveBrain.select(entry)
        activeEntryID = ActiveBrain.resolved()?.id
    }

    // MARK: - Download

    func download(_ entry: ModelDownloadEntry) {
        if ModelStore.isPresent(entry) {
            states[entry.id] = .ready
            activeEntryID = ActiveBrain.resolved()?.id
            return
        }
        // One at a time: a second request while another brain
        // is mid-download is ignored (its row keeps its own
        // state; the person can start it when this one lands).
        guard activeTasks.isEmpty else { return }
        states[entry.id] = .downloading(0)
        let task: URLSessionDownloadTask
        if let data = resumeData[entry.id] {
            task = session.downloadTask(withResumeData: data)
        } else {
            task = session.downloadTask(with: entry.url)
        }
        task.taskDescription = entry.id
        activeTasks[entry.id] = task
        records[entry.id] = DownloadRecord(
            taskIdentifier: task.taskIdentifier, bytes: entry.bytes, sha256: entry.sha256)
        saveRecords()
        task.resume()
    }

    func cancelDownload(_ entry: ModelDownloadEntry) {
        guard let task = activeTasks[entry.id] else { return }
        let id = entry.id
        task.cancel(byProducingResumeData: { [weak self] data in
            Task { @MainActor in
                if let data { self?.resumeData[id] = data }
            }
        })
        activeTasks[entry.id] = nil
        clearRecord(id)
        states[entry.id] = ModelStore.isPresent(entry) ? .ready : .notDownloaded
    }

    func delete(_ entry: ModelDownloadEntry) {
        if activeTasks[entry.id] != nil { cancelDownload(entry) }
        ModelStore.remove(entry)
        resumeData[entry.id] = nil
        states[entry.id] = .notDownloaded
        // If this was the brain in use, ActiveBrain's
        // presence-aware resolution falls back on its own
        // (another downloaded brain, or none at all).
        activeEntryID = ActiveBrain.resolved()?.id
    }

    /// Re-verify an on-disk brain against the manifest hash
    /// (the download path already verifies before first use;
    /// this is the operator's re-check).
    func verify(_ entry: ModelDownloadEntry) {
        guard ModelStore.isPresent(entry) else {
            states[entry.id] = .notDownloaded
            return
        }
        states[entry.id] = .verifying
        let url = ModelStore.fileURL(for: entry)
        Task.detached(priority: .utility) {
            let ok = (try? Self.sha256Hex(of: url)) == entry.sha256
            await MainActor.run { [weak self] in
                guard let self else { return }
                if ok {
                    self.states[entry.id] = .ready
                } else {
                    ModelStore.remove(entry)
                    self.states[entry.id] = .failed("The downloaded brain failed its integrity check and was removed. Download it again.")
                    self.activeEntryID = ActiveBrain.resolved()?.id
                }
            }
        }
    }

    // MARK: - Completion (called from the delegate, off-main)

    private nonisolated func finishDownload(entry: ModelDownloadEntry, location: URL?, error: Error?) {
        Task { @MainActor in
            self.activeTasks[entry.id] = nil
            self.clearRecord(entry.id)
            if let error {
                let nsError = error as NSError
                if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
                    self.refresh()
                    return
                }
                self.states[entry.id] = .failed("Download failed: \(error.localizedDescription)")
                return
            }
            guard let location else {
                self.states[entry.id] = .failed("Download failed: no file arrived.")
                return
            }
            self.states[entry.id] = .verifying
            let partial = ModelStore.directory.appendingPathComponent(entry.fileName + ".partial")
            try? FileManager.default.removeItem(at: partial)
            do {
                try FileManager.default.moveItem(at: location, to: partial)
            } catch {
                self.states[entry.id] = .failed("Download failed: couldn't store the file (\(error.localizedDescription)).")
                return
            }
            self.resumeData[entry.id] = nil
            self.verifyPartial(entry: entry)
        }
    }

    /// The verify-before-use pass over a .partial file: size
    /// AND sha256 must match the manifest before the file is
    /// moved into place; anything else is deleted and
    /// reported. Runs off the main actor (a 2.5 GB hash takes
    /// a while) and publishes the outcome back on it. Shared
    /// by the fresh-arrival path and launch reconciliation.
    private func verifyPartial(entry: ModelDownloadEntry) {
        let partial = ModelStore.directory.appendingPathComponent(entry.fileName + ".partial")
        Task.detached(priority: .utility) {
            let sizeOK = ((try? FileManager.default.attributesOfItem(atPath: partial.path))?[.size] as? NSNumber)?.int64Value == entry.bytes
            let hashOK = (try? Self.sha256Hex(of: partial)) == entry.sha256
            await MainActor.run { [weak self] in
                guard let self else { return }
                if sizeOK && hashOK {
                    let dest = ModelStore.fileURL(for: entry)
                    try? FileManager.default.removeItem(at: dest)
                    do {
                        try FileManager.default.moveItem(at: partial, to: dest)
                        self.states[entry.id] = .ready
                        self.activeEntryID = ActiveBrain.resolved()?.id
                    } catch {
                        self.states[entry.id] = .failed("Downloaded and verified, but couldn't move into place: \(error.localizedDescription)")
                    }
                } else {
                    try? FileManager.default.removeItem(at: partial)
                    self.states[entry.id] = .failed("The download didn't match the manifest (size or integrity check failed) and was removed. Try again.")
                }
            }
        }
    }

    /// Streaming sha256 — a 2.5 GB file is never loaded whole.
    nonisolated static func sha256Hex(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 4 * 1024 * 1024) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - URLSessionDownloadDelegate

extension ModelLibrary: URLSessionDownloadDelegate {
    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                                didFinishDownloadingTo location: URL) {
        // The temp file dies when this callback returns — move
        // it synchronously here, verify later.
        guard let id = downloadTask.taskDescription,
              let entry = GUSModelManifest.entry(id: id) else { return }
        let staging = ModelStore.directory.appendingPathComponent(entry.fileName + ".incoming")
        try? FileManager.default.removeItem(at: staging)
        let moved = (try? FileManager.default.moveItem(at: location, to: staging)) != nil
        finishDownload(entry: entry, location: moved ? staging : nil, error: nil)
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        guard let id = task.taskDescription,
              let entry = GUSModelManifest.entry(id: id) else { return }
        if let data = (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
            Task { @MainActor in self.resumeData[id] = data }
        }
        finishDownload(entry: entry, location: nil, error: error)
    }

    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                                didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                                totalBytesExpectedToWrite: Int64) {
        guard let id = downloadTask.taskDescription,
              let entry = GUSModelManifest.entry(id: id) else { return }
        let expected = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : entry.bytes
        let fraction = min(1, max(0, Double(totalBytesWritten) / Double(expected)))
        Task { @MainActor in
            if case .downloading = self.states[id] {
                self.states[id] = .downloading(fraction)
            }
        }
    }

    /// Every event the system held for the background session
    /// has now been delivered — the moment to run the
    /// completion handler the AppDelegate parked, which tells
    /// the system this background wake is fully handled and
    /// the app may be suspended again.
    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in
            let handler = GUSBackgroundSessionEvents.completionHandler
            GUSBackgroundSessionEvents.completionHandler = nil
            handler?()
        }
    }
}
