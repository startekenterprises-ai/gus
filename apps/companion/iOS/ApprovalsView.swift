import SwiftUI

/// Approvals on the go. Resolving here goes through the panel API,
/// which resolves through the same hash-bound approval engine as the
/// Telegram buttons: an approval here authorizes EXACTLY the parked
/// action — same tool, same arguments, same hash — or nothing runs.
struct ApprovalsView: View {
    @State private var approvals: [PanelApproval] = []
    @State private var error: String?
    @State private var notice: String?

    var body: some View {
        NavigationStack {
            List {
                if let notice {
                    Text(notice).font(.footnote).foregroundStyle(.secondary)
                }
                if approvals.isEmpty && error == nil {
                    Text("Nothing is waiting.").foregroundStyle(.secondary)
                }
                ForEach(approvals) { a in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(a.summary).font(.headline)
                        Text("Why: \(a.reason)").font(.footnote).foregroundStyle(.secondary)
                        Text("Expires \(Date(timeIntervalSince1970: a.expiresAt / 1000), format: .relative(presentation: .named)) — no answer in time counts as a denial.")
                            .font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Button("✅ Approve — exactly this") {
                                Task { await resolve(a, approve: true) }
                            }
                            .buttonStyle(.borderedProminent)
                            Button("🚫 Deny") {
                                Task { await resolve(a, approve: false) }
                            }
                            .buttonStyle(.bordered)
                            .foregroundStyle(.red)
                        }
                    }
                    .padding(.vertical, 4)
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
            }
            .navigationTitle("Approvals")
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func resolve(_ a: PanelApproval, approve: Bool) async {
        do {
            let r = try await GUSClient.shared.resolveApproval(id: a.id, approve: approve)
            notice = r.detail
        } catch {
            self.error = error.localizedDescription
        }
        await load()
    }

    private func load() async {
        do {
            approvals = try await GUSClient.shared.approvals()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
