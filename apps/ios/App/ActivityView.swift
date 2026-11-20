import SwiftUI

/// Activity — "see what he did", scaffold stage: the core's
/// recent jobs, straight from /api/jobs.
///
/// The M3 receipts view this grows into MUST ride the panel's
/// incremental log cache — the same discipline the Mac panel
/// learned the hard way (v0.14.0: polls re-parsing whole logs
/// were the slowness). Watching never re-parses, and watching
/// never slows the voice path: this tab and the call share
/// nothing but the client.
struct ActivityView: View {
    @State private var jobs: [PanelJob] = []
    @State private var errorText: String?
    @State private var coreVersion: String?

    var body: some View {
        NavigationStack {
            Group {
                if jobs.isEmpty && errorText == nil {
                    Text("No jobs yet — or still loading.")
                        .foregroundColor(.secondary)
                } else {
                    List {
                        if let coreVersion {
                            Section {
                                Text("Core version \(coreVersion) — receipts and the full log view land with M3, riding the panel's incremental log cache.")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                        }
                        ForEach(jobs) { job in
                            HStack {
                                Text(job.kind).font(.callout)
                                Spacer()
                                Text(job.state)
                                    .font(.callout)
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .task { await load() }
            .refreshable { await load() }
            .alert("Couldn't load activity", isPresented: Binding(
                get: { errorText != nil },
                set: { if !$0 { errorText = nil } }
            )) {
                Button("OK") { errorText = nil }
            } message: {
                Text(errorText ?? "")
            }
        }
    }

    private func load() async {
        do {
            jobs = try await GUSClient.shared.jobs()
            coreVersion = try? await GUSClient.shared.status().version
        } catch {
            errorText = error.localizedDescription
        }
    }
}
