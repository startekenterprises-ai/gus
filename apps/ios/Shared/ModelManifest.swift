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
//     Three entries: the standard brain (the one required
//     entry, and the first-launch prompt's download) plus two
//     OPTIONAL alternative brains the library offers as a
//     choice of character. Any of them may sit on disk at
//     once; ActiveBrain (below) says which one loads.
//   - sdkManaged: the Kokoro CoreML assets are fetched and
//     hash-verified by the pinned FluidAudio SDK against its
//     own pinned manifest (KokoroTTS.swift). They are listed
//     in manifest.json for the record; the app does not
//     re-download what the SDK already verifies.

struct ModelDownloadEntry: Equatable {
    let id: String
    let fileName: String
    let url: URL
    let bytes: Int64
    let sha256: String
    /// The name a person sees in the library and the setup
    /// prompt — plain words, never a repo name or a file name.
    let plainName: String
    /// One honest line about this brain's character, in the
    /// same plain words. Describes; never moralizes.
    let plainDescription: String

    /// The size as a person would say it ("2.5 GB").
    var sizeText: String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
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

    static let downloads: [ModelDownloadEntry] = [brain, brainAbliterated, brainAggressive]

    static func entry(id: String) -> ModelDownloadEntry? {
        downloads.first(where: { $0.id == id })
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
        return GUSModelManifest.downloads.first(where: { ModelStore.isPresent($0) })
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

    /// Present means: the file exists AND is the manifest's
    /// byte size. (Full sha256 verification happens at download
    /// time and on demand in Settings; size is the cheap gate
    /// the call path uses, and a truncated file fails it.)
    static func isPresent(_ entry: ModelDownloadEntry) -> Bool {
        let url = fileURL(for: entry)
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? NSNumber else { return false }
        return size.int64Value == entry.bytes
    }

    static func remove(_ entry: ModelDownloadEntry) {
        try? FileManager.default.removeItem(at: fileURL(for: entry))
    }
}
