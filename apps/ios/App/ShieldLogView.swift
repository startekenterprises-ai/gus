import ShieldKit
import SwiftUI

/// The Shield log (v0.15.7): every on-device scan's receipt —
/// time, direction, verdict, rule — on THIS iPhone only
/// (receipt chains are per-device streams; nothing here is a
/// merged cross-device history). Mirrors the Mac log panel:
/// a search field and an All / Caught filter. "Caught" means
/// the rules flagged the turn — in Permissive posture the turn
/// still went through, and the row says what would have
/// happened, because the receipt keeps the would-be verdict.
///
/// Read-only by design: the one-time override for a
/// quarantined turn lives on the call screen, where the turn
/// is actually waiting.
struct ShieldLogView: View {
    @State private var receipts: [ShieldReceipt] = []
    @State private var searchText = ""
    @State private var filter: Filter = .all

    private enum Filter: String, CaseIterable, Identifiable {
        case all = "All"
        case caught = "Caught"
        var id: String { rawValue }
    }

    private var visible: [ShieldReceipt] {
        receipts.filter { receipt in
            if filter == .caught && !receipt.isCaught { return false }
            guard !searchText.isEmpty else { return true }
            let haystack = [
                receipt.ruleID,
                receipt.verdict.rawValue,
                receipt.rulesVerdict.rawValue,
                receipt.direction.rawValue,
                receipt.posture.rawValue,
            ].joined(separator: " ")
            return haystack.localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        Group {
            if receipts.isEmpty {
                Text("No scans yet — Shield receipts appear here once a call turn is scanned. In on-device calls, your words are scanned before the brain hears them, and replies are scanned before the voice speaks them.")
                    .font(.callout)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(24)
            } else {
                List {
                    Section {
                        Picker("Filter", selection: $filter) {
                            ForEach(Filter.allCases) { f in
                                Text(f.rawValue).tag(f)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                    Section {
                        ForEach(visible) { receipt in
                            row(receipt)
                        }
                        if visible.isEmpty {
                            Text("Nothing matches that filter.")
                                .font(.callout)
                                .foregroundColor(.secondary)
                        }
                    }
                }
                .listStyle(.plain)
                .searchable(text: $searchText, prompt: "Rule, verdict, direction")
            }
        }
        .navigationTitle("Shield log")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            receipts = Array(ShieldReceiptLog.shared.allReceipts().reversed())
        }
    }

    private func row(_ receipt: ShieldReceipt) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(receipt.direction == .user ? "You said" : "GUS replied")
                    .font(.callout)
                Spacer()
                Text(receipt.date, style: .time)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Text(verdictLabel(receipt))
                .font(.callout)
                .foregroundColor(verdictColor(receipt))
            Text(detailLabel(receipt))
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 2)
    }

    private func verdictLabel(_ receipt: ShieldReceipt) -> String {
        switch receipt.verdict {
        case .block:
            return "Blocked — \(receipt.ruleID)"
        case .quarantine:
            return "Quarantined — \(receipt.ruleID)"
        case .allow:
            if receipt.rulesVerdict == .unevaluable {
                return "Allowed with warning — Shield couldn't evaluate it"
            }
            if receipt.isCaught {
                return "Allowed with warning — would have been \(receipt.rulesVerdict.rawValue)"
            }
            return "Allowed"
        }
    }

    private func verdictColor(_ receipt: ShieldReceipt) -> Color {
        switch receipt.verdict {
        case .block: return .red
        case .quarantine: return .orange
        case .allow: return receipt.isCaught ? .orange : .secondary
        }
    }

    private func detailLabel(_ receipt: ShieldReceipt) -> String {
        let day = receipt.date.formatted(date: .abbreviated, time: .omitted)
        return "\(day) · \(receipt.posture.displayName) posture · rules \(receipt.rulesVersion)"
    }
}
