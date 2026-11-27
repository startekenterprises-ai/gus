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
