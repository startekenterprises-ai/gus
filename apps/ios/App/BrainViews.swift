import SwiftUI

/// The brain library's rows and the first-launch setup sheet
/// (v0.21.0). The words here are the mom-test surface: a brain
/// is a "brain", a download is a download, and nothing on
/// either screen names a file, a format, or a repository.
/// The technical record lives in the manifest, not the UI.

/// One brain in the library: plain name, one honest line
/// about its character, its size, its state on this phone,
/// and the controls that state allows. Used by Settings'
/// On-device models section and by the setup sheet's
/// Advanced path — the same row in both, so the two never
/// drift apart.
struct BrainRowView: View {
    let entry: ModelDownloadEntry
    @ObservedObject private var library = ModelLibrary.shared

    private var isActive: Bool { library.activeEntryID == entry.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(entry.plainName)
                    .font(.callout)
                if entry.id.hasPrefix(CustomBrainStore.idPrefix) {
                    // A brain found through search (v0.38.0),
                    // marked everywhere it appears so it is
                    // never mistaken for a curated one.
                    Text("Custom")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundColor(.secondary)
                }
                if isActive {
                    Text("Active")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundColor(.accentColor)
                }
            }
            Text(entry.plainDescription)
                .font(.caption)
                .foregroundColor(.secondary)
            if entry.sha256 == nil {
                Text("\(entry.sizeText) download, size-checked before use — this repo publishes no checksum.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                Text("\(entry.sizeText) download, checked before use.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            if entry.projector != nil && !BrainFit.fitsOnThisDevice(fileBytes: entry.totalBytes) {
                // v0.48.0: a pair entry whose COMBINED size
                // breaks this phone's memory cap is not
                // offered at all — no Download button, just
                // the plain reason. (ModelLibrary holds the
                // same gate at its door; this is where the
                // person meets it.)
                Text("Too big for this iPhone — this brain needs more memory than this phone can give it, so it isn't offered here.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
            switch library.state(of: entry) {
            case .notDownloaded:
                Button("Download") { library.download(entry) }
            case .downloading(let fraction):
                ProgressView(value: fraction) {
                    Text("Downloading… \(Int(fraction * 100))%")
                        .font(.caption)
                }
                Button("Cancel download") { library.cancelDownload(entry) }
            case .verifying:
                ProgressView() { Text("Checking it over…").font(.caption) }
            case .ready:
                Text("On this iPhone.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                HStack {
                    if !isActive {
                        Button("Use this brain") { library.useBrain(entry) }
                    }
                    Button("Verify again") { library.verify(entry) }
                    Button("Delete", role: .destructive) { library.delete(entry) }
                }
                .font(.callout)
            case .failed(let message):
                Text(message)
                    .font(.caption)
                    .foregroundColor(.orange)
                Button("Try again") { library.download(entry) }
            }
            }
        }
        .padding(.vertical, 2)
    }
}

/// The first-launch brain setup (v0.21.0). Shown by RootView
/// when the signed-in shell opens and NO brain is on the
/// phone — a fresh install, or an install whose brains were
/// all deleted. It is a sheet, not a wall: it can be swiped
/// away (Core mode works without any brain), and it comes
/// back on a later launch only while the phone still has no
/// brain. The moment any brain is ready — downloaded here or
/// in the Advanced list — it dismisses itself.
///
/// The simple path is one button: the standard brain, its
/// size, and the fact that this happens once. Advanced is
/// the library itself, for anyone who wants a different
/// first brain.
struct BrainSetupSheet: View {
    @ObservedObject private var library = ModelLibrary.shared
    @Environment(\.dismiss) private var dismiss
    @State private var showAdvanced = false

    private var standard: ModelDownloadEntry { GUSModelManifest.brain }

    var body: some View {
        Group {
            if showAdvanced {
                advanced
            } else {
                simple
            }
        }
        .onChange(of: library.anyBrainReady) { ready in
            if ready { dismiss() }
        }
    }

    private var simple: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("GUS needs his brain")
                .font(.title2)
                .fontWeight(.semibold)
            Text("One download — about \(standard.sizeText) — and GUS can think and talk right here on your iPhone. Nothing you say leaves the phone. It only happens once, and Wi-Fi is best for a download this size.")
                .font(.body)
                .foregroundColor(.secondary)
            switch library.state(of: standard) {
            case .notDownloaded:
                Button {
                    library.download(standard)
                } label: {
                    Text("Download my brain")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            case .downloading(let fraction):
                ProgressView(value: fraction) {
                    Text("Downloading… \(Int(fraction * 100))%")
                }
                Button("Cancel download") { library.cancelDownload(standard) }
            case .verifying:
                ProgressView() { Text("Checking it over…") }
            case .ready:
                Text("Ready — GUS is all set.")
            case .failed(let message):
                Text(message)
                    .font(.callout)
                    .foregroundColor(.orange)
                Button {
                    library.download(standard)
                } label: {
                    Text("Try again")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            Button("Advanced — choose a different brain") {
                showAdvanced = true
            }
            .font(.callout)
            Spacer()
        }
        .padding(24)
    }

    private var advanced: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(GUSModelManifest.downloads, id: \.id) { entry in
                        BrainRowView(entry: entry)
                    }
                } footer: {
                    Text("Download any brain — or more than one. Brains you keep can be switched between later in Settings, and switching never deletes anything.")
                }
            }
            .navigationTitle("Choose a brain")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Back") { showAdvanced = false }
                }
            }
        }
    }
}
