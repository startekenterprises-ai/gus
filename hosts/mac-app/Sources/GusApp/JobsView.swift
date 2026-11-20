import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// Jobs: every job the control plane holds, newest first — state,
/// cost in dollars (the Governor's unit, never a percentage), the
/// outcome note, and the settlement receipt id. Read-only; the
/// same records /api/jobs serves the web panel.
///
/// v0.12.0: the secure log's home is here now, above the list —
/// Chat keeps only the one-line live-status strip, and this is
/// where the full record lives (filters, search, per-line
/// recorded detail, and the tap-through from a log line to its
/// job's settlement receipt, which was always this section).
struct JobsView: View {
    @ObservedObject var model: DesktopModel

    var body: some View {
        VStack(spacing: 0) {
            SecureLogView(model: model, expands: true)
            Divider()
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

/// The live secure log (v0.11.0) — the Watch timeline,
/// productized: plain-language narration lines of what GUS is
/// doing as it happens (Shield scans, approvals, actions), fed
/// from the model's polled timeline — the durable event + gate
/// logs, never a parallel event system and never an invented
/// line. Collapsible from the header's chevron, with three
/// filter chips matching the reader's categories and a search
/// box that filters AND highlights — the demo move: type
/// "injection" and the caught moments light up. Lines run
/// oldest → newest (the timeline arrives newest-first; the log
/// reads forward in time), each with its real timestamp; a line
/// tied to a job opens the Jobs section, where that job's
/// settlement receipt lives — the full record, one tap away.
///
/// v0.11.1: each line shows the ONE line and nothing more —
/// the receipt id no longer renders inline beside the narration,
/// and the recorded detail (raw event text, gate detail, receipt
/// id) lives behind the line's own disclosure: tap a line to
/// expand it, tap again to fold it.
///
/// v0.12.0: the log's home is the Jobs section now (expands:
/// true) — Chat keeps only the one-line live-status strip,
/// because the block under the transcript plus the per-job
/// settlement lines flooded the conversation. The header's
/// checkbox no longer hides THIS view; it switches the chat
/// strip (the same UserDefaults key, the same switch as
/// Settings → General). Hiding the strip never stops the
/// recording.
struct SecureLogView: View {
    @ObservedObject var model: DesktopModel
    /// v0.12.0: true in its Jobs-section home, where the list
    /// gets real height instead of the old in-chat 168pt slot.
    var expands: Bool = false
    /// v0.14.5: the bounded list height when not expanding —
    /// the chat page's in-place panel passes a taller bound
    /// (~a third of the window) than the original 168pt slot.
    /// The bound is a hard cap either way: the panel never
    /// takes the whole page.
    var boundedHeight: CGFloat = 168
    @AppStorage("gus.secureLogVisible") private var visible = true
    @AppStorage("gus.secureLogCollapsed") private var collapsed = false
    @State private var query = ""
    @State private var showScans = true
    @State private var showApprovals = true
    @State private var showActions = true
    /// v0.14.5: the demo filter — one tap isolates the "aha
    /// moment" lines (Shield catches, blocks, stopped
    /// actions: the flagged entries) from everything else.
    @State private var showFlaggedOnly = false
    @State private var expandedId: String?

    private var shownEntries: [PanelTimelineEntry] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return model.timeline.reversed().filter { entry in
            if showFlaggedOnly && !entry.isFlagged { return false }
            switch entry.categoryKey {
            case "scan": guard showScans else { return false }
            case "approval": guard showApprovals else { return false }
            default: guard showActions else { return false }
            }
            guard !needle.isEmpty else { return true }
            return entry.line.lowercased().contains(needle)
                || entry.detail.lowercased().contains(needle)
                || entry.kind.lowercased().contains(needle)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if !collapsed {
                Divider()
                logList
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Toggle("Secure log", isOn: $visible)
                    .toggleStyle(.checkbox)
                    .font(.caption)
                    .fontWeight(.semibold)
                    .help("The live-status line in Chat — the newest entry of this log, one line above the composer. Turning it off hides only that line; this log and the recording underneath are untouched. The same switch lives in Settings → General.")
                if model.reachable {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 7, height: 7)
                    Text("live")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
                Spacer()
                if !collapsed {
                    TextField("Search the log — try “injection”", text: $query)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                        .frame(width: 230)
                        .help("Filter the log and highlight the matches — the caught moments light up instead of scrolling past.")
                }
                Button {
                    collapsed.toggle()
                } label: {
                    Image(systemName: collapsed ? "chevron.up" : "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                }
                .buttonStyle(.plain)
                .help(collapsed ? "Expand the secure log" : "Collapse the secure log — the header (and the recording) stays")
            }
            if !collapsed {
                HStack(spacing: 6) {
                    chip("Scans", $showScans)
                    chip("Approvals", $showApprovals)
                    chip("Actions", $showActions)
                    flaggedChip
                    Spacer()
                    Text("\(shownEntries.count) line\(shownEntries.count == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    exportMenu
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private func chip(_ label: String, _ isOn: Binding<Bool>) -> some View {
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            Text(label)
                .font(.caption2)
                .fontWeight(.medium)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Capsule().fill(isOn.wrappedValue ? Color.accentColor.opacity(0.25) : Color.secondary.opacity(0.12)))
                .foregroundColor(isOn.wrappedValue ? .accentColor : .secondary)
        }
        .buttonStyle(.plain)
        .help("Show \(label.lowercased()) in the secure log — a view filter only; nothing about the recording changes.")
    }

    /// v0.14.5: the demo filter as a chip of its own — one tap
    /// isolates the flagged lines (Shield catches, blocks,
    /// stopped actions) so a demo can be driven from this
    /// header without typing a search. Orange when on, in the
    /// log's own flag language.
    private var flaggedChip: some View {
        Button {
            showFlaggedOnly.toggle()
        } label: {
            Text("⚑ Caught & stopped")
                .font(.caption2)
                .fontWeight(.medium)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Capsule().fill(showFlaggedOnly ? Color.orange.opacity(0.30) : Color.secondary.opacity(0.12)))
                .foregroundColor(showFlaggedOnly ? .orange : .secondary)
        }
        .buttonStyle(.plain)
        .help("Show only the caught & stopped moments — the lines the Shield or the Governor flagged. A view filter only; nothing about the recording changes.")
    }

    /// v0.14.5: export the log as a text file — the lines
    /// currently shown (filters and search applied), or every
    /// line the panel holds. The file carries the full
    /// recorded detail behind each line, not just the one-line
    /// narration: an export is the record leaving the app, so
    /// it leaves whole.
    private var exportMenu: some View {
        Menu {
            Button("Export shown lines (\(shownEntries.count))") { exportEntries(shownEntries) }
            Button("Export all lines (\(model.timeline.count))") { exportEntries(model.timeline.reversed()) }
        } label: {
            Image(systemName: "square.and.arrow.up")
                .font(.system(size: 11, weight: .semibold))
        }
        .menuStyle(.borderlessButton)
        .frame(width: 22)
        .help("Export the secure log as a text file — the lines shown now, or all of them, each with its recorded detail and receipt.")
    }

    private func exportEntries(_ entries: [PanelTimelineEntry]) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "gus-secure-log-\(Self.exportStamp()).txt"
        panel.allowedContentTypes = [UTType.plainText]
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let header = "# GUS secure log — exported \(Self.exportStamp()) — \(entries.count) line\(entries.count == 1 ? "" : "s")\n"
        let body = entries.map(Self.exportText).joined(separator: "\n")
        try? (header + body + "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private static func exportText(_ entry: PanelTimelineEntry) -> String {
        var lines = ["\(exportTimestamp(entry.ts)) · \(entry.kind) · \(entry.line)"]
        if !entry.detail.isEmpty, entry.detail != entry.line {
            lines.append("    \(entry.detail)")
        }
        if let receipt = entry.receiptId {
            lines.append("    receipt \(receipt)")
        }
        if let job = entry.jobId {
            lines.append("    job \(job)")
        }
        return lines.joined(separator: "\n")
    }

    private static func exportTimestamp(_ ms: Double) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    private static func exportStamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f.string(from: Date())
    }

    private var logList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 3) {
                    if shownEntries.isEmpty {
                        Text(model.timeline.isEmpty
                            ? "No activity recorded yet — scans, approvals, and actions land here as they happen."
                            : "No lines match — loosen the search or the filter chips.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .padding(.vertical, 4)
                    }
                    ForEach(shownEntries) { entry in
                        logLine(entry)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("secure-log-bottom")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: expands ? nil : boundedHeight)
            .frame(maxHeight: expands ? 300 : nil)
            .onChange(of: model.timeline.count) { _, _ in
                // Follow the live edge while browsing; a search
                // in progress stays where the operator put it.
                if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    proxy.scrollTo("secure-log-bottom", anchor: .bottom)
                }
            }
        }
    }

    /// One log line (v0.11.1): timestamp, category chip, and the
    /// one-line narration — nothing else in the stream. The
    /// recorded detail, the event kind, and the receipt id sit
    /// behind the line's disclosure (tap to expand); a line tied
    /// to a job carries its path to the settlement receipt in
    /// that expanded block, not inline.
    private func logLine(_ entry: PanelTimelineEntry) -> some View {
        let expanded = expandedId == entry.id
        let hasDetail = !entry.detail.isEmpty || entry.receiptId != nil || entry.jobId != nil
        return VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .top, spacing: 8) {
                Text(GusFormat.time(entry.ts))
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .frame(width: 52, alignment: .leading)
                categoryChip(entry.categoryKey)
                Text(highlighted(entry.line))
                    .font(.caption)
                    .foregroundColor(entry.isFlagged ? .orange : .primary)
                    .textSelection(.enabled)
                Spacer(minLength: 0)
                if hasDetail {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(.secondary)
                        .padding(.top, 2)
                }
            }
            if expanded {
                detailBlock(entry)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture {
            // Tap expands the disclosure (and folds any other
            // line); the Jobs jump lives inside the block, so a
            // tap on the stream never yanks the operator away.
            if hasDetail {
                expandedId = expanded ? nil : entry.id
            }
        }
        .help(hasDetail
            ? (expanded ? "Tap to fold the recorded detail away." : "Tap to see the recorded detail behind this line.")
            : "Nothing more recorded behind this line.")
    }

    /// The per-line category chip — the same three buckets the
    /// header's filter chips switch, worn by each line so the
    /// stream reads at a glance.
    private func categoryChip(_ categoryKey: String) -> some View {
        let label: String
        switch categoryKey {
        case "scan": label = "Scan"
        case "approval": label = "Approval"
        default: label = "Action"
        }
        return Text(label)
            .font(.caption2)
            .fontWeight(.medium)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(Color.secondary.opacity(0.14)))
            .foregroundColor(.secondary)
            .frame(width: 52, alignment: .center)
    }

    /// Behind the disclosure (v0.11.1): everything that used to
    /// crowd the stream — the recorded detail verbatim, the
    /// event kind and source, the receipt id — plus, for a line
    /// tied to a job, the button to that job's record and its
    /// settlement receipt in the Jobs section.
    private func detailBlock(_ entry: PanelTimelineEntry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if !entry.detail.isEmpty, entry.detail != entry.line {
                Text(entry.detail)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .textSelection(.enabled)
            }
            Text("\(entry.kind) · \(entry.source)")
                .font(.caption2)
                .foregroundColor(.secondary)
            if let receipt = entry.receiptId {
                Text("Receipt \(receipt)")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .textSelection(.enabled)
            }
            if entry.jobId != nil {
                Button("Open job & settlement receipt") { model.section = .jobs }
                    .controlSize(.small)
                    .help("Open the Jobs section — this line's job and its settlement receipt live there.")
            }
        }
        .padding(.leading, 60)
        .padding(.trailing, 4)
        .padding(.bottom, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The search highlight: the line as an AttributedString
    /// with every case-insensitive match of the query backed in
    /// yellow. Matches are found on the plain string (NSString
    /// ranges) and converted into the attributed string's index
    /// space. No query (or no match) returns the plain line.
    private func highlighted(_ line: String) -> AttributedString {
        var attributed = AttributedString(line)
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return attributed }
        let ns = line as NSString
        var from = 0
        while from < ns.length {
            let found = ns.range(of: needle, options: [.caseInsensitive],
                                 range: NSRange(location: from, length: ns.length - from))
            guard found.location != NSNotFound, let range = Range(found, in: attributed) else { break }
            attributed[range].backgroundColor = Color.yellow.opacity(0.55)
            attributed[range].foregroundColor = Color.black
            from = found.location + max(found.length, 1)
        }
        return attributed
    }
}
