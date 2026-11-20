import SwiftUI

struct JobsView: View {
    @State private var jobs: [PanelJob] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if jobs.isEmpty && error == nil {
                    Text("No jobs yet.").foregroundStyle(.secondary)
                }
                ForEach(jobs) { j in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(j.kind).font(.headline)
                            Text(j.id).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(j.state)
                            .font(.subheadline)
                            .foregroundStyle(j.state == "verified-done" ? .green : j.state == "failed-loudly" ? .red : .primary)
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
            }
            .navigationTitle("Jobs")
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func load() async {
        do {
            jobs = try await GUSClient.shared.jobs()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
