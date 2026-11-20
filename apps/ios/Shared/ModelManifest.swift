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
//     Two entries today: the on-device brain, and one OPTIONAL
//     alternative brain that nothing downloads or loads yet —
//     model selection is the next chunk; the entry lands now
//     so its pins are reviewed and on record.
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
        sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597"
    )

    /// The first ALTERNATIVE brain (v0.15.4): huihui-ai's
    /// abliterated Qwen3-4B-Instruct-2507 — the same base
    /// model with its refusal direction removed
    /// ("uncensored-style") — in mradermacher's GGUF
    /// conversion, at the same Q4_K_M. It exists because the
    /// library's point is CHOICE of character (Glenn,
    /// 2026-11-20: an uncensored model is one example flavor
    /// an operator may want on their own phone). OPTIONAL
    /// and inert in this build: ModelLibrary still manages
    /// only `brain`, and no selection UI exists yet — that
    /// plumbing is the next chunk. Pins verified against the
    /// Hugging Face API (siblings/lfs) on 2026-11-20.
    static let brainAbliterated = ModelDownloadEntry(
        id: "brain-qwen3-4b-instruct-2507-abliterated-q4km",
        fileName: "Huihui-Qwen3-4B-Instruct-2507-abliterated.Q4_K_M.gguf",
        url: URL(string: "https://huggingface.co/mradermacher/Huihui-Qwen3-4B-Instruct-2507-abliterated-GGUF/resolve/main/Huihui-Qwen3-4B-Instruct-2507-abliterated.Q4_K_M.gguf")!,
        bytes: 2_497_281_312,
        sha256: "b1324e2f1bd2e0610d591f54f93e38d90b187f69d1f215f4cace349eade678d7"
    )

    static let downloads: [ModelDownloadEntry] = [brain, brainAbliterated]
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
