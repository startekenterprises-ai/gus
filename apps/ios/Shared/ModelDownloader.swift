import CryptoKit
import Foundation

// The first-launch model download flow (v0.15.0 chunk 2).
//
// One observable library owns the state Settings shows and the
// call gates on: for each manifest download, notDownloaded →
// downloading(fraction) → verifying → ready | failed(reason).
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

    @Published private(set) var brainState: EntryState = .notDownloaded

    private var downloadTask: URLSessionDownloadTask?
    private var resumeData: Data?
    private var session: URLSession!

    override init() {
        super.init()
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        refresh()
    }

    func refresh() {
        if case .downloading = brainState { return }
        if case .verifying = brainState { return }
        brainState = ModelStore.isPresent(GUSModelManifest.brain) ? .ready : .notDownloaded
    }

    var brainReady: Bool { brainState == .ready }

    // MARK: - Download

    func downloadBrain() {
        let entry = GUSModelManifest.brain
        if ModelStore.isPresent(entry) {
            brainState = .ready
            return
        }
        guard downloadTask == nil else { return }
        brainState = .downloading(0)
        let task: URLSessionDownloadTask
        if let resumeData {
            task = session.downloadTask(withResumeData: resumeData)
        } else {
            task = session.downloadTask(with: entry.url)
        }
        downloadTask = task
        task.resume()
    }

    func cancelDownload() {
        downloadTask?.cancel(byProducingResumeData: { [weak self] data in
            Task { @MainActor in self?.resumeData = data }
        })
        downloadTask = nil
        brainState = ModelStore.isPresent(GUSModelManifest.brain) ? .ready : .notDownloaded
    }

    func deleteBrain() {
        cancelDownload()
        ModelStore.remove(GUSModelManifest.brain)
        resumeData = nil
        brainState = .notDownloaded
    }

    /// Re-verify the on-disk brain against the manifest hash
    /// (Settings' "Verify" — the download path already verifies
    /// before first use; this is the operator's re-check).
    func verifyBrain() {
        let entry = GUSModelManifest.brain
        guard ModelStore.isPresent(entry) else {
            brainState = .notDownloaded
            return
        }
        brainState = .verifying
        let url = ModelStore.fileURL(for: entry)
        Task.detached(priority: .utility) {
            let ok = (try? Self.sha256Hex(of: url)) == entry.sha256
            await MainActor.run { [weak self] in
                guard let self else { return }
                if ok {
                    self.brainState = .ready
                } else {
                    ModelStore.remove(entry)
                    self.brainState = .failed("The downloaded brain failed its integrity check and was removed. Download it again.")
                }
            }
        }
    }

    // MARK: - Completion (called from the delegate, off-main)

    private nonisolated func finishDownload(location: URL?, error: Error?) {
        let entry = GUSModelManifest.brain
        Task { @MainActor in
            self.downloadTask = nil
            if let error {
                let nsError = error as NSError
                if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
                    self.refresh()
                    return
                }
                self.brainState = .failed("Download failed: \(error.localizedDescription)")
                return
            }
            guard let location else {
                self.brainState = .failed("Download failed: no file arrived.")
                return
            }
            self.brainState = .verifying
            let partial = ModelStore.directory.appendingPathComponent(entry.fileName + ".partial")
            try? FileManager.default.removeItem(at: partial)
            do {
                try FileManager.default.moveItem(at: location, to: partial)
            } catch {
                self.brainState = .failed("Download failed: couldn't store the file (\(error.localizedDescription)).")
                return
            }
            self.resumeData = nil
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
                            self.brainState = .ready
                        } catch {
                            self.brainState = .failed("Downloaded and verified, but couldn't move into place: \(error.localizedDescription)")
                        }
                    } else {
                        try? FileManager.default.removeItem(at: partial)
                        self.brainState = .failed("The download didn't match the manifest (size or integrity check failed) and was removed. Try again.")
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
        let entry = GUSModelManifest.brain
        let staging = ModelStore.directory.appendingPathComponent(entry.fileName + ".incoming")
        try? FileManager.default.removeItem(at: staging)
        let moved = (try? FileManager.default.moveItem(at: location, to: staging)) != nil
        finishDownload(location: moved ? staging : nil, error: nil)
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        if let data = (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
            Task { @MainActor in self.resumeData = data }
        }
        finishDownload(location: nil, error: error)
    }

    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                                didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                                totalBytesExpectedToWrite: Int64) {
        let expected = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : GUSModelManifest.brain.bytes
        let fraction = min(1, max(0, Double(totalBytesWritten) / Double(expected)))
        Task { @MainActor in
            if case .downloading = self.brainState {
                self.brainState = .downloading(fraction)
            }
        }
    }
}
