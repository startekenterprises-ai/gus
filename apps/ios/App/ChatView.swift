import PhotosUI
import ShieldKit
import SwiftUI
import UIKit

/// Chat — the typed surface (v0.16.0; the scaffold shell's
/// promise kept). Same sign-in, same brains, same Shield as
/// the call: a message goes to the on-device brain when the
/// brain picker says on-device, and to the core's chat
/// channel when it says Core. Every message and every reply
/// passes the Shield gate with a receipt, exactly as call
/// turns do — blocked words never reach a brain, quarantined
/// words wait for the operator's one-time OK, and one plain
/// Shield line under each exchange says what happened, with
/// the receipts a tap away.
///
/// Photos are the one attachment (this build): they route
/// to Core mode, and the photo button stays disabled until a
/// core is connected. The honest limit, stated on the photo
/// itself: the core's chat channel takes text only, so in
/// this build the photo stays in this chat, marked as not
/// sent — nothing pretends it was delivered.
struct ChatView: View {
    /// Extra bottom room that clears the floating tab
    /// bar's pill (v0.17.4) — the Call screen's figure,
    /// from the same 0.17.3 screenshot.
    private static let tabBarClearance: CGFloat = 72

    @StateObject private var model = ChatModel()
    @State private var expandedExchanges: Set<UUID> = []
    @FocusState private var composerFocused: Bool

    /// The last message of each exchange — the Shield line
    /// renders under it, once per exchange.
    private var exchangeTailIDs: Set<UUID> {
        var tails: Set<UUID> = []
        var seen: Set<UUID> = []
        for message in model.messages.reversed() {
            if seen.insert(message.exchangeID).inserted {
                tails.insert(message.id)
            }
        }
        return tails
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Text(model.mode == .onDevice
                     ? "On-device — the brain lives on this iPhone."
                     : "Core — replies come from your GUS core.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if model.messages.isEmpty {
                                Text("Nothing here yet — type below. Voice stays on the Call tab; this is the same GUS, in text.")
                                    .font(.callout)
                                    .foregroundColor(.secondary)
                                    .multilineTextAlignment(.center)
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 48)
                            }
                            ForEach(model.messages) { message in
                                messageRow(message)
                                if exchangeTailIDs.contains(message.id) {
                                    shieldLine(for: message.exchangeID)
                                }
                            }
                            if model.isReplying {
                                HStack(spacing: 8) {
                                    ProgressView()
                                    Text("GUS is thinking…")
                                        .font(.callout)
                                        .foregroundColor(.secondary)
                                }
                                .id("thinking")
                            }
                        }
                        .padding(16)
                    }
                    .onChange(of: model.messages.count) { _, _ in
                        if let last = model.messages.last {
                            withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                        }
                    }
                    .onChange(of: model.isReplying) { _, replying in
                        if replying {
                            withAnimation { proxy.scrollTo("thinking", anchor: .bottom) }
                        }
                    }
                }

                Divider()
                composer
            }
            .navigationTitle("Chat")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { model.refreshMode() }
        }
    }

    // MARK: - Rows

    @ViewBuilder
    private func messageRow(_ message: ChatMessage) -> some View {
        switch message.role {
        case .notice:
            Text(message.text)
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .id(message.id)
        case .user:
            VStack(alignment: .trailing, spacing: 6) {
                HStack {
                    Spacer(minLength: 48)
                    bubble(message, mine: true)
                }
                if message.held {
                    heldControls(message)
                }
                if message.dropped {
                    Text("Dropped — never sent to the brain.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .id(message.id)
        case .assistant:
            HStack {
                bubble(message, mine: false)
                Spacer(minLength: 48)
            }
            .id(message.id)
        }
    }

    private func bubble(_ message: ChatMessage, mine: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let data = message.photoData, let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: 220, maxHeight: 220)
                    .clipped()
                    .cornerRadius(8)
            }
            if !message.text.isEmpty {
                Text(message.text)
                    .font(.callout)
                    .foregroundColor(mine ? .white : .primary)
            }
            if let note = message.photoNote {
                Text(note)
                    .font(.caption)
                    .foregroundColor(mine ? .white.opacity(0.85) : .secondary)
            }
        }
        .padding(10)
        .background(mine ? Color.accentColor : Color.secondary.opacity(0.15))
        .cornerRadius(14)
    }

    /// A quarantined message waits here — the call screen's
    /// one-time override, in chat form. Send anyway proceeds
    /// with THIS message only; the scan's receipt stands.
    private func heldControls(_ message: ChatMessage) -> some View {
        let ruleID = model.receipts(for: message.exchangeID).first?.ruleID ?? "a Shield rule"
        return VStack(alignment: .trailing, spacing: 6) {
            Text("Shield held this message — it matched \(ruleID). It hasn't gone to the brain.")
                .font(.caption)
                .foregroundColor(.orange)
                .multilineTextAlignment(.trailing)
            HStack(spacing: 12) {
                Button("Send anyway") { model.sendHeld(message) }
                Button("Drop it", role: .destructive) { model.dropHeld(message) }
            }
            .font(.callout)
        }
    }

    // MARK: - The Shield line

    /// One plain line per exchange — clean, flagged, or
    /// stopped — and a tap opens the exchange's receipts,
    /// worded the way the Shield log words them.
    @ViewBuilder
    private func shieldLine(for exchangeID: UUID) -> some View {
        let receipts = model.receipts(for: exchangeID)
        if !receipts.isEmpty {
            let blockedUser = receipts.contains { $0.verdict == .block && $0.direction == .user }
            let blockedReply = receipts.contains { $0.verdict == .block && $0.direction == .assistant }
            let flagged = receipts.contains { $0.isCaught || $0.verdict == .quarantine }
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    if expandedExchanges.contains(exchangeID) {
                        expandedExchanges.remove(exchangeID)
                    } else {
                        expandedExchanges.insert(exchangeID)
                    }
                } label: {
                    HStack(spacing: 6) {
                        if blockedUser || blockedReply {
                            Image(systemName: "shield.slash.fill").foregroundColor(.red)
                            Text(blockedUser ? "Shield stopped your message" : "Shield stopped part of the reply")
                                .lineLimit(2)
                                .minimumScaleFactor(0.85)
                        } else if flagged {
                            Image(systemName: "exclamationmark.shield.fill").foregroundColor(.orange)
                            Text("Shield flagged this exchange — allowed under your posture")
                                .lineLimit(2)
                                .minimumScaleFactor(0.85)
                        } else {
                            Image(systemName: "checkmark.shield.fill").foregroundColor(.green)
                            Text("Shield checked this exchange — clean")
                                .lineLimit(2)
                                .minimumScaleFactor(0.85)
                        }
                        Image(systemName: expandedExchanges.contains(exchangeID) ? "chevron.up" : "chevron.down")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                    .font(.caption)
                    .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                if expandedExchanges.contains(exchangeID) {
                    ForEach(receipts) { receipt in
                        receiptRow(receipt)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func receiptRow(_ receipt: ShieldReceipt) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(receipt.direction == .user ? "You said" : "GUS replied")
                    .font(.caption)
                Spacer()
                Text(receipt.date, style: .time)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Text(verdictLabel(receipt))
                .font(.caption)
                .foregroundColor(verdictColor(receipt))
            Text(detailLabel(receipt))
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(8)
        .background(Color.secondary.opacity(0.08))
        .cornerRadius(8)
    }

    // The Shield log's wording, mirrored (ShieldLogView).
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
        return "\(day) · \(receipt.posture.displayName) posture · rules \(receipt.rulesVersion) · receipt \(String(receipt.hash.prefix(12)))…"
    }

    // MARK: - Composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let data = model.photoData, let image = UIImage(data: data) {
                HStack(spacing: 10) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 52, height: 52)
                        .clipped()
                        .cornerRadius(8)
                    Text("Photo attached — it routes to your Mac.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                    Spacer()
                    Button("Remove") { model.clearPhoto() }
                        .font(.callout)
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                PhotosPicker(selection: $model.photoItem, matching: .images, photoLibrary: .shared()) {
                    Image(systemName: "photo")
                        .font(.title3)
                }
                .disabled(!model.coreConnected)
                .onChange(of: model.photoItem) { _, newItem in
                    model.photoPicked(newItem)
                }
                TextField("Message GUS", text: $model.draft, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($composerFocused)
                    .padding(8)
                    .background(Color.secondary.opacity(0.12))
                    .cornerRadius(10)
                Button {
                    model.send()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title)
                }
                .disabled(!model.canSend)
            }
            if !model.coreConnected {
                Text("Connect to your Mac to send photos — its address and token go in the Settings tab.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        // Tab-bar clearance (v0.17.4): the composer is a
        // fixed control at the bottom of a tab, the same
        // spot the floating tab bar covered on the Call
        // screen in 0.17.3 — the message view above it is
        // a ScrollView, which takes the scroll clearance
        // for itself and leaves the composer under the
        // pill. Clear the pill while the keyboard is down;
        // while it is up, the keyboard owns the bottom of
        // the screen and the composer rides it as before.
        .padding(.bottom, composerFocused ? 12 : 12 + Self.tabBarClearance)
    }
}

// MARK: - Model

struct ChatMessage: Identifiable {
    enum Role { case user, assistant, notice }
    let id = UUID()
    let exchangeID: UUID
    let role: Role
    var text: String
    var photoData: Data? = nil
    var photoNote: String? = nil
    /// Shield quarantine (Standard posture): scanned, receipt
    /// written, waiting on the operator's one-time decision.
    var held = false
    var dropped = false
    var blocked = false
}

@MainActor
final class ChatModel: ObservableObject {
    @Published private(set) var messages: [ChatMessage] = []
    @Published var draft = ""
    @Published private(set) var isReplying = false
    @Published private(set) var mode: CallMode = CallMode.preferred
    @Published var photoItem: PhotosPickerItem?
    @Published private(set) var photoData: Data?

    /// Every receipt this chat has written, grouped by
    /// exchange — the Shield line reads from here.
    private var receiptsByExchange: [UUID: [ShieldReceipt]] = [:]
    private var brain: LocalBrain?
    private let client = GUSClient.shared
    private var localChain: Task<Void, Never>?
    private var replyingCount = 0 {
        didSet { isReplying = replyingCount > 0 }
    }
    private var corePollTask: Task<Void, Never>?
    private var coreBaselineTaken = false
    private var coreSeenCount = 0
    private var pendingCoreExchanges: [UUID] = []
    /// Exchanges where a reply sentence was already replaced
    /// by the canned line (one per exchange, as on the call).
    private var cannedReplyExchanges: Set<UUID> = []

    var coreConnected: Bool { GUSSettings.isConfigured }

    var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || photoData != nil
    }

    func refreshMode() {
        mode = CallMode.preferred
    }

    func receipts(for exchangeID: UUID) -> [ShieldReceipt] {
        receiptsByExchange[exchangeID] ?? []
    }

    // MARK: Photos

    func photoPicked(_ item: PhotosPickerItem?) {
        guard let item else {
            photoData = nil
            return
        }
        Task {
            photoData = try? await item.loadTransferable(type: Data.self)
        }
    }

    func clearPhoto() {
        photoItem = nil
        photoData = nil
    }

    // MARK: Sending

    func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || photoData != nil else { return }
        draft = ""
        let photo = photoData
        clearPhoto()
        let exchangeID = UUID()
        let message = ChatMessage(exchangeID: exchangeID, role: .user, text: text, photoData: photo)
        messages.append(message)
        // The Shield gate — the same one the call runs
        // (v0.15.7): your words are scanned BEFORE any brain
        // sees them, and the receipt is written either way.
        // Blocked words never leave this screen; quarantined
        // words wait for the one-time OK under the message.
        // Shield OFF means no scan and no receipt at all.
        if ShieldSettings.enabled, !text.isEmpty {
            let scan = ShieldScanner.scan(text, posture: ShieldSettings.posture)
            record(scan, direction: .user, exchangeID: exchangeID)
            switch scan.verdict {
            case .block:
                update(message.id) { $0.blocked = true }
                appendNotice(exchangeID: exchangeID,
                    text: "Shield stopped that message — it matched \(scan.primaryRuleID). It never reached the brain; the scan is recorded in Settings → Security → Shield log.")
                return
            case .quarantine:
                update(message.id) { $0.held = true }
                return
            case .allow:
                break
            }
        }
        dispatch(exchangeID: exchangeID, text: text, photo: photo)
    }

    /// The one-time override for a held message — this
    /// message only; the receipt from the original scan
    /// already stands, exactly as on the call screen.
    func sendHeld(_ message: ChatMessage) {
        update(message.id) { $0.held = false }
        dispatch(exchangeID: message.exchangeID, text: message.text, photo: message.photoData)
    }

    /// Drop a held message: it never reaches a brain, and
    /// nothing is sent in its place.
    func dropHeld(_ message: ChatMessage) {
        update(message.id) {
            $0.held = false
            $0.dropped = true
        }
    }

    private func dispatch(exchangeID: UUID, text: String, photo: Data?) {
        if photo != nil {
            // Photos route to Core mode. The honest limit of
            // this build: the core's chat channel takes text
            // only, so the photo itself cannot be delivered —
            // it stays in this chat, marked on the message as
            // not sent, while the words still go to the core.
            if let i = messages.firstIndex(where: { $0.exchangeID == exchangeID && $0.role == .user }) {
                messages[i].photoNote = "The photo itself wasn't sent — your Mac's GUS chat takes text only for now. The photo stays in this chat."
            }
            guard !text.isEmpty else { return }
            dispatchCore(exchangeID: exchangeID, text: text)
            return
        }
        if mode == .onDevice {
            dispatchOnDevice(exchangeID: exchangeID, text: text)
        } else {
            dispatchCore(exchangeID: exchangeID, text: text)
        }
    }

    // MARK: On-device answers

    /// Sends chain: the brain runs one generation at a time
    /// (a second respond while one is in flight returns
    /// nothing at all), so each answer awaits the previous
    /// one — the call supersedes an unfinished turn; a chat
    /// keeps every reply, in order.
    private func dispatchOnDevice(exchangeID: UUID, text: String) {
        replyingCount += 1
        let previous = localChain
        localChain = Task { [weak self] in
            await previous?.value
            await self?.runOnDeviceAnswer(exchangeID: exchangeID, text: text)
        }
    }

    private func runOnDeviceAnswer(exchangeID: UUID, text: String) async {
        guard let brain = loadBrain(exchangeID: exchangeID) else {
            replyingCount -= 1
            return
        }
        let reply = await brain.respond(to: text) { sentence in
            Task { @MainActor in
                if self.replySentenceAllowed(sentence, exchangeID: exchangeID) {
                    self.appendReplySentence(exchangeID: exchangeID, sentence: sentence)
                }
            }
        }
        // Sentence hops were submitted before this one, and
        // the main actor runs them in order — by the time this
        // lands, the exchange shows the whole reply (the call
        // pump's completion discipline, v0.15.0).
        Task { @MainActor in
            if reply.isEmpty,
               !self.messages.contains(where: { $0.exchangeID == exchangeID && $0.role == .assistant }) {
                self.appendNotice(exchangeID: exchangeID, text: "GUS didn't reply to that.")
            }
            self.replyingCount -= 1
        }
    }

    /// Shield on the way out — the call pump's seam, per
    /// sentence, before the sentence is shown: a blocked
    /// sentence never renders, and one canned line per
    /// exchange says so in its place. A quarantined sentence
    /// is shown; for replies the receipt is the warning.
    private func replySentenceAllowed(_ sentence: String, exchangeID: UUID) -> Bool {
        guard ShieldSettings.enabled else { return true }
        let scan = ShieldScanner.scan(sentence, posture: ShieldSettings.posture)
        record(scan, direction: .assistant, exchangeID: exchangeID)
        guard scan.verdict == .block else { return true }
        if cannedReplyExchanges.insert(exchangeID).inserted {
            appendReplySentence(exchangeID: exchangeID,
                sentence: "I stopped part of that reply — it matched a known injection pattern.")
        }
        return false
    }

    /// The chat's on-device brain, loaded once and kept —
    /// the same presence checks and the same loud failures
    /// as the call's connect path.
    private func loadBrain(exchangeID: UUID) -> LocalBrain? {
        if let brain { return brain }
        let entry = GUSModelManifest.brain
        guard ModelStore.isPresent(entry) else {
            appendNotice(exchangeID: exchangeID,
                text: "The on-device brain isn't downloaded yet — get it in Settings → On-device models, or switch the brain to Core in Settings.")
            return nil
        }
        guard let loaded = LocalBrain(modelURL: ModelStore.fileURL(for: entry)) else {
            appendNotice(exchangeID: exchangeID,
                text: "The on-device brain wouldn't load — try deleting and re-downloading it in Settings → On-device models.")
            return nil
        }
        brain = loaded
        return loaded
    }

    // MARK: Core answers

    private func dispatchCore(exchangeID: UUID, text: String) {
        replyingCount += 1
        Task { [weak self] in
            guard let self else { return }
            do {
                // Baseline first: the transcript is
                // append-only, and the poll below tells new
                // replies from old ones by position — the
                // count must be taken before our own message
                // is recorded in it.
                if !self.coreBaselineTaken {
                    let history = try await self.client.chatHistory()
                    self.coreSeenCount = history.messages.count
                    self.coreBaselineTaken = true
                }
                let result = try await self.client.chat(text: text)
                guard result.ok else {
                    self.appendNotice(exchangeID: exchangeID, text: result.detail)
                    self.replyingCount -= 1
                    return
                }
                self.pendingCoreExchanges.append(exchangeID)
                self.startCorePolling()
            } catch {
                self.appendNotice(exchangeID: exchangeID,
                    text: "Couldn't reach your GUS core: \(error.localizedDescription)")
                self.replyingCount -= 1
            }
        }
    }

    /// Polls the core's chat history while any Core exchange
    /// is waiting: replies arrive as "out" messages in the
    /// transcript, because the channel is asynchronous (the
    /// Mac's own Chat view reads the same transcript). The
    /// loop makes no request while nothing is pending and
    /// dies with the model.
    private func startCorePolling() {
        guard corePollTask == nil else { return }
        corePollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if !self.pendingCoreExchanges.isEmpty,
                   let history = try? await self.client.chatHistory() {
                    let fresh = history.messages.dropFirst(self.coreSeenCount)
                    self.coreSeenCount = history.messages.count
                    for message in fresh where message.direction == "out" {
                        self.deliverCoreReply(message.text)
                    }
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func deliverCoreReply(_ text: String) {
        if pendingCoreExchanges.isEmpty {
            // An answer to something asked on another surface
            // (the Mac's Chat view shares this transcript):
            // show it as its own exchange rather than eating it.
            appendScannedReply(exchangeID: UUID(), text: text)
            return
        }
        let exchangeID = pendingCoreExchanges.removeFirst()
        appendScannedReply(exchangeID: exchangeID, text: text)
        replyingCount -= 1
    }

    /// A Core reply, scanned whole on arrival — Core replies
    /// arrive whole, not sentence by sentence. The receipt
    /// is written before the text is shown, and a blocked
    /// reply is replaced by the canned line: the words
    /// themselves never render. A quarantined reply is
    /// shown; the receipt carries the warning.
    private func appendScannedReply(exchangeID: UUID, text: String) {
        var shown = text
        if ShieldSettings.enabled {
            let scan = ShieldScanner.scan(text, posture: ShieldSettings.posture)
            record(scan, direction: .assistant, exchangeID: exchangeID)
            if scan.verdict == .block {
                shown = "I stopped part of that reply — it matched a known injection pattern."
            }
        }
        messages.append(ChatMessage(exchangeID: exchangeID, role: .assistant, text: shown))
    }

    // MARK: Shared helpers

    private func record(_ scan: ShieldScanResult, direction: ShieldDirection, exchangeID: UUID) {
        let receipt = ShieldReceiptLog.shared.record(scan, direction: direction)
        receiptsByExchange[exchangeID, default: []].append(receipt)
    }

    private func appendReplySentence(exchangeID: UUID, sentence: String) {
        if let i = messages.lastIndex(where: { $0.exchangeID == exchangeID && $0.role == .assistant }) {
            messages[i].text += (messages[i].text.isEmpty ? "" : " ") + sentence
        } else {
            messages.append(ChatMessage(exchangeID: exchangeID, role: .assistant, text: sentence))
        }
    }

    private func appendNotice(exchangeID: UUID, text: String) {
        messages.append(ChatMessage(exchangeID: exchangeID, role: .notice, text: text))
    }

    private func update(_ id: UUID, _ change: (inout ChatMessage) -> Void) {
        guard let i = messages.firstIndex(where: { $0.id == id }) else { return }
        change(&messages[i])
    }
}
