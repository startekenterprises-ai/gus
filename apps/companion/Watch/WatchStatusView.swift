import SwiftUI

struct WatchStatusView: View {
    @State private var status: PanelStatus?
    @State private var error: String?

    var body: some View {
        ScrollView {
            if let s = status {
                VStack(alignment: .leading, spacing: 4) {
                    Text(s.killed ? "⏹ Stopped" : "● Live").font(.headline)
                    Text("v\(s.version)").foregroundStyle(.secondary)
                    Text(s.governorMode == "permissive" ? "⚠️ Permissive" : "🛡 Enforcing")
                    Text("\(s.pendingApprovals) waiting")
                    Text("Today \(String(format: "$%.2f", s.spendTodayUsd))")
                    Button(s.killed ? "Resume" : "Stop") {
                        Task {
                            _ = try? await GUSClient.shared.setKilled(!s.killed)
                            await load()
                        }
                    }
                    .foregroundStyle(s.killed ? .green : .red)
                }
            } else if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
            } else {
                ProgressView()
            }
        }
        .task { await load() }
    }

    private func load() async {
        do { status = try await GUSClient.shared.status(); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
