import SwiftUI

/// The wrist glance (v0.25.0): one scroll, no navigation.
/// Status first, then the connection and the brain, then
/// what Shield last caught — and at the bottom, when the
/// phone last said any of it. If that was a while ago, the
/// footer says the picture may be out of date instead of
/// letting old news wear a live face.
struct WatchRootView: View {
    @StateObject private var model = WatchSnapshotModel()

    /// Past this age a snapshot is stale news, and the view
    /// says so. The phone rebuilds every minute while the
    /// app is alive, so a fresh picture is normally a minute
    /// or two old at worst.
    private static let staleAfter: TimeInterval = 10 * 60

    var body: some View {
        // Re-render every minute so the freshness footer
        // ages honestly even while the view just sits open.
        TimelineView(.periodic(from: Date(), by: 60)) { timeline in
            Group {
                if let snapshot = model.snapshot {
                    content(snapshot, now: timeline.date)
                } else {
                    waiting
                }
            }
        }
    }

    private var waiting: some View {
        VStack(spacing: 4) {
            Text("GUS").font(.headline)
            Text("Open GUS on your iPhone once — your status will appear here.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 4)
    }

    private func content(_ snapshot: WatchSnapshot, now: Date) -> some View {
        let stale = now.timeIntervalSince(snapshot.generatedAt) > Self.staleAfter
        return ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                Text(snapshot.statusLine)
                    .font(.headline)

                HStack(spacing: 4) {
                    Circle()
                        .fill(snapshot.coreReachable ? Color.green : Color.orange)
                        .frame(width: 7, height: 7)
                    Text(snapshot.connectionLine)
                        .font(.caption)
                }

                Text(snapshot.brainName.map { "Brain: \($0)" } ?? "No on-device brain yet")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if snapshot.pendingApprovalTotal > 0 {
                    approvalsSection(snapshot, now: now, stale: stale)
                }

                Divider()

                Text(snapshot.caughtTotal > 0
                     ? "Shield — \(snapshot.caughtTotal) caught"
                     : "Shield")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if snapshot.highlights.isEmpty {
                    Text("Nothing caught yet.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(snapshot.highlights) { highlight in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(highlight.title).font(.footnote)
                            Text("\(highlight.detail) · \(when(highlight.date))")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Divider()

                VStack(alignment: .leading, spacing: 1) {
                    Text(ageText(snapshot.generatedAt, now: now))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if stale {
                        Text("May be out of date — open GUS on your iPhone to refresh.")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 2)
        }
    }

    /// The approvals section (v0.27.0): what's parked, in
    /// the snapshot's own freshness terms — if this picture
    /// is stale, the section says so before offering any
    /// buttons, with the same words the footer uses. A tap
    /// from a stale list may still be attempted (the core
    /// re-validates the id at resolution and the row shows
    /// the core's actual answer), but nobody is invited to
    /// mistake old news for the live queue.
    private func approvalsSection(_ snapshot: WatchSnapshot, now: Date, stale: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()

            Text("Approvals — \(snapshot.pendingApprovalTotal) waiting")
                .font(.caption)
                .foregroundStyle(.secondary)

            if stale {
                Text("This list may be out of date — open GUS on your iPhone to refresh.")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }

            ForEach(snapshot.pendingApprovals) { approval in
                WatchApprovalRow(
                    approval: approval,
                    now: now,
                    outcome: model.outcomes[approval.id],
                    onResolve: { model.resolve(approval, approve: $0) })
            }

            if snapshot.pendingApprovalTotal > snapshot.pendingApprovals.count {
                Text("\(snapshot.pendingApprovalTotal - snapshot.pendingApprovals.count) more — on your iPhone.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// A caught item's moment, wrist-sized: the clock time
    /// today, the day once it's older.
    private func when(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    /// The freshness footer's line: how long ago the phone
    /// built this picture, in the plainest words that fit.
    private func ageText(_ date: Date, now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 90 { return "Updated just now" }
        if seconds < 3600 { return "Updated \(Int(seconds / 60)) min ago" }
        if seconds < 86_400 { return "Updated \(Int(seconds / 3600)) hr ago" }
        return "Updated \(date.formatted(date: .abbreviated, time: .shortened))"
    }
}

/// One parked approval on the wrist (v0.27.0): what job,
/// what it wants to do, why, and how long it's been waiting
/// — then the decision. A wrist tap is easy to fat-finger,
/// so BOTH decisions take two steps: the first tap arms a
/// confirmation that names the action and repeats what it
/// acts on; only the second tap sends. (Symmetric on
/// purpose: a wrongful deny kills work the operator wanted
/// just as finally as a wrongful approve runs work they
/// didn't — and one pattern is easier to learn on a wrist
/// than two.) What the row shows afterwards is the core's
/// answer, carried back through the phone — never a local
/// assumption that it worked.
private struct WatchApprovalRow: View {
    let approval: WatchApproval
    let now: Date
    let outcome: WatchSnapshotModel.ResolutionOutcome?
    let onResolve: (Bool) -> Void

    private enum Step { case idle, confirmApprove, confirmDeny }
    @State private var step: Step = .idle

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(approval.jobLabel)
                .font(.footnote.weight(.semibold))
            Text(approval.summary)
                .font(.footnote)
            Text("Waiting \(waitingText) · expires \(approval.expiresAt.formatted(date: .omitted, time: .shortened))")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(approval.reason)
                .font(.caption2)
                .foregroundStyle(.secondary)

            switch outcome {
            case .sending:
                Text("Sending…")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            case .answered(let ok, let detail) where ok:
                // The core's own words — the row stays until
                // the next snapshot confirms the queue moved.
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.green)
            default:
                if case .answered(_, let detail) = outcome {
                    // A refusal is an answer too: show why,
                    // and leave the decision available.
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
                decisionButtons
            }
        }
    }

    @ViewBuilder
    private var decisionButtons: some View {
        switch step {
        case .idle:
            HStack(spacing: 6) {
                Button("Deny") { step = .confirmDeny }
                    .tint(.red)
                Button("Approve") { step = .confirmApprove }
                    .tint(.green)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        case .confirmApprove, .confirmDeny:
            let approving = step == .confirmApprove
            VStack(alignment: .leading, spacing: 3) {
                Text(approving ? "Approve this?" : "Deny this?")
                    .font(.footnote.weight(.semibold))
                Text(approval.summary)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    Button(approving ? "Yes, approve" : "Yes, deny") {
                        step = .idle
                        onResolve(approving)
                    }
                    .tint(approving ? .green : .red)
                    Button("Cancel") { step = .idle }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
    }

    /// How long the approval has been parked, wrist-sized.
    private var waitingText: String {
        let seconds = max(0, now.timeIntervalSince(approval.createdAt))
        if seconds < 90 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60)) min" }
        if seconds < 86_400 { return "\(Int(seconds / 3600)) hr" }
        return approval.createdAt.formatted(date: .abbreviated, time: .omitted)
    }
}
