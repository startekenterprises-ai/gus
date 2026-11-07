import SwiftUI

/// Jobs: every job the control plane holds, newest first — state,
/// cost in dollars (the Governor's unit, never a percentage), the
/// outcome note, and the settlement receipt id. Read-only; the
/// same records /api/jobs serves the web panel.
struct JobsView: View {
    @ObservedObject var model: DesktopModel

    var body: some View {
        Group {
            if model.jobs.isEmpty {
                Text(model.reachable
                    ? "No jobs yet. Jobs you start from chat, Telegram, or a schedule land here."
                    : "The panel isn't reachable yet — jobs appear when the control plane responds.")
                    .foregroundColor(.secondary)
                    .padding(16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                List(model.jobs) { job in
                    jobRow(job)
                }
            }
        }
    }

    private func jobRow(_ job: PanelJob) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(job.kind)
                    .fontWeight(.semibold)
                Text(job.state)
                    .font(.caption)
                    .fontWeight(.medium)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(stateColor(job.state).opacity(0.20)))
                    .foregroundColor(stateColor(job.state))
                Spacer()
                Text(GusFormat.usd(job.costUsd))
                    .font(.callout)
                    .fontWeight(.medium)
            }
            if let note = job.outcomeNote {
                Text(note)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            HStack(spacing: 6) {
                Text(GusFormat.time(job.createdAt))
                if let receipt = job.receiptId {
                    Text("· receipt \(receipt)")
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Text("· \(job.tokensIn + job.tokensOut) tokens")
            }
            .font(.caption)
            .foregroundColor(.secondary)
        }
        .padding(.vertical, 2)
    }

    private func stateColor(_ state: String) -> Color {
        switch state {
        case "verified-done": return .green
        case "failed-loudly": return .red
        case "needs-approval": return .orange
        case "running": return .blue
        default: return .secondary
        }
    }
}
