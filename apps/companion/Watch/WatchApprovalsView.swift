import SwiftUI

struct WatchApprovalsView: View {
    @State private var approvals: [PanelApproval] = []
    @State private var note: String?

    var body: some View {
        List {
            if approvals.isEmpty {
                Text(note ?? "Nothing waiting").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(approvals) { a in
                VStack(alignment: .leading, spacing: 4) {
                    Text(a.summary).font(.footnote).lineLimit(3)
                    HStack {
                        Button("✅") { Task { await resolve(a, true) } }
                        Button("🚫") { Task { await resolve(a, false) } }
                    }
                }
            }
        }
        .task { await load() }
    }

    private func resolve(_ a: PanelApproval, _ approve: Bool) async {
        if let r = try? await GUSClient.shared.resolveApproval(id: a.id, approve: approve) {
            note = r.detail
        }
        await load()
    }

    private func load() async {
        approvals = (try? await GUSClient.shared.approvals()) ?? []
    }
}
