import CryptoKit
import Foundation

// The model library (v0.15.0 chunk 2; generalized in v0.21.0).
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

@MainActor
final class ModelLibrary: NSObject, ObservableObject {
    static let shared = ModelLibrary()

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

    private var downloadTask: URLSessionDownloadTask?
    private var downloadingID: String?
    private var resumeData: [String: Data] = [:]
    private var session: URLSession!

    override init() {
        super.init()
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        refresh()
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
        guard downloadTask == nil else { return }
        states[entry.id] = .downloading(0)
        let task: URLSessionDownloadTask
        if let data = resumeData[entry.id] {
            task = session.downloadTask(withResumeData: data)
        } else {
            task = session.downloadTask(with: entry.url)
        }
        task.taskDescription = entry.id
        downloadTask = task
        downloadingID = entry.id
        task.resume()
    }

    func cancelDownload(_ entry: ModelDownloadEntry) {
        guard downloadingID == entry.id else { return }
        let id = entry.id
        downloadTask?.cancel(byProducingResumeData: { [weak self] data in
            Task { @MainActor in
                if let data { self?.resumeData[id] = data }
            }
        })
        downloadTask = nil
        downloadingID = nil
        states[entry.id] = ModelStore.isPresent(entry) ? .ready : .notDownloaded
    }

    func delete(_ entry: ModelDownloadEntry) {
        if downloadingID == entry.id { cancelDownload(entry) }
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
            if self.downloadingID == entry.id {
                self.downloadTask = nil
                self.downloadingID = nil
            }
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
}
