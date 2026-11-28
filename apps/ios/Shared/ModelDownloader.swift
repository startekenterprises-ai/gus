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
//
// v0.48.0 — a PAIR entry (the vision brain: model + vision
// projector) downloads as two LEGS through this same
// machinery: the model file under the entry's own id, the
// projector under id + "#mmproj" (the leg entry
// GUSModelManifest.entry(id:) resolves). One leg runs at a
// time like everything else; when the model leg lands and
// verifies, the projector leg starts on its own (legLanded).
// The state Settings shows for a pair is DERIVED from its
// two leg states plus what's actually on disk (state(of:)),
// and presence itself is pair-aware (ModelStore), so no
// surface can call the brain ready with half a pair.

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
        /// The expected sha256 at download start. Optional
        /// since v0.38.0: a custom brain whose repo publishes
        /// no checksum records nil (old records, which always
        /// carry one, decode unchanged).
        var sha256: String?
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
                    // Leg presence (v0.48.0): a record names
                    // ONE file — a pair's model leg or its
                    // projector leg — so it settles on that
                    // file alone. (ModelStore.isPresent on the
                    // pair parent would demand both halves and
                    // misjudge a finished leg as unfinished.)
                    if ModelStore.filePresent(fileName: entry.fileName, bytes: entry.bytes) {
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
        guard entry.projector != nil else {
            return states[entry.id] ?? .notDownloaded
        }
        // A pair's shown state is derived from its two leg
        // states (states[] only ever holds LEG truth: the
        // model leg under the entry's id, the projector leg
        // under its leg id) plus what's on disk — never a
        // stored pair verdict that could drift from either.
        if ModelStore.isPresent(entry) { return .ready }
        let main = states[entry.id] ?? .notDownloaded
        let proj = states[entry.projectorLegID] ?? .notDownloaded
        if case .failed(let message) = main { return .failed(message) }
        if case .failed(let message) = proj { return .failed(message) }
        if main == .verifying || proj == .verifying { return .verifying }
        let mainActive = isDownloading(main)
        let projActive = isDownloading(proj)
        if mainActive || projActive {
            // Byte-weighted progress across both legs; a leg
            // whose file is already on disk counts complete.
            let mainDone = ModelStore.filePresent(fileName: entry.fileName, bytes: entry.bytes)
                ? Double(entry.bytes)
                : (legFraction(main) ?? 0) * Double(entry.bytes)
            let projDone = entry.projector.map {
                ModelStore.filePresent(fileName: $0.fileName, bytes: $0.bytes)
                    ? Double($0.bytes)
                    : (legFraction(proj) ?? 0) * Double($0.bytes)
            } ?? 0
            let total = Double(entry.totalBytes)
            return .downloading(total > 0 ? min(1, max(0, (mainDone + projDone) / total)) : 0)
        }
        // Nothing running and the pair incomplete: not
        // downloaded — the row's Download resumes with
        // whichever leg is missing (see download(_:)).
        return .notDownloaded
    }

    private func isDownloading(_ state: EntryState) -> Bool {
        if case .downloading = state { return true }
        return false
    }

    private func legFraction(_ state: EntryState) -> Double? {
        if case .downloading(let fraction) = state { return fraction }
        return nil
    }

    func refresh() {
        for entry in GUSModelManifest.downloads {
            switch states[entry.id] {
            case .downloading, .verifying:
                continue
            default:
                // Leg truth (v0.48.0): for a pair entry this
                // slot is the MODEL leg's state, so it settles
                // on the model file alone; the pair's shown
                // state is derived in state(of:). For a
                // single-file entry the two are the same check.
                states[entry.id] = ModelStore.filePresent(fileName: entry.fileName, bytes: entry.bytes) ? .ready : .notDownloaded
            }
        }
        // Custom brains (v0.38.0) settle the same way, so
        // their rows are truthful after a relaunch too.
        for entry in CustomBrainStore.shared.entries {
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
            || CustomBrainStore.shared.entries.contains { state(of: $0) == .ready }
    }

    // MARK: - The standard brain (the pre-library call sites)

    var brainState: EntryState { state(of: GUSModelManifest.brain) }

    var brainReady: Bool { brainState == .ready }

    func downloadBrain() { download(GUSModelManifest.brain) }

    // MARK: - Selection

    /// Make a downloaded brain the one the call and chat
    /// load. Nothing is deleted and nothing moves on disk.
    /// Since v0.31.0 the switch lands IN-PROCESS: holders
    /// check their cached brain against what would load now
    /// (LocalBrain.isCurrent) and reload at the next turn or
    /// call — no app restart, and Settings now says that.
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
        if entry.projector != nil {
            // The pair gate (v0.48.0): model + projector
            // COMBINED against the same 40%-of-RAM BrainFit
            // cap brain search uses — the two files load
            // together, so they are judged together. The
            // library row hides the offer entirely when the
            // pair doesn't fit; this is the same rule at the
            // door itself, so no caller can start what the
            // row wouldn't offer.
            guard BrainFit.fitsOnThisDevice(fileBytes: entry.totalBytes) else { return }
            if ModelStore.filePresent(fileName: entry.fileName, bytes: entry.bytes),
               let leg = entry.projectorLegEntry() {
                // The model half is already on disk (an
                // earlier download stopped between legs):
                // fetch the eyes, not the whole brain again.
                startLeg(leg)
            } else {
                startLeg(entry)
            }
            return
        }
        startLeg(entry)
    }

    /// Start one file's download: a whole single-file entry,
    /// or one leg of a pair (the entry passed IS the leg —
    /// the projector leg arrives as its own entry, resolved
    /// by GUSModelManifest.entry(id:) everywhere else too).
    private func startLeg(_ entry: ModelDownloadEntry) {
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
        // A pair cancels whichever leg is running (v0.48.0);
        // a single-file entry only ever has its own.
        let legIDs = [entry.id, entry.projectorLegID]
        guard let activeID = legIDs.first(where: { activeTasks[$0] != nil }),
              let task = activeTasks[activeID] else { return }
        task.cancel(byProducingResumeData: { [weak self] data in
            Task { @MainActor in
                if let data { self?.resumeData[activeID] = data }
            }
        })
        activeTasks[activeID] = nil
        clearRecord(activeID)
        states[entry.id] = ModelStore.isPresent(entry) ? .ready : .notDownloaded
    }

    func delete(_ entry: ModelDownloadEntry) {
        if activeTasks[entry.id] != nil || activeTasks[entry.projectorLegID] != nil {
            cancelDownload(entry)
        }
        ModelStore.remove(entry)
        resumeData[entry.id] = nil
        resumeData[entry.projectorLegID] = nil
        clearRecord(entry.projectorLegID)
        states[entry.id] = .notDownloaded
        states[entry.projectorLegID] = .notDownloaded
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
        // A pair entry (v0.48.0) verifies BOTH files: the
        // projector carries a pinned hash just like the
        // model, and a pair is only as verified as its
        // weaker half.
        var checks: [(url: URL, sha256: String)] = []
        if let projector = entry.projector, let url = ModelStore.projectorURL(for: entry) {
            checks.append((url, projector.sha256))
        }
        // A custom brain whose repo publishes no checksum
        // (v0.38.0) has nothing to hash against: presence —
        // which is itself the size gate — is the whole
        // check, and the entry's description says so. (For a
        // pair, the guard below only excuses the model
        // file; the projector's check above still runs.)
        guard let expected = entry.sha256 else {
            if checks.isEmpty {
                states[entry.id] = .ready
                return
            }
            runVerifyChecks(entry, checks: checks)
            return
        }
        checks.append((ModelStore.fileURL(for: entry), expected))
        runVerifyChecks(entry, checks: checks)
    }

    /// The detached hash pass behind verify(_:): every
    /// listed file must match its pinned sha256, or the
    /// entry is removed and reported — never half-trusted.
    private func runVerifyChecks(_ entry: ModelDownloadEntry, checks: [(url: URL, sha256: String)]) {
        Task.detached(priority: .utility) {
            let ok = checks.allSatisfy { (try? Self.sha256Hex(of: $0.url)) == $0.sha256 }
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
            // Size is ALWAYS checked. The hash is checked
            // when the entry carries one; a custom brain
            // whose repo publishes no checksum (v0.38.0)
            // passes on size alone — the honest degradation,
            // named in the entry's own description, never a
            // silent skip dressed up as a verification.
            let hashOK = entry.sha256.map { expected in
                (try? Self.sha256Hex(of: partial)) == expected
            } ?? true
            await MainActor.run { [weak self] in
                guard let self else { return }
                if sizeOK && hashOK {
                    let dest = ModelStore.fileURL(for: entry)
                    try? FileManager.default.removeItem(at: dest)
                    do {
                        try FileManager.default.moveItem(at: partial, to: dest)
                        self.states[entry.id] = .ready
                        self.activeEntryID = ActiveBrain.resolved()?.id
                        self.legLanded(entry)
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

    /// A file just landed and verified (v0.48.0): if it was
    /// the model half of a pair whose projector is still
    /// missing, start the projector leg — the pair is one
    /// offer, so it completes itself. If another download
    /// has taken the pipe by now, the leg waits: the pair's
    /// derived state offers Download, which resumes with
    /// the missing leg (see download(_:)).
    private func legLanded(_ leg: ModelDownloadEntry) {
        guard let projector = leg.projector,
              !ModelStore.filePresent(fileName: projector.fileName, bytes: projector.bytes),
              activeTasks.isEmpty,
              let legEntry = leg.projectorLegEntry() else { return }
        startLeg(legEntry)
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
