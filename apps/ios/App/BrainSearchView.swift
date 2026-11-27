import SwiftUI

/// Find a brain (v0.38.0) — the Advanced door behind the
/// curated library. Search Hugging Face's public GGUF
/// catalog, open a repo to see its brain files with their
/// sizes and this iPhone's fit verdict for each, and
/// download one into the library, where it becomes a
/// normal entry (BrainRowView, "Use this brain", delete).
///
/// The screen's honesty, stated once at the top and then
/// enforced by the machinery rather than repeated: these
/// are third-party models GUS has not vetted; a file that
/// cannot run on this iPhone gets no download button; a
/// repo's vision files are badged, never downloaded.
struct BrainSearchView: View {
    @StateObject private var search = BrainSearchModel()
    @ObservedObject private var customBrains = CustomBrainStore.shared
    @State private var expandedRepo: String?

    var body: some View {
        List {
            Section {
                Text("These brains come straight from Hugging Face and aren't vetted by GUS. Shield still scans your conversations as always.")
                    .font(.callout)
                    .foregroundColor(.secondary)
            }
            Section {
                HStack {
                    TextField("Search for a brain…", text: $search.query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { runSearch() }
                    Button("Search") { runSearch() }
                        .disabled(search.query.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            results
        }
        .navigationTitle("Find a brain")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func runSearch() {
        expandedRepo = nil
        Task { await search.search() }
    }

    @ViewBuilder
    private var results: some View {
        switch search.state {
        case .idle:
            Section {
                Text("Type to search Hugging Face for a brain.")
                    .foregroundColor(.secondary)
            }
        case .searching:
            Section {
                ProgressView() { Text("Searching Hugging Face…").font(.callout) }
            }
        case .failed(let message):
            Section {
                Text(message)
                    .font(.callout)
                    .foregroundColor(.orange)
            }
        case .done:
            if search.results.isEmpty {
                Section {
                    Text("No brains matched that search.")
                        .foregroundColor(.secondary)
                }
            } else {
                Section {
                    ForEach(search.results) { repo in
                        repoRow(repo)
                    }
                } header: {
                    Text("Results")
                } footer: {
                    Text("Tap a result to see its brain files. Only files that fit this iPhone can be downloaded.")
                }
            }
        }
    }

    private func repoRow(_ repo: HFRepoResult) -> some View {
        let expanded = expandedRepo == repo.id
        let hasVision = repo.hasVisionFiles || search.visionByRepo[repo.id] == true
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                expandedRepo = expanded ? nil : repo.id
                if !expanded { Task { await search.loadFiles(for: repo.id) } }
            } label: {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(repo.id)
                            .font(.callout)
                            .foregroundColor(.primary)
                        Text("\(repo.downloads.formatted(.number)) downloads")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    if hasVision {
                        Text("Vision")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundColor(.secondary)
                    }
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .buttonStyle(.plain)
            if expanded {
                if hasVision {
                    Text("This repo also carries vision files (mmproj). GUS's on-device vision isn't wired yet — the brain works as a text brain.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                repoFiles(repo)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func repoFiles(_ repo: HFRepoResult) -> some View {
        if search.loadingRepos.contains(repo.id) {
            ProgressView() { Text("Looking at its files…").font(.caption) }
        } else if let failure = search.filesFailed[repo.id] {
            Text(failure)
                .font(.caption)
                .foregroundColor(.orange)
        } else if let files = search.filesByRepo[repo.id] {
            if files.isEmpty {
                Text("No runnable brain files in this repo.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                ForEach(files) { file in
                    BrainFileRow(repoID: repo.id, file: file)
                }
            }
        }
    }
}

/// One brain file inside an opened repo: its name, quant
/// and size, this iPhone's fit verdict, and — when the
/// verdict allows and the brain isn't in the library yet —
/// the Download button that registers it as a custom entry
/// and starts the library's own background download. Once
/// registered, the row IS the library row, so state,
/// progress, "Use this brain", and delete are the same
/// controls here as in Settings.
private struct BrainFileRow: View {
    let repoID: String
    let file: HFBrainFile
    @ObservedObject private var library = ModelLibrary.shared
    @ObservedObject private var customBrains = CustomBrainStore.shared

    private var entryID: String { CustomBrainStore.makeID(repoID: repoID, path: file.path) }
    private var existingEntry: ModelDownloadEntry? { customBrains.entry(id: entryID) }
    private var fits: Bool { BrainFit.fitsOnThisDevice(fileBytes: file.bytes) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let entry = existingEntry {
                BrainRowView(entry: entry)
            } else {
                Text(file.fileName)
                    .font(.callout)
                Text(detailLine)
                    .font(.caption)
                    .foregroundColor(.secondary)
                if file.isSplitShard {
                    Text("Split into parts — GUS can't load split brains yet.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else if !fits {
                    Text(BrainFit.reasonOnThisDevice(fileBytes: file.bytes))
                        .font(.caption)
                        .foregroundColor(.orange)
                } else {
                    Text("Fits this iPhone.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Button("Download") {
                        let entry = customBrains.add(repoID: repoID, file: file)
                        library.download(entry)
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .padding(.leading, 12)
    }

    private var detailLine: String {
        let size = ByteCountFormatter.string(fromByteCount: file.bytes, countStyle: .file)
        if let quant = file.quant {
            return "\(quant) · \(size)"
        }
        return size
    }
}
