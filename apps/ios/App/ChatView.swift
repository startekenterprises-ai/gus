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
/// Photos are the one attachment: they DELIVER in Core
/// mode (v0.24.0) — the image rides the chat submission to
/// the Mac, whose brain receives it as image input; the
/// core's transcript records the photo count, never the
/// image. The on-device brains are text-only, so a photo
/// message in on-device mode is not dispatched at all: the
/// note on the message says so in plain words at send time —
/// never a silent drop, never a pretend delivery. The photo
/// button stays disabled until a core is connected.
///
/// History is ONE conversation across phone and Mac
/// (v0.26.0): every message is born as a record in the
/// phone's durable sync store (ChatHistoryStore) and merges
/// with the core's transcript by union — per-message IDs,
/// causal ordering, no duplicates, nothing lost. Offline
/// chats are simply store records that haven't synced yet;
/// they flow to the desk on the next exchange with no
/// action from the operator.
///
/// Chat is home (v0.29.0): the Call tab is gone — the call
/// is a full-screen cover from this view's header phone
/// button — and message text is selectable, copyable, and
/// shareable, with a Share conversation export in the
/// header. Copy and share always move the displayed text.
struct ChatView: View {
    /// Extra bottom room that clears the floating tab
    /// bar's pill (v0.17.4) — the Call screen's figure,
    /// from the same 0.17.3 screenshot.
    private static let tabBarClearance: CGFloat = 72

    @StateObject private var model = ChatModel()
    @State private var expandedExchanges: Set<UUID> = []
    @FocusState private var composerFocused: Bool
    /// The call, presented as a full-screen cover from the
    /// header's phone button (v0.29.0 — Chat is home now;
    /// there is no Call tab). Ending the call dismisses
    /// the cover back here.
    @State private var showCall = false

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
                                Text("Nothing here yet — type below, or tap the phone button up top to talk. This is the same GUS, in text.")
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
            // The header (v0.29.0): share the conversation,
            // and the call button — Muse's shape, a phone
            // in the chat header instead of a Call tab.
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: model.exportText()) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .disabled(model.exportText().isEmpty)
                    .accessibilityLabel("Share conversation")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showCall = true
                    } label: {
                        Image(systemName: "phone.fill")
                    }
                    .accessibilityLabel("Call GUS")
                }
            }
            .fullScreenCover(isPresented: $showCall) {
                CallView()
            }
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
                        .contextMenu { messageMenu(message) }
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
                    .contextMenu { messageMenu(message) }
                Spacer(minLength: 48)
            }
            .id(message.id)
        }
    }

    /// Copy / Share for one message (v0.29.0) — the text
    /// that moves is the DISPLAYED text (ChatMessage.shareText):
    /// what the operator sees on screen is what lands on
    /// the pasteboard or in the share sheet, never the
    /// store's verbatim record behind it.
    @ViewBuilder
    private func messageMenu(_ message: ChatMessage) -> some View {
        let text = message.shareText
        if !text.isEmpty {
            Button {
                UIPasteboard.general.string = text
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            ShareLink(item: text) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
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
                    // Selectable (v0.29.0): long-press and
                    // drag selects PART of a message to copy
                    // just that — the whole-message Copy and
                    // Share live on the bubble's context menu.
                    .textSelection(.enabled)
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
                    Text(model.mode == .onDevice
                         ? "Photo attached — photos need Core mode; this brain can't see pictures."
                         : "Photo attached — it sends with your message, and GUS sees it on your Mac.")
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
    let id: UUID
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

    init(id: UUID = UUID(), exchangeID: UUID, role: Role, text: String,
         photoData: Data? = nil, photoNote: String? = nil,
         held: Bool = false, dropped: Bool = false, blocked: Bool = false) {
        self.id = id
        self.exchangeID = exchangeID
        self.role = role
        self.text = text
        self.photoData = photoData
        self.photoNote = photoNote
        self.held = held
        self.dropped = dropped
        self.blocked = blocked
    }

    /// The text Copy and Share move (v0.29.0): the message's
    /// own words when it has any. A photo message with no
    /// words shares a "[Photo]" placeholder — image data
    /// never rides a text share. This is the DISPLAYED
    /// text: for a Core reply the Shield stopped, the view
    /// shows the canned line, and the canned line is what
    /// shares — the store's verbatim record stays home.
    var shareText: String {
        if !text.isEmpty { return text }
        if photoData != nil || photoNote != nil { return "[Photo]" }
        return ""
    }
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
    private var pendingCoreExchanges: [UUID] = []
    /// v0.26.0: the durable sync store — the ONE conversation,
    /// shared with the core by union merge. The view's
    /// record-backed messages ARE store records (same UUID);
    /// notices and the streaming reply bubble stay session
    /// ephemera and are never stored or synced.
    private let store = ChatHistoryStore()
    /// Record UUID → the exchange the view groups it under.
    private var exchangeByRecordId: [UUID: UUID] = [:]
    /// Exchange → the operator's store record for it, so a
    /// Core dispatch carries the record's birth identity.
    private var userRecordByExchange: [UUID: SyncedChatRecord] = [:]
    private var syncInFlight = false

    init() {
        loadStoredHistory()
    }

    /// The view's opening state is the store's canonical
    /// history — the same merged order the core renders.
    /// Exchanges derive causally: an "in" record opens an
    /// exchange; the "out" records that follow join it.
    private func loadStoredHistory() {
        var currentExchange: UUID?
        for record in store.ordered {
            guard let rid = UUID(uuidString: record.id) else { continue }
            let exchange: UUID
            if record.direction == "in" {
                exchange = rid
                currentExchange = rid
            } else {
                exchange = currentExchange ?? rid
            }
            exchangeByRecordId[rid] = exchange
            var message = ChatMessage(
                id: rid, exchangeID: exchange,
                role: record.direction == "in" ? .user : .assistant,
                text: record.text)
            if record.direction == "in", let photos = record.photos, photos > 0 {
                message.photoNote = photos == 1 ? "1 photo" : "\(photos) photos"
            }
            messages.append(message)
        }
    }
    /// Exchanges where a reply sentence was already replaced
    /// by the canned line (one per exchange, as on the call).
    private var cannedReplyExchanges: Set<UUID> = []

    var coreConnected: Bool { GUSSettings.isConfigured }

    var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || photoData != nil
    }

    func refreshMode() {
        mode = CallMode.preferred
        // Appearing is a sync moment: whatever the desk said
        // while this screen was away folds in, and whatever
        // this phone said offline flows out.
        syncWithCore()
    }

    func receipts(for exchangeID: UUID) -> [ShieldReceipt] {
        receiptsByExchange[exchangeID] ?? []
    }

    /// The whole visible conversation as plain text
    /// (v0.29.0) — "You: …" / "GUS: …" paragraphs in the
    /// order on screen, built from the DISPLAYED text
    /// (ChatMessage.shareText), so a stopped Core reply
    /// exports as its canned line and a photo exports as
    /// its words or "[Photo]", never image data. Notices
    /// are session ephemera, not conversation, and stay
    /// out.
    func exportText() -> String {
        messages.compactMap { message in
            switch message.role {
            case .notice:
                return nil
            case .user:
                return message.shareText.isEmpty ? nil : "You: \(message.shareText)"
            case .assistant:
                return message.shareText.isEmpty ? nil : "GUS: \(message.shareText)"
            }
        }
        .joined(separator: "\n\n")
    }

    // MARK: Photos

    func photoPicked(_ item: PhotosPickerItem?) {
        guard let item else {
            photoData = nil
            return
        }
        Task {
            let raw = try? await item.loadTransferable(type: Data.self)
            photoData = raw.map { Self.transportPhotoData($0) }
        }
    }

    /// Re-encode a picked photo for transport, at attach time:
    /// the picker hands back the library's original bytes —
    /// possibly a multi-megabyte HEIC the core's brain APIs
    /// can't read. Decode, cap the long edge at 1568 px (the
    /// vision APIs' own working size), and re-encode as JPEG:
    /// what reaches the core is a few hundred KB in a format
    /// every vision model accepts. A pick that won't decode
    /// keeps its original bytes rather than vanishing.
    private static func transportPhotoData(_ raw: Data) -> Data {
        guard let image = UIImage(data: raw) else { return raw }
        let maxEdge: CGFloat = 1568
        let longest = max(image.size.width, image.size.height)
        var out = image
        if longest > maxEdge {
            let scale = maxEdge / longest
            let size = CGSize(width: image.size.width * scale,
                              height: image.size.height * scale)
            let renderer = UIGraphicsImageRenderer(size: size)
            out = renderer.image { _ in
                image.draw(in: CGRect(origin: .zero, size: size))
            }
        }
        return out.jpegData(compressionQuality: 0.8) ?? raw
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
        // v0.26.0: the message is BORN as a sync record —
        // in the durable store, chained to the conversation
        // head, before the Shield gate runs. The gate governs
        // whether the words are DISPATCHED to a brain, never
        // whether they exist: a blocked or held message is
        // still the operator's own history on his own devices,
        // exactly as the core's transcript records a panel
        // submission before its pipeline scan.
        let syncRecord = store.appendLocal(
            direction: "in", text: text, photos: photo != nil ? 1 : 0)
        let recordUUID = UUID(uuidString: syncRecord.id) ?? UUID()
        exchangeByRecordId[recordUUID] = exchangeID
        userRecordByExchange[exchangeID] = syncRecord
        let message = ChatMessage(
            id: recordUUID, exchangeID: exchangeID, role: .user,
            text: text, photoData: photo)
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
        if let photo {
            // v0.24.0: photos DELIVER — in Core mode. The image
            // rides the chat submission to the Mac, whose brain
            // receives it as image input (the core's transcript
            // records the count, never the image). The
            // on-device brains take text only — the local
            // models have no image input at all — so a photo
            // message in on-device mode is not dispatched, in
            // whole or in part: the note on the message says
            // why, in plain words, at send time. Never a silent
            // drop, never a pretend delivery.
            if mode == .onDevice {
                setPhotoNote(exchangeID: exchangeID,
                    note: "This brain can't look at photos yet — switch to Core to ask about pictures.")
                return
            }
            dispatchCore(exchangeID: exchangeID, text: text, images: [photo])
            return
        }
        if mode == .onDevice {
            dispatchOnDevice(exchangeID: exchangeID, text: text)
        } else {
            dispatchCore(exchangeID: exchangeID, text: text)
        }
    }

    /// The note under a message's photo — set when the photo's
    /// fate is known (delivered, refused by mode, or failed).
    private func setPhotoNote(exchangeID: UUID, note: String) {
        if let i = messages.firstIndex(where: { $0.exchangeID == exchangeID && $0.role == .user }) {
            messages[i].photoNote = note
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
            } else if let assembled = self.messages.last(where: {
                $0.exchangeID == exchangeID && $0.role == .assistant
            })?.text, !assembled.isEmpty {
                // v0.26.0: the reply joins the durable history
                // as a phone-born record — the SHOWN text,
                // post-scan (a stopped sentence's record is
                // the canned line: the stopped words were
                // never delivered, so they are not the
                // message). It syncs to the desk like
                // everything else in the store.
                let replyRecord = self.store.appendLocal(direction: "out", text: assembled)
                if let rid = UUID(uuidString: replyRecord.id) {
                    self.exchangeByRecordId[rid] = exchangeID
                }
            }
            self.replyingCount -= 1
            // Share the finished exchange with the desk
            // promptly when a core is configured.
            self.syncWithCore()
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
        // The ACTIVE brain, same resolution as the call's
        // (v0.21.0 — ActiveBrain in ModelManifest.swift).
        guard let entry = ActiveBrain.resolved() else {
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

    private func dispatchCore(exchangeID: UUID, text: String, images: [Data] = []) {
        replyingCount += 1
        Task { [weak self] in
            guard let self else { return }
            do {
                // v0.26.0: the submission carries the message's
                // sync identity — the core records it under its
                // birth identity (this phone is the creating
                // device) and the reply comes back through sync,
                // recognized by ID, never by transcript position.
                let identity = self.userRecordByExchange[exchangeID].map {
                    ChatSubmitSync(
                        id: $0.id, deviceId: $0.deviceId, seq: $0.seq,
                        prevId: $0.prevId, ts: $0.ts)
                }
                let result = try await self.client.chat(text: text, images: images, sync: identity)
                guard result.ok else {
                    if !images.isEmpty {
                        self.setPhotoNote(exchangeID: exchangeID,
                            note: "The photo wasn't sent — your Mac's GUS refused the message.")
                    }
                    self.appendNotice(exchangeID: exchangeID, text: result.detail)
                    self.replyingCount -= 1
                    return
                }
                if !images.isEmpty {
                    self.setPhotoNote(exchangeID: exchangeID,
                        note: "Photo sent to your Mac — GUS can see it there.")
                }
                self.pendingCoreExchanges.append(exchangeID)
                self.startCorePolling()
            } catch {
                if !images.isEmpty {
                    self.setPhotoNote(exchangeID: exchangeID,
                        note: "The photo wasn't sent — your Mac couldn't be reached.")
                }
                self.appendNotice(exchangeID: exchangeID,
                    text: "Couldn't reach your GUS core: \(error.localizedDescription)")
                self.replyingCount -= 1
            }
        }
    }

    /// Polls sync while any Core exchange is waiting: the
    /// channel is asynchronous, and the reply arrives as a
    /// core-born "out" record in a sync exchange. The loop
    /// makes no request while nothing is pending and dies
    /// with the model.
    private func startCorePolling() {
        guard corePollTask == nil else { return }
        corePollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if !self.pendingCoreExchanges.isEmpty {
                    self.syncWithCore()
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    // MARK: Sync (v0.26.0)

    /// One sync exchange with the core, in the design's two
    /// steps: name every record ID this phone holds and fold
    /// in what it lacks; then push the records the core still
    /// wants. Best-effort by design — offline is a normal
    /// state for this app, a failed exchange changes nothing,
    /// and the stores converge on the next one that lands.
    func syncWithCore() {
        guard coreConnected, !syncInFlight else { return }
        syncInFlight = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.syncInFlight = false }
            do {
                let first = try await self.client.chatSync(
                    deviceId: self.store.deviceId,
                    haveIds: self.store.allIds,
                    messages: [])
                let arrivals = self.store.ingest(
                    first.missing.map { SyncedChatRecord(wire: $0) })
                self.processArrivals(arrivals.added)
                if !first.wantIds.isEmpty {
                    let wanted = self.store.messages(forIds: first.wantIds)
                    _ = try await self.client.chatSync(
                        deviceId: self.store.deviceId,
                        haveIds: self.store.allIds,
                        messages: wanted.map { $0.wire })
                }
            } catch {
                // Unreachable core: nothing folded, nothing
                // lost — every record is durable on this side.
            }
        }
    }

    /// Fold newly arrived records into the view, at their
    /// canonical positions. "out" records get the arrival
    /// scan a Core reply has always gotten (below); "in"
    /// records are the operator's own words from another
    /// surface — the core's Shield ingress scanned them when
    /// they were submitted there, and sync itself never
    /// dispatches anything to a brain, so there is no
    /// unscanned path from a synced record to a model.
    private func processArrivals(_ records: [SyncedChatRecord]) {
        for record in records {
            guard let rid = UUID(uuidString: record.id) else { continue }
            if record.direction == "out" {
                let exchangeID: UUID
                if !pendingCoreExchanges.isEmpty {
                    exchangeID = pendingCoreExchanges.removeFirst()
                    replyingCount -= 1
                } else if let preceding = precedingExchange(for: record) {
                    exchangeID = preceding
                } else {
                    exchangeID = UUID()
                }
                exchangeByRecordId[rid] = exchangeID
                let shown = scannedReplyText(exchangeID: exchangeID, text: record.text)
                insertViewMessage(
                    ChatMessage(id: rid, exchangeID: exchangeID, role: .assistant, text: shown),
                    record: record)
            } else {
                exchangeByRecordId[rid] = rid
                var message = ChatMessage(
                    id: rid, exchangeID: rid, role: .user, text: record.text)
                if let photos = record.photos, photos > 0 {
                    message.photoNote = photos == 1 ? "1 photo" : "\(photos) photos"
                }
                insertViewMessage(message, record: record)
            }
        }
    }

    /// The exchange a synced reply belongs to when no Core
    /// exchange is pending: the nearest preceding "in"
    /// record's exchange (a reply from a conversation the
    /// desk had — it renders under the words it answered).
    private func precedingExchange(for record: SyncedChatRecord) -> UUID? {
        let ordered = store.ordered
        guard let index = ordered.firstIndex(where: { $0.id == record.id }) else { return nil }
        for prior in ordered[..<index].reversed() where prior.direction == "in" {
            if let rid = UUID(uuidString: prior.id) {
                return exchangeByRecordId[rid] ?? rid
            }
        }
        return nil
    }

    /// Insert a record-backed message at its canonical
    /// position among the view's record-backed messages.
    /// Session ephemera (notices, the streaming bubble) are
    /// not in the canonical order and keep their places.
    private func insertViewMessage(_ message: ChatMessage, record: SyncedChatRecord) {
        let ordered = store.ordered
        guard let index = ordered.firstIndex(where: { $0.id == record.id }) else {
            messages.append(message)
            return
        }
        let laterIds = Set(ordered[(index + 1)...].map { $0.id.lowercased() })
        if let at = messages.firstIndex(where: {
            laterIds.contains($0.id.uuidString.lowercased())
        }) {
            messages.insert(message, at: at)
        } else {
            messages.append(message)
        }
    }

    /// A Core reply, scanned whole on arrival — Core replies
    /// arrive whole, not sentence by sentence. The receipt
    /// is written before the text is shown, and a blocked
    /// reply is replaced by the canned line: the words
    /// themselves never render. A quarantined reply is
    /// shown; the receipt carries the warning. The STORE
    /// always keeps the record verbatim — the substitution
    /// is display-only, or the two stores' copies of one
    /// message would diverge and every merge would conflict.
    private func scannedReplyText(exchangeID: UUID, text: String) -> String {
        var shown = text
        if ShieldSettings.enabled {
            let scan = ShieldScanner.scan(text, posture: ShieldSettings.posture)
            record(scan, direction: .assistant, exchangeID: exchangeID)
            if scan.verdict == .block {
                shown = "I stopped part of that reply — it matched a known injection pattern."
            }
        }
        return shown
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
