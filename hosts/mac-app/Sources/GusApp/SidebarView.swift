import AppKit
import SwiftUI

/// The right sidebar: who GUS is and what he is doing, over the
/// Approvals centerpiece — pending parks as native Approve/Deny
/// cards, with the resolution history beneath. Every history entry
/// carries its job id, so it can be traced to the job's settlement
/// receipt in the Jobs view.
struct SidebarView: View {
    @ObservedObject var model: DesktopModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            identity
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    approvalsSection
                    historySection
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(width: 300)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    // MARK: Identity

    private var identity: some View {
        VStack(spacing: 6) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable()
                .frame(width: 56, height: 56)
            Text("GUS")
                .font(.title3)
                .fontWeight(.semibold)
            Text(model.statusLine)
                .font(.caption)
                .foregroundColor(model.status?.killed == true ? .red : .secondary)
                .multilineTextAlignment(.center)
            if let version = model.status?.version {
                Text("v\(version)")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 10)
    }

    // MARK: Approvals

    private var approvalsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Approvals")
                    .font(.headline)
                if !model.approvals.isEmpty {
                    Text("\(model.approvals.count)")
                        .font(.caption)
                        .fontWeight(.bold)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.orange.opacity(0.25)))
                }
            }
            if model.approvals.isEmpty {
                Text("Nothing parked. Consequential actions appear here — naming the exact action — before they run.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                ForEach(model.approvals) { approval in
                    ApprovalCardView(model: model, approval: approval)
                }
            }
        }
    }

    // MARK: History

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("History")
                .font(.headline)
            if model.approvalsHistory.isEmpty {
                Text("No resolutions yet.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                ForEach(model.approvalsHistory) { entry in
                    historyRow(entry)
                }
            }
        }
    }

    private func historyRow(_ entry: PanelApprovalHistoryEntry) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(historySymbol(entry.status))
                .font(.callout)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.summary)
                    .font(.callout)
                Text(historyDetail(entry))
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func historySymbol(_ status: String) -> String {
        switch status {
        case "approved", "consumed": return "✅"
        case "denied": return "🚫"
        case "expired": return "⌛"
        default: return "•"
        }
    }

    private func historyDetail(_ entry: PanelApprovalHistoryEntry) -> String {
        var parts = [entry.status]
        if let by = entry.resolvedBy { parts.append("by \(by)") }
        if let at = entry.resolvedAt { parts.append(GusFormat.time(at)) }
        parts.append("job \(entry.jobId)")
        return parts.joined(separator: " · ")
    }
}
