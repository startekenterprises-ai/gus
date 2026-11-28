import Foundation

// On-device model delivery (v0.15.0 chunk 2, R4 M1).
//
// Model weights are NEVER in git and never in the app bundle
// (the push path is text-only, and 2.8 GB of weights has no
// business in either). The repo carries the manifest of record
// (apps/ios/Models/manifest.json: pinned HTTPS URL + sha256 +
// byte size per file); this file embeds the entries the APP
// itself downloads and verifies. test/unit/ios-ondevice-models
// .test.ts keeps the two in sync — edit the manifest first,
// then this file, and the suite will say if they drift.
//
// Two delivery classes, named honestly:
//   - downloads: fetched by ModelLibrary (ModelDownloader.swift)
//     into Application Support, sha256-verified before use.
//     Four entries: the standard brain (the one required
//     entry, and the first-launch prompt's download), two
//     OPTIONAL alternative brains the library offers as a
//     choice of character, and (v0.48.0) the vision brain —
//     a PAIR entry whose model file travels with a vision
//     projector file (see ProjectorFile). Any of them may
//     sit on disk at once; ActiveBrain (below) says which
//     one loads.
//   - sdkManaged: the Kokoro CoreML assets are fetched and
//     hash-verified by the pinned FluidAudio SDK against its
//     own pinned manifest (KokoroTTS.swift). They are listed
//     in manifest.json for the record; the app does not
//     re-download what the SDK already verifies.

/// The vision projector half of a PAIR entry (v0.48.0): a
/// vision brain is two files — the language model and the
/// mmproj that turns pixels into tokens the model can read.
/// The pair downloads together, verifies together, and the
/// entry counts as present only when BOTH files are on disk
/// at their pinned sizes (ModelStore.isPresent). Only the
/// curated vision entry carries one; brain SEARCH never
/// pairs (a searched repo's mmproj still only earns the
/// Vision badge in the search results — see BrainSearch).
struct ProjectorFile: Equatable {
    let fileName: String
    let url: URL
    let bytes: Int64
    let sha256: String
}

struct ModelDownloadEntry: Equatable {
    let id: String
    let fileName: String
    let url: URL
    let bytes: Int64
    /// The sha256 the download is verified against before
    /// use. Curated entries always carry one (the manifest
    /// pins it). A custom entry (BrainSearch.swift) carries
    /// the repo-published hash when Hugging Face has one —
    /// and nil when the repo publishes none, in which case
    /// verification is by size alone and the entry's own
    /// description says so (v0.38.0).
    let sha256: String?
    /// The name a person sees in the library and the setup
    /// prompt — plain words, never a repo name or a file name.
    let plainName: String
    /// One honest line about this brain's character, in the
    /// same plain words. Describes; never moralizes.
    let plainDescription: String
    /// The vision projector this entry pairs with (v0.48.0),
    /// or nil for an ordinary single-file brain. Defaulted
    /// so every existing construction site (the manifest
    /// entries above, the custom-brain builder in
    /// BrainSearch.swift) reads unchanged.
    let projector: ProjectorFile? = nil

    /// The size as a person would say it ("2.5 GB"). For a
    /// pair entry this is the COMBINED size — the download
    /// the person is actually agreeing to is both files.
    var sizeText: String {
        ByteCountFormatter.string(fromByteCount: totalBytes, countStyle: .file)
    }

    /// Model + projector combined (just the model for a
    /// single-file entry). The BrainFit gate judges a pair
    /// by this number: the two files load together, so the
    /// cap that keeps one brain from crowding the phone's
    /// memory must see them together too.
    var totalBytes: Int64 { bytes + (projector?.bytes ?? 0) }

    /// Suffix marking a pair's projector leg in the
    /// download machinery (ModelLibrary keys its tasks,
    /// records, and per-leg states by leg id: the entry's
    /// own id for the model leg, id + this suffix for the
    /// projector leg).
    static let projectorLegSuffix = "#mmproj"

    /// This entry's projector-leg id (meaningful only when
    /// projector != nil).
    var projectorLegID: String { id + Self.projectorLegSuffix }

    /// The projector file dressed as a download entry of
    /// its own, so ModelLibrary's existing per-file
    /// machinery (background task, verify-before-use,
    /// launch reconciliation) carries the second leg
    /// unchanged. Nil for a single-file entry.
    func projectorLegEntry() -> ModelDownloadEntry? {
        guard let projector else { return nil }
        return ModelDownloadEntry(
            id: projectorLegID,
            fileName: projector.fileName,
            url: projector.url,
            bytes: projector.bytes,
            sha256: projector.sha256,
            plainName: plainName,
            plainDescription: plainDescription)
    }
}

enum GUSModelManifest {
    /// The on-device brain: Qwen3-4B-Instruct-2507 at Q4_K_M
    /// (Apache-2.0; unsloth's GGUF of Qwen's official weights).
    /// A 4B-class model is the largest that RUNS WELL on a Pro
    /// Max (spec: RAM and thermals bind, not the store cap).
    /// Non-thinking instruct build: voice wants direct spoken
    /// answers, not visible reasoning.
    static let brain = ModelDownloadEntry(
        id: "brain-qwen3-4b-instruct-2507-q4km",
        fileName: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        url: URL(string: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf")!,
        bytes: 2_497_281_120,
        sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
        plainName: "Standard brain",
        plainDescription: "The regular GUS brain — helpful, even-handed, and happy to talk about almost anything. The one most people want."
    )

    /// The first ALTERNATIVE brain (v0.15.4): huihui-ai's
    /// abliterated Qwen3-4B-Instruct-2507 — the same base
    /// model with its refusal direction removed
    /// ("uncensored-style") — in mradermacher's GGUF
    /// conversion, at the same Q4_K_M. It exists because the
    /// library's point is CHOICE of character (Glenn,
    /// 2026-11-20: an uncensored model is one example flavor
    /// an operator may want on their own phone). Pins
    /// verified against the Hugging Face API (siblings/lfs)
    /// on 2026-11-20. Wired as a real library choice in
    /// v0.21.0 — downloadable, deletable, selectable.
    static let brainAbliterated = ModelDownloadEntry(
        id: "brain-qwen3-4b-instruct-2507-abliterated-q4km",
        fileName: "Huihui-Qwen3-4B-Instruct-2507-abliterated.Q4_K_M.gguf",
        url: URL(string: "https://huggingface.co/mradermacher/Huihui-Qwen3-4B-Instruct-2507-abliterated-GGUF/resolve/main/Huihui-Qwen3-4B-Instruct-2507-abliterated.Q4_K_M.gguf")!,
        bytes: 2_497_281_312,
        sha256: "b1324e2f1bd2e0610d591f54f93e38d90b187f69d1f215f4cace349eade678d7",
        plainName: "Open brain",
        plainDescription: "The same brain with its built-in refusals removed — it will take on topics the standard brain declines. Which topics you bring to it is your call."
    )

    /// The second alternative (v0.21.0): HauhauCS's
    /// "Aggressive" uncensored build of the same
    /// Qwen3-4B-Instruct-2507, at the same Q4_K_M — the
    /// least filtered of the three. Pins verified against
    /// the Hugging Face repo itself (tree API: the Q4_K_M
    /// file's LFS oid IS its sha256, and its LFS size) on
    /// 2026-11-27 — repo HauhauCS/Qwen3-4B-2507-Instruct-
    /// Uncensored-HauhauCS-Aggressive, Apache-2.0.
    static let brainAggressive = ModelDownloadEntry(
        id: "brain-qwen3-4b-instruct-2507-hauhaucs-aggressive-q4km",
        fileName: "Qwen3-4B-2507-Instruct-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf",
        url: URL(string: "https://huggingface.co/HauhauCS/Qwen3-4B-2507-Instruct-Uncensored-HauhauCS-Aggressive/resolve/main/Qwen3-4B-2507-Instruct-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf")!,
        bytes: 2_497_278_912,
        sha256: "6615b7b5184931e4df9c6d0ae9cd29ca9319b73908d4423283d4cc401a12a1cd",
        plainName: "Most open brain",
        plainDescription: "The least filtered of the three — tuned to almost never refuse a topic. Same size, the strongest change of character."
    )

    /// The vision brain (v0.48.0): Qwen2.5-VL-3B-Instruct
    /// at Q4_K_M, in the llama.cpp project's own GGUF
    /// conversion (ggml-org) — the same project's pins the
    /// runtime already trusts — paired with its Q8_0 vision
    /// projector. Pins verified against the Hugging Face
    /// tree API (each file's LFS oid is its sha256, its LFS
    /// size the byte count) on 2026-11-28. Combined
    /// 2,774,658,784 bytes: inside the 40%-of-RAM BrainFit
    /// cap on an 8 GB phone, outside it on a 6 GB one — the
    /// fit gate in the library is what keeps the offer off
    /// phones the pair cannot fit. Photo turns reach it
    /// through the isolated vision engine (VisionEngine
    /// .swift); as a text brain it loads through the
    /// ordinary text path like the other three.
    static let brainVision = ModelDownloadEntry(
        id: "brain-qwen25-vl-3b-instruct-q4km",
        fileName: "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
        url: URL(string: "https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf")!,
        bytes: 1_929_901_056,
        sha256: "d02fe9b69ad8cadbbd228e387667af66612c44bed29ffc8eb1e7caf9ac486c12",
        plainName: "Vision brain",
        plainDescription: "The brain that can see — attach a photo in a chat and it will tell you what's in it, right here on this iPhone. A smaller brain than the standard one, and looking takes longer than talking. In a call or a plain chat it talks like the others.",
        projector: ProjectorFile(
            fileName: "mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf",
            url: URL(string: "https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf")!,
            bytes: 844_757_728,
            sha256: "980c9b2f78c04e6cff93d277ada09e768394f112d75db3b4e9dea8a69f9fb904")
    )

    static let downloads: [ModelDownloadEntry] = [brain, brainAbliterated, brainAggressive, brainVision]

    static func entry(id: String) -> ModelDownloadEntry? {
        // The curated manifest first; a custom brain the
        // person found through search (v0.38.0) resolves
        // through the same door, so every holder of an id —
        // the library, the download delegate, ActiveBrain —
        // sees one library, not two.
        // A pair's projector leg (v0.48.0) resolves to the
        // projector dressed as an entry, so the download
        // delegate and launch reconciliation — which only
        // ever hold a task's id string — can carry the
        // second file through the same per-file path.
        let curatedOrLeg = downloads.first(where: { $0.id == id })
            ?? downloads.first(where: { $0.projectorLegID == id })?.projectorLegEntry()
        return curatedOrLeg ?? CustomBrainStore.shared.entry(id: id)
    }
}

/// Which brain the call and the chat load (v0.21.0). The
/// person's pick persists as a manifest id; RESOLUTION is
/// presence-aware, so the answer is always a brain that is
/// actually on the phone: the pick if it is downloaded, else
/// the standard brain if it is, else the first downloaded
/// entry in manifest order, else nil (no brain at all — the
/// first-launch setup prompt's cue). Deleting the picked
/// brain therefore falls back on its own, with no stale
/// pointer to clean up, and an install that has never picked
/// resolves exactly as it did before the library existed:
/// the standard brain.
enum ActiveBrain {
    static let defaultsKey = "gus.brain.activeID"

    static var selectedID: String? {
        get { UserDefaults.standard.string(forKey: defaultsKey) }
        set { UserDefaults.standard.set(newValue, forKey: defaultsKey) }
    }

    static func select(_ entry: ModelDownloadEntry) {
        selectedID = entry.id
    }

    static func resolved() -> ModelDownloadEntry? {
        if let id = selectedID,
           let picked = GUSModelManifest.entry(id: id),
           ModelStore.isPresent(picked) {
            return picked
        }
        if ModelStore.isPresent(GUSModelManifest.brain) {
            return GUSModelManifest.brain
        }
        if let curated = GUSModelManifest.downloads.first(where: { ModelStore.isPresent($0) }) {
            return curated
        }
        // Last resort (v0.38.0): a custom brain the person
        // found through search, when no curated brain is on
        // the phone at all — its presence is a real brain,
        // and the setup prompt must not claim otherwise.
        return CustomBrainStore.shared.entries.first(where: { ModelStore.isPresent($0) })
    }

    /// Any brain at all on this phone — the first-launch
    /// prompt shows exactly when this is false.
    static var anyPresent: Bool { resolved() != nil }
}

/// Where downloaded models live: Application Support/GUSModels.
/// Application Support (not Caches — iOS may purge Caches under
/// storage pressure, and a 2.5 GB brain should not vanish
/// silently; not Documents — these are not user documents).
enum ModelStore {
    static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("GUSModels", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func fileURL(for entry: ModelDownloadEntry) -> URL {
        directory.appendingPathComponent(entry.fileName)
    }

    /// Where a pair entry's projector file lives (v0.48.0).
    static func projectorURL(for entry: ModelDownloadEntry) -> URL? {
        guard let projector = entry.projector else { return nil }
        return directory.appendingPathComponent(projector.fileName)
    }

    /// One file's presence: it exists AND is the pinned
    /// byte size. (Full sha256 verification happens at download
    /// time and on demand in Settings; size is the cheap gate
    /// the call path uses, and a truncated file fails it.)
    static func filePresent(fileName: String, bytes: Int64) -> Bool {
        let url = directory.appendingPathComponent(fileName)
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? NSNumber else { return false }
        return size.int64Value == bytes
    }

    /// Present means every file the entry needs is present:
    /// the model file, and — for a pair entry (v0.48.0) —
    /// its projector too. A vision brain with only half its
    /// pair on disk is NOT present: ActiveBrain never
    /// resolves to it, so no surface can promise seeing
    /// with half an engine.
    static func isPresent(_ entry: ModelDownloadEntry) -> Bool {
        guard filePresent(fileName: entry.fileName, bytes: entry.bytes) else { return false }
        if let projector = entry.projector {
            return filePresent(fileName: projector.fileName, bytes: projector.bytes)
        }
        return true
    }

    static func remove(_ entry: ModelDownloadEntry) {
        try? FileManager.default.removeItem(at: fileURL(for: entry))
        if let projectorURL = projectorURL(for: entry) {
            try? FileManager.default.removeItem(at: projectorURL)
        }
    }
}
