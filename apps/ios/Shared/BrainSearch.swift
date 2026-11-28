import Foundation

// Custom brain search (v0.38.0).
//
// The curated library (ModelManifest.swift) stays the front
// door: three vetted brains, one tap each. This file is the
// Advanced door behind it — search Hugging Face's public
// GGUF catalog from the phone, see which files can actually
// run on THIS iPhone, and download one into the same library,
// where it lives as a normal entry: downloadable through the
// v0.28.0 background machinery, verifiable, selectable via
// "Use this brain", deletable.
//
// Honesty rules, enforced here rather than in copy alone:
//   - Searched brains are third-party models, straight from
//     their makers; GUS has not vetted them. The search
//     screen says so once, plainly.
//   - A file is only offered when it FITS this iPhone
//     (BrainFit below); a file that doesn't fit shows why,
//     with no download button to argue with.
//   - Verification degrades honestly: size is always
//     checked; sha256 is checked when the repo publishes
//     one (the file's LFS oid). When it doesn't, the entry
//     says "checksum not published by the repo" instead of
//     pretending a check happened.
//   - A repo's mmproj (vision projector) files are never
//     downloaded in v1. They drive the Vision badge, with
//     its caption: the file exists, but GUS's on-device
//     vision is not wired yet — the brain runs as a text
//     brain.

// MARK: - Fit logic (pure)

/// Can a GGUF file of this size run on an iPhone with this
/// much physical memory? Pure functions of (fileBytes,
/// physicalMemory) so the suite can pin the formula.
///
/// THE CAP: a brain file may be at most 40% of the phone's
/// physical RAM. Why 40%:
///   - The file is only the floor of the cost. Mapped in,
///     the weights are resident; llama.cpp adds a KV cache
///     and compute buffers on top, and GUS itself (Kokoro's
///     assets, speech, the UI) plus iOS's own footprint must
///     all fit under the per-app memory ceiling, which on
///     this phone class sits far below total RAM — an app
///     that brushes it is killed mid-conversation.
///   - The proven data point: the curated 2.5 GB Q4_K_M 4B
///     runs well on the 8 GB Pro Max class. 40% of 8 GB is
///     ~3.2 GB — headroom above the proven brain, still far
///     from the ceiling. On a 12 GB phone the same fraction
///     yields ~4.8 GB, so the rule scales with the hardware
///     instead of hard-coding one phone's answer.
///   - Conservative on purpose: a brain the picker refuses
///     up front is a disappointment; a brain that loads and
///     gets the app killed mid-call is a betrayal.
enum BrainFit {
    /// The fraction of physical RAM a single brain file may
    /// occupy. See the cap rationale above.
    static let ramFraction = 0.40

    static func capBytes(physicalMemory: UInt64) -> Int64 {
        Int64(Double(physicalMemory) * ramFraction)
    }

    static func fits(fileBytes: Int64, physicalMemory: UInt64) -> Bool {
        fileBytes > 0 && fileBytes <= capBytes(physicalMemory: physicalMemory)
    }

    /// Why not, in a person's words — the file row shows
    /// this where the Download button would have been.
    static func reason(fileBytes: Int64, physicalMemory: UInt64) -> String {
        let need = ByteCountFormatter.string(fromByteCount: fileBytes, countStyle: .file)
        let cap = ByteCountFormatter.string(
            fromByteCount: capBytes(physicalMemory: physicalMemory), countStyle: .file)
        return "Needs ~\(need) — more than this iPhone can give a brain (about \(cap))."
    }

    /// This device's own numbers, for the live UI.
    static var thisDeviceMemory: UInt64 { ProcessInfo.processInfo.physicalMemory }
    static func fitsOnThisDevice(fileBytes: Int64) -> Bool {
        fits(fileBytes: fileBytes, physicalMemory: thisDeviceMemory)
    }
    static func reasonOnThisDevice(fileBytes: Int64) -> String {
        reason(fileBytes: fileBytes, physicalMemory: thisDeviceMemory)
    }
}

// MARK: - The Find-a-brain menus (v0.47.0)

/// The Sort menu: the orderings the Hugging Face
/// models page leads with, mapped one-to-one onto the
/// API's sort values (all read newest/biggest first,
/// direction -1, in searchURL).
enum BrainSort: String, CaseIterable, Identifiable {
    case downloads
    case trending
    case lastModified

    var id: String { rawValue }

    /// The API's own spelling of this ordering.
    var hfValue: String { rawValue }

    var label: String {
        switch self {
        case .downloads: return "Most downloaded"
        case .trending: return "Trending"
        case .lastModified: return "Recently updated"
        }
    }
}

/// The Type menu: every brain, text-only brains, or
/// vision brains (repos carrying an mmproj projector —
/// the same signal the Vision badge reads).
enum BrainTypeFilter: String, CaseIterable, Identifiable {
    case all
    case textOnly
    case vision

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "All"
        case .textOnly: return "Text only"
        case .vision: return "Vision"
        }
    }
}

/// The Size menu: every size, or only what this iPhone
/// can run (BrainFit's 40%-of-RAM rule, applied to a
/// repo's file list when it opens).
enum BrainSizeFilter: String, CaseIterable, Identifiable {
    case all
    case fits

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "All sizes"
        case .fits: return "Fits this iPhone"
        }
    }
}

// MARK: - Hugging Face catalog shapes

/// One repo in the search results. `siblings` arrives with
/// the list response (file names only) and is used for one
/// thing: the Vision badge. The authoritative file list —
/// sizes and checksums included — comes from the tree
/// endpoint when the repo is opened (HFBrainFile below).
struct HFRepoResult: Decodable, Identifiable {
    let id: String
    let downloads: Int
    let siblings: [Sibling]?

    struct Sibling: Decodable {
        let rfilename: String
    }

    /// The repo carries a vision projector file. The brain
    /// itself still runs as a text brain (see the header).
    var hasVisionFiles: Bool {
        (siblings ?? []).contains { BrainCatalog.isVisionProjector(path: $0.rfilename) }
    }
}

/// One file in a repo's tree. For files stored in Git LFS —
/// every real GGUF — the entry's own `size` is the tiny
/// pointer file, NOT the model; the true size and the
/// sha256 live in the `lfs` object. A file with no `lfs`
/// object is a small file stored directly in git, whose
/// bytes are its size and which has no published sha256.
struct HFTreeEntry: Decodable {
    let type: String
    let path: String
    let size: Int64?
    let lfs: LFS?

    struct LFS: Decodable {
        let oid: String
        let size: Int64
    }
}

/// One runnable brain file in a repo, distilled from its
/// tree entry: catalog path, display name, true byte size,
/// the published sha256 when there is one, the quant parsed
/// from the file name, and whether it is one shard of a
/// split brain (GUS loads single files in v1, so a shard is
/// listed but never offered for download).
struct HFBrainFile: Identifiable {
    let path: String
    let bytes: Int64
    let sha256: String?
    let isSplitShard: Bool

    var id: String { path }
    var fileName: String { (path as NSString).lastPathComponent }

    /// The quant token in the file name ("Q4_K_M", "Q8_0",
    /// "IQ2_XS", "F16") — shown so a person picking between
    /// files in one repo can tell them apart. Nil when the
    /// name carries no recognizable token.
    var quant: String? { BrainCatalog.quant(inFileName: fileName) }
}

enum BrainCatalog {
    /// A vision projector file (mmproj*.gguf) — never a
    /// brain, wherever it sits in the repo.
    static func isVisionProjector(path: String) -> Bool {
        let name = (path as NSString).lastPathComponent.lowercased()
        return name.hasPrefix("mmproj") && name.hasSuffix(".gguf")
    }

    /// Split-GGUF shard names look like
    /// "model-00001-of-00002.gguf": real brains, but a
    /// single downloaded shard cannot load on its own.
    static func isSplitShard(fileName: String) -> Bool {
        fileName.range(
            of: #"-\d{5}-of-\d{5}\.gguf$"#,
            options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func quant(inFileName name: String) -> String? {
        let pattern = #"(IQ\d[A-Z0-9_]*|Q\d_K_[SML]|Q\d_K|Q\d_\d|F16|F32|BF16)"#
        guard let range = name.range(
            of: pattern, options: [.regularExpression, .caseInsensitive])
        else { return nil }
        return String(name[range]).uppercased()
    }

    /// Distill a repo's tree into its brain files: GGUFs
    /// only, projectors excluded (they are not brains),
    /// sorted smallest-first within the repo so the file
    /// most likely to fit is the one seen first.
    static func brainFiles(fromTree entries: [HFTreeEntry]) -> [HFBrainFile] {
        entries
            .filter { $0.type == "file" }
            .filter { $0.path.lowercased().hasSuffix(".gguf") }
            .filter { !isVisionProjector(path: $0.path) }
            .map { entry in
                HFBrainFile(
                    path: entry.path,
                    bytes: entry.lfs?.size ?? entry.size ?? 0,
                    sha256: entry.lfs?.oid,
                    isSplitShard: isSplitShard(fileName: (entry.path as NSString).lastPathComponent))
            }
            .sorted { $0.bytes < $1.bytes }
    }

    /// The tree's own word on vision files — the badge the
    /// file list shows once the repo is actually opened
    /// (authoritative where the search list's siblings are
    /// best-effort).
    static func treeHasVisionFiles(_ entries: [HFTreeEntry]) -> Bool {
        entries.contains { isVisionProjector(path: $0.path) }
    }

    static func searchURL(query: String) -> URL {
        searchURL(query: query, sort: .downloads)
    }

    /// The catalog query (v0.47.0): the sort is the
    /// person's pick from the Sort menu, mapped to the
    /// API's own sort values; an empty query omits the
    /// search term entirely — that is the Popular list,
    /// the screen's opening content, so the Advanced
    /// door never opens onto an empty room.
    static func searchURL(query: String, sort: BrainSort) -> URL {
        var components = URLComponents(string: "https://huggingface.co/api/models")!
        var items: [URLQueryItem] = []
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            items.append(URLQueryItem(name: "search", value: trimmed))
        }
        items.append(URLQueryItem(name: "filter", value: "gguf"))
        items.append(URLQueryItem(name: "sort", value: sort.hfValue))
        items.append(URLQueryItem(name: "direction", value: "-1"))
        items.append(URLQueryItem(name: "limit", value: "30"))
        components.queryItems = items
        return components.url!
    }

    /// The Type menu's verdict on one repo (v0.47.0),
    /// from the list response's own siblings: Vision
    /// means the repo carries an mmproj projector;
    /// Text only means it doesn't. Pure, so the suite
    /// pins the mapping.
    static func repoMatchesType(_ repo: HFRepoResult, type: BrainTypeFilter) -> Bool {
        switch type {
        case .all: return true
        case .vision: return repo.hasVisionFiles
        case .textOnly: return !repo.hasVisionFiles
        }
    }

    /// The Size menu's view of one repo's files
    /// (v0.47.0): with "Fits this iPhone" picked, only
    /// files this iPhone can actually run remain —
    /// fitting, and never a split shard (a shard cannot
    /// load at all, fitting or not). Pure in (files,
    /// fitsOnly, physicalMemory), like BrainFit itself.
    static func visibleFiles(
        _ files: [HFBrainFile], fitsOnly: Bool, physicalMemory: UInt64
    ) -> [HFBrainFile] {
        guard fitsOnly else { return files }
        return files.filter {
            !$0.isSplitShard && BrainFit.fits(fileBytes: $0.bytes, physicalMemory: physicalMemory)
        }
    }

    static func treeURL(repoID: String) -> URL {
        var components = URLComponents(string: "https://huggingface.co/api/models/\(repoID)/tree/main")!
        components.queryItems = [URLQueryItem(name: "recursive", value: "true")]
        return components.url!
    }

    /// The file's download URL. Each path component is
    /// percent-encoded; the slashes between them are the
    /// repo's own structure and stay.
    static func resolveURL(repoID: String, path: String) -> URL {
        let encodedPath = path
            .split(separator: "/", omittingEmptySubsequences: false)
            .map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }
            .joined(separator: "/")
        return URL(string: "https://huggingface.co/\(repoID)/resolve/main/\(encodedPath)")!
    }
}

// MARK: - The search itself

/// The Advanced door's working state: the query, the
/// results, and each opened repo's file list. All network
/// failures land as plain words a person can act on; an
/// empty result set is a sentence, not an error.
@MainActor
final class BrainSearchModel: ObservableObject {
    enum SearchState: Equatable {
        case idle
        case searching
        case failed(String)
        case done
    }

    @Published var query = ""
    /// The Find-a-brain menus (v0.47.0). Sort rides the
    /// API query itself; Type filters the result list
    /// where it stands; Size filters an opened repo's
    /// file list. Changing Sort re-runs whatever list is
    /// on screen (the search, or Popular when no search
    /// has run).
    @Published var sort: BrainSort = .downloads
    @Published var typeFilter: BrainTypeFilter = .all
    @Published var sizeFilter: BrainSizeFilter = .all
    @Published private(set) var state: SearchState = .idle
    @Published private(set) var results: [HFRepoResult] = []
    /// True while `results` is the Popular list (the
    /// opening content) rather than a search's answer —
    /// the section header says which it is.
    @Published private(set) var isPopular = false

    /// The results as the Type menu leaves them.
    var displayedResults: [HFRepoResult] {
        results.filter { BrainCatalog.repoMatchesType($0, type: typeFilter) }
    }
    /// File lists by repo id, filled on first expansion.
    @Published private(set) var filesByRepo: [String: [HFBrainFile]] = [:]
    @Published private(set) var visionByRepo: [String: Bool] = [:]
    @Published private(set) var loadingRepos: Set<String> = []
    @Published private(set) var filesFailed: [String: String] = [:]

    func search() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await load(query: trimmed, popular: false)
    }

    /// The opening content (v0.47.0): the catalog's top
    /// GGUF brains under the current Sort, fetched the
    /// first time the screen appears — the Advanced door
    /// never opens onto an empty search box.
    func loadPopularIfNeeded() async {
        guard state == .idle else { return }
        await load(query: "", popular: true)
    }

    /// A Sort change re-runs the list on screen: the
    /// search when one stands, Popular otherwise.
    func applySort() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if isPopular || trimmed.isEmpty {
            await load(query: "", popular: true)
        } else {
            await load(query: trimmed, popular: false)
        }
    }

    private func load(query: String, popular: Bool) async {
        state = .searching
        do {
            let (data, response) = try await URLSession.shared.data(
                from: BrainCatalog.searchURL(query: query, sort: sort))
            try Self.requireOK(response)
            results = try JSONDecoder().decode([HFRepoResult].self, from: data)
            isPopular = popular
            state = .done
        } catch {
            results = []
            state = .failed(Self.plainWords(for: error))
        }
    }

    /// Fetch a repo's brain files (once; the result is
    /// cached for the life of this search screen).
    func loadFiles(for repoID: String) async {
        guard filesByRepo[repoID] == nil, !loadingRepos.contains(repoID) else { return }
        loadingRepos.insert(repoID)
        defer { loadingRepos.remove(repoID) }
        do {
            let (data, response) = try await URLSession.shared.data(
                from: BrainCatalog.treeURL(repoID: repoID))
            try Self.requireOK(response)
            let tree = try JSONDecoder().decode([HFTreeEntry].self, from: data)
            filesByRepo[repoID] = BrainCatalog.brainFiles(fromTree: tree)
            visionByRepo[repoID] = BrainCatalog.treeHasVisionFiles(tree)
            filesFailed[repoID] = nil
        } catch {
            filesFailed[repoID] = Self.plainWords(for: error)
        }
    }

    private static func requireOK(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse, http.statusCode != 200 else { return }
        throw SearchFailure.http(http.statusCode)
    }

    private enum SearchFailure: Error {
        case http(Int)
    }

    private static func plainWords(for error: Error) -> String {
        if case SearchFailure.http(let code) = error {
            return "Hugging Face answered with an error (HTTP \(code)). Try again in a moment."
        }
        if error is URLError {
            return "Couldn't reach Hugging Face — check your connection and try again."
        }
        return "Something went wrong reading Hugging Face's answer. Try again."
    }
}

// MARK: - Custom brains in the library

/// The registry of brains the person found through search.
/// A record is everything a ModelDownloadEntry needs, and
/// it persists in UserDefaults under its own key — the
/// library's own persistence, deliberately NOT the download
/// records (gus.modelDownloads.records), which track tasks
/// in flight and are cleared as downloads settle. A custom
/// entry therefore survives launches, relaunches, and its
/// own deletion-and-redownload cycle, exactly like a
/// curated entry's place in the manifest.
final class CustomBrainStore: ObservableObject {
    static let shared = CustomBrainStore()

    static let defaultsKey = "gus.brains.custom"
    /// Every custom entry id carries this prefix — the
    /// "Custom" marker the library rows show is derived
    /// from it, so the distinction can never drift from
    /// the identity.
    static let idPrefix = "custom-"

    struct Record: Codable, Equatable {
        let id: String
        let repoID: String
        /// The file's path inside the repo (what the
        /// resolve URL carries).
        let path: String
        /// The name the file has ON DISK. Prefixed with the
        /// repo so two repos shipping a file of the same
        /// name can never overwrite each other in
        /// ModelStore's flat directory.
        let diskFileName: String
        let bytes: Int64
        /// The repo-published sha256 (the file's LFS oid),
        /// or nil when the repo publishes none — the entry
        /// then verifies by size only, and says so.
        let sha256: String?
    }

    @Published private(set) var records: [Record] = []

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
           let decoded = try? JSONDecoder().decode([Record].self, from: data) {
            records = decoded
        }
    }

    private func persist() {
        if records.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.defaultsKey)
        } else if let data = try? JSONEncoder().encode(records) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
    }

    /// The library id for one repo file: derived from the
    /// repo and the file, lowercased, with anything that
    /// isn't a letter, digit, or dash folded to a dash —
    /// stable across launches, unique per repo+file.
    static func makeID(repoID: String, path: String) -> String {
        let raw = repoID + "-" + (path as NSString).lastPathComponent
        var folded = ""
        for ch in raw.lowercased() {
            folded.append((ch.isLetter || ch.isNumber || ch == "-") ? ch : "-")
        }
        return idPrefix + folded
    }

    static func diskFileName(repoID: String, path: String) -> String {
        repoID.replacingOccurrences(of: "/", with: "-") + "-" + (path as NSString).lastPathComponent
    }

    /// Register a searched file as a library entry (or
    /// return the entry already registered for it — adding
    /// the same brain twice is one entry, never two).
    @discardableResult
    func add(repoID: String, file: HFBrainFile) -> ModelDownloadEntry {
        let id = Self.makeID(repoID: repoID, path: file.path)
        if let existing = entry(id: id) { return existing }
        let record = Record(
            id: id,
            repoID: repoID,
            path: file.path,
            diskFileName: Self.diskFileName(repoID: repoID, path: file.path),
            bytes: file.bytes,
            sha256: file.sha256)
        records.append(record)
        persist()
        return Self.entry(for: record)
    }

    func entry(id: String) -> ModelDownloadEntry? {
        records.first(where: { $0.id == id }).map(Self.entry(for:))
    }

    var entries: [ModelDownloadEntry] {
        records.map(Self.entry(for:))
    }

    static func entry(for record: Record) -> ModelDownloadEntry {
        let repoName = (record.repoID as NSString).lastPathComponent
        let quant = BrainCatalog.quant(inFileName: (record.path as NSString).lastPathComponent)
        var description = "Custom brain from \(record.repoID) on Hugging Face — not vetted by GUS."
        if record.sha256 == nil {
            description += " Checksum not published by the repo — GUS checks this file's size only."
        }
        return ModelDownloadEntry(
            id: record.id,
            fileName: record.diskFileName,
            url: BrainCatalog.resolveURL(repoID: record.repoID, path: record.path),
            bytes: record.bytes,
            sha256: record.sha256,
            plainName: quant.map { "\(repoName) (\($0))" } ?? repoName,
            plainDescription: description)
    }
}
