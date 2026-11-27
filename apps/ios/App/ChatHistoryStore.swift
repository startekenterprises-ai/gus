import Foundation

/// Chat-history sync (v0.26.0) — the phone's side of the ONE
/// conversation (design: 2026-11-20, gus-ios-ux-feedback
/// Addendum 17; merge core: packages/shared/src/chat-sync.ts,
/// which this file mirrors function-for-function so both
/// stores converge to the same set in the same order).
///
/// The rules, identical on both sides:
///  - Messages are APPEND-ONLY and immutable, born with a
///    globally unique ID, the creating device's ID, a
///    per-device sequence number, and a causal pointer
///    (`prevId` — the last message the creator had seen).
///    Timestamps are display-only; ordering never reads them.
///  - Merge = UNION by ID, never overwrite. A message seen
///    twice is recognized by ID and skipped.
///  - Order is causal: a message sorts after the one it saw;
///    concurrent siblings (two devices writing offline from
///    the same head) interleave by (deviceId, seq, id) —
///    deterministic, clock-free, identical everywhere.
///  - A divergent copy of one ID (corruption/tampering —
///    honest sync cannot produce one) resolves by a
///    field-by-field deterministic winner; the loser is
///    counted here and archived on the core. Nothing is
///    silently dropped.
///
/// The store file is append-only JSONL in Application
/// Support/GUS/chat-history.jsonl — the Shield receipts'
/// storage pattern. It holds TEXT and photo COUNTS only;
/// image data never enters a synced record.
///
/// v0.34.0: the store also holds TOMBSTONES — deletion as a
/// synced record (see SyncedChatTombstone below). Applying
/// one removes the target from the in-memory set AND from
/// the file (a whole-file rewrite, the core migration's
/// atomic pattern): a delete that left the words on disk
/// would not be a delete. The tombstone lines themselves
/// stay — they carry no content, and they are what stops a
/// late-arriving copy of the target from being filed again.

// MARK: - The record

struct SyncedChatRecord: Equatable {
    var id: String
    var deviceId: String
    var seq: Int
    var prevId: String?
    /// Milliseconds since the epoch — display only.
    var ts: Double
    /// "in" = the operator's words; "out" = what GUS delivered.
    var direction: String
    var text: String
    /// Photo count only — never image data.
    var photos: Int?

    /// The same strict shape check the core applies
    /// (validateSyncedChatMessage): anything malformed is
    /// refused entry to the store.
    static func validated(_ r: SyncedChatRecord) -> SyncedChatRecord? {
        guard !r.id.isEmpty, r.id.count <= 128,
              !r.deviceId.isEmpty, r.deviceId.count <= 128,
              r.seq >= 0,
              r.ts.isFinite, r.ts >= 0,
              r.direction == "in" || r.direction == "out",
              r.text.count <= 8_000
        else { return nil }
        if let prevId = r.prevId {
            guard !prevId.isEmpty, prevId.count <= 128 else { return nil }
        }
        var out = r
        if let photos = r.photos {
            guard photos >= 0, photos <= 64 else { return nil }
            if photos == 0 { out.photos = nil }
        }
        return out
    }
}

extension SyncedChatRecord: Codable {
    enum CodingKeys: String, CodingKey {
        case id, deviceId, seq, prevId, ts, direction, text, photos
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        deviceId = try c.decode(String.self, forKey: .deviceId)
        seq = try c.decode(Int.self, forKey: .seq)
        prevId = try c.decodeIfPresent(String.self, forKey: .prevId)
        ts = try c.decode(Double.self, forKey: .ts)
        direction = try c.decode(String.self, forKey: .direction)
        text = try c.decode(String.self, forKey: .text)
        photos = try c.decodeIfPresent(Int.self, forKey: .photos)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(deviceId, forKey: .deviceId)
        try c.encode(seq, forKey: .seq)
        // prevId is written explicitly (null when genesis):
        // the wire contract names it on every record.
        if let prevId {
            try c.encode(prevId, forKey: .prevId)
        } else {
            try c.encodeNil(forKey: .prevId)
        }
        try c.encode(ts, forKey: .ts)
        try c.encode(direction, forKey: .direction)
        try c.encode(text, forKey: .text)
        if let photos, photos > 0 {
            try c.encode(photos, forKey: .photos)
        }
    }
}

// MARK: - The tombstone (v0.34.0)

/// A deletion, as a synced record — the mirror of
/// @gus/shared's SyncedChatTombstone. Same identity
/// discipline as a message (own ID, creating device, a
/// sequence number from the SAME per-device counter the
/// messages draw from, a causal pointer, a display-only
/// timestamp) plus `targetId`, the message it kills. It
/// carries no content. The rule is set-shaped: a tombstone
/// wins over any copy of its target whenever the copy
/// arrives — before the tombstone, with it, or long after.
struct SyncedChatTombstone: Equatable {
    var id: String
    var deviceId: String
    var seq: Int
    var prevId: String?
    /// Milliseconds since the epoch — display only.
    var ts: Double
    /// The message this tombstone deletes.
    var targetId: String

    /// The same strict shape check the core applies
    /// (validateSyncedChatTombstone).
    static func validated(_ r: SyncedChatTombstone) -> SyncedChatTombstone? {
        guard !r.id.isEmpty, r.id.count <= 128,
              !r.deviceId.isEmpty, r.deviceId.count <= 128,
              r.seq >= 0,
              r.ts.isFinite, r.ts >= 0,
              !r.targetId.isEmpty, r.targetId.count <= 128,
              r.targetId != r.id
        else { return nil }
        if let prevId = r.prevId {
            guard !prevId.isEmpty, prevId.count <= 128 else { return nil }
        }
        return r
    }
}

extension SyncedChatTombstone: Codable {
    enum CodingKeys: String, CodingKey {
        case kind, id, deviceId, seq, prevId, ts, targetId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // The discriminant is what tells a tombstone line
        // from a message line on the shared store file —
        // anything else is not a tombstone and throws, so
        // the loader falls through to the message decode.
        let kind = try c.decode(String.self, forKey: .kind)
        guard kind == "tombstone" else {
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: c,
                debugDescription: "not a tombstone line")
        }
        id = try c.decode(String.self, forKey: .id)
        deviceId = try c.decode(String.self, forKey: .deviceId)
        seq = try c.decode(Int.self, forKey: .seq)
        prevId = try c.decodeIfPresent(String.self, forKey: .prevId)
        ts = try c.decode(Double.self, forKey: .ts)
        targetId = try c.decode(String.self, forKey: .targetId)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode("tombstone", forKey: .kind)
        try c.encode(id, forKey: .id)
        try c.encode(deviceId, forKey: .deviceId)
        try c.encode(seq, forKey: .seq)
        if let prevId {
            try c.encode(prevId, forKey: .prevId)
        } else {
            try c.encodeNil(forKey: .prevId)
        }
        try c.encode(ts, forKey: .ts)
        try c.encode(targetId, forKey: .targetId)
    }
}

// MARK: - The merge rules (mirror of chat-sync.ts)

enum ChatSyncRules {
    /// Sibling order for concurrent branches: (deviceId, seq, id).
    static func siblingLess(_ a: SyncedChatRecord, _ b: SyncedChatRecord) -> Bool {
        if a.deviceId != b.deviceId { return a.deviceId < b.deviceId }
        if a.seq != b.seq { return a.seq < b.seq }
        return a.id < b.id
    }

    static func same(_ a: SyncedChatRecord, _ b: SyncedChatRecord) -> Bool {
        a.id == b.id && a.deviceId == b.deviceId && a.seq == b.seq
            && a.prevId == b.prevId && a.ts == b.ts
            && a.direction == b.direction && a.text == b.text
            && (a.photos ?? 0) == (b.photos ?? 0)
    }

    /// The conflict comparison: negative when `a` wins.
    /// (deviceId, seq, ts, direction, text, prevId, photos) —
    /// pure value comparison, so every implementation picks
    /// the same winner from the same pair.
    static func copyCompare(_ a: SyncedChatRecord, _ b: SyncedChatRecord) -> Int {
        if a.deviceId != b.deviceId { return a.deviceId < b.deviceId ? -1 : 1 }
        if a.seq != b.seq { return a.seq < b.seq ? -1 : 1 }
        if a.ts != b.ts { return a.ts < b.ts ? -1 : 1 }
        if a.direction != b.direction { return a.direction < b.direction ? -1 : 1 }
        if a.text != b.text { return a.text < b.text ? -1 : 1 }
        let ap = a.prevId ?? ""
        let bp = b.prevId ?? ""
        if ap != bp { return ap < bp ? -1 : 1 }
        let af = a.photos ?? 0
        let bf = b.photos ?? 0
        if af != bf { return af < bf ? -1 : 1 }
        return 0
    }

    /// The canonical causal order (Kahn's walk over prevId
    /// links with a sibling-sorted frontier). A prevId outside
    /// the set is a root; a cycle — impossible from honest
    /// assignment — appends the rest in sibling order rather
    /// than dropping anything.
    static func order(_ messages: [SyncedChatRecord]) -> [SyncedChatRecord] {
        var byId: [String: SyncedChatRecord] = [:]
        for m in messages { byId[m.id] = m }
        var children: [String: [SyncedChatRecord]] = [:]
        var roots: [SyncedChatRecord] = []
        for m in byId.values {
            if let prev = m.prevId, byId[prev] != nil, prev != m.id {
                children[prev, default: []].append(m)
            } else {
                roots.append(m)
            }
        }
        roots.sort(by: siblingLess)
        for key in children.keys {
            children[key]?.sort(by: siblingLess)
        }
        var out: [SyncedChatRecord] = []
        var emitted: Set<String> = []
        var frontier = roots
        while !frontier.isEmpty {
            let next = frontier.removeFirst()
            if emitted.contains(next.id) { continue }
            emitted.insert(next.id)
            out.append(next)
            for child in children[next.id] ?? [] {
                var i = frontier.count
                while i > 0, siblingLess(child, frontier[i - 1]) {
                    i -= 1
                }
                frontier.insert(child, at: i)
            }
        }
        if out.count < byId.count {
            let rest = byId.values
                .filter { !emitted.contains($0.id) }
                .sorted(by: siblingLess)
            out.append(contentsOf: rest)
        }
        return out
    }

    /// Union fold of one record into a set: returns the
    /// conflict when a divergent copy was already held.
    static func fold(
        _ record: SyncedChatRecord,
        into byId: inout [String: SyncedChatRecord]
    ) -> (kept: SyncedChatRecord, dropped: SyncedChatRecord)? {
        guard let held = byId[record.id] else {
            byId[record.id] = record
            return nil
        }
        if same(held, record) { return nil }
        let winner = copyCompare(held, record) <= 0 ? held : record
        let loser = same(winner, held) ? record : held
        byId[record.id] = winner
        return (kept: winner, dropped: loser)
    }

    // MARK: Tombstone rules (v0.34.0 — mirror of chat-sync.ts)

    /// Deterministic tombstone order: (deviceId, seq, id) —
    /// the sibling order, so a store's tombstone list reads
    /// identically on every device.
    static func tombstoneLess(_ a: SyncedChatTombstone, _ b: SyncedChatTombstone) -> Bool {
        if a.deviceId != b.deviceId { return a.deviceId < b.deviceId }
        if a.seq != b.seq { return a.seq < b.seq }
        return a.id < b.id
    }

    static func sameTombstone(_ a: SyncedChatTombstone, _ b: SyncedChatTombstone) -> Bool {
        a.id == b.id && a.deviceId == b.deviceId && a.seq == b.seq
            && a.prevId == b.prevId && a.ts == b.ts && a.targetId == b.targetId
    }

    /// The tombstone conflict comparison: negative when `a`
    /// wins. (deviceId, seq, ts, targetId, prevId) — the
    /// message rule's field order with the tombstone's
    /// payload in the text slot.
    static func tombstoneCopyCompare(_ a: SyncedChatTombstone, _ b: SyncedChatTombstone) -> Int {
        if a.deviceId != b.deviceId { return a.deviceId < b.deviceId ? -1 : 1 }
        if a.seq != b.seq { return a.seq < b.seq ? -1 : 1 }
        if a.ts != b.ts { return a.ts < b.ts ? -1 : 1 }
        if a.targetId != b.targetId { return a.targetId < b.targetId ? -1 : 1 }
        let ap = a.prevId ?? ""
        let bp = b.prevId ?? ""
        if ap != bp { return ap < bp ? -1 : 1 }
        return 0
    }

    /// Union fold of one tombstone into a set: returns the
    /// conflict when a divergent copy was already held.
    static func foldTombstone(
        _ tombstone: SyncedChatTombstone,
        into byId: inout [String: SyncedChatTombstone]
    ) -> (kept: SyncedChatTombstone, dropped: SyncedChatTombstone)? {
        guard let held = byId[tombstone.id] else {
            byId[tombstone.id] = tombstone
            return nil
        }
        if sameTombstone(held, tombstone) { return nil }
        let winner = tombstoneCopyCompare(held, tombstone) <= 0 ? held : tombstone
        let loser = sameTombstone(winner, held) ? tombstone : held
        byId[tombstone.id] = winner
        return (kept: winner, dropped: loser)
    }
}

// MARK: - The store

final class ChatHistoryStore {
    /// The one store (v0.34.0): Chat owns it, and Settings'
    /// Privacy section deletes through the same instance —
    /// two instances over one file would hold two divergent
    /// in-memory sets, and a delete through one would be
    /// invisible to the other until a relaunch.
    static let shared = ChatHistoryStore()

    /// This phone's sync device ID — minted once, kept in
    /// UserDefaults (an identity, not a secret).
    let deviceId: String

    /// Every record held, in canonical causal order.
    private(set) var ordered: [SyncedChatRecord] = []
    private var byId: [String: SyncedChatRecord] = [:]
    /// v0.34.0: every tombstone held, by its own ID, and the
    /// target set they suppress. Tombstones are store state,
    /// not a view filter: a target named here is refused at
    /// ingest and removed from the file, durably.
    private var tombstonesById: [String: SyncedChatTombstone] = [:]
    private(set) var tombstonedTargets: Set<String> = []
    private var nextSeq: Int
    /// Divergent copies seen this session (diagnostic only —
    /// the core archives the losers durably).
    private(set) var conflictCount = 0
    /// Bumps on every mutation (birth, ingest change,
    /// deletion). The chat view rebuilds from the store when
    /// the revision it rendered differs — that is how a
    /// deletion made in Settings lands in Chat without the
    /// two sharing a model object.
    private(set) var revision = 0

    init() {
        let key = "gus.chat.deviceId"
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
            deviceId = existing
        } else {
            let minted = UUID().uuidString.lowercased()
            UserDefaults.standard.set(minted, forKey: key)
            deviceId = minted
        }
        nextSeq = 1
        load()
        // One per-device sequence across BOTH record kinds:
        // a tombstone this device minted draws the next
        // number after its messages, never a reused one.
        let ownMessageSeq = ordered.filter { $0.deviceId == deviceId }.map(\.seq).max() ?? 0
        let ownTombstoneSeq = tombstonesById.values
            .filter { $0.deviceId == deviceId }.map(\.seq).max() ?? 0
        nextSeq = max(ownMessageSeq, ownTombstoneSeq) + 1
    }

    /// Every RECORD ID held — messages and tombstones in
    /// one ID space (each ID is minted once, for one kind).
    /// This is the have-list a sync exchange names.
    var allIds: [String] { Array(byId.keys) + Array(tombstonesById.keys) }

    func record(id: String) -> SyncedChatRecord? { byId[id] }

    func messages(forIds ids: [String]) -> [SyncedChatRecord] {
        ids.compactMap { byId[$0] }
    }

    /// Every tombstone held, in the deterministic order —
    /// the list a sync answer's have/want runs over.
    var allTombstones: [SyncedChatTombstone] {
        tombstonesById.values.sorted(by: ChatSyncRules.tombstoneLess)
    }

    func tombstones(forIds ids: [String]) -> [SyncedChatTombstone] {
        ids.compactMap { tombstonesById[$0] }
    }

    /// A message born on this phone: minted with this device's
    /// next sequence and chained to the current head. It is in
    /// the store (and therefore in history, and in every later
    /// sync) from birth — the Shield gate governs whether it is
    /// DISPATCHED to a brain, never whether it exists.
    func appendLocal(direction: String, text: String, photos: Int = 0) -> SyncedChatRecord {
        let record = SyncedChatRecord(
            id: UUID().uuidString.lowercased(),
            deviceId: deviceId,
            seq: nextSeq,
            prevId: ordered.last?.id,
            ts: Date().timeIntervalSince1970 * 1_000,
            direction: direction,
            text: text,
            photos: photos > 0 ? photos : nil)
        nextSeq += 1
        appendLine(record)
        byId[record.id] = record
        // prevId is the old head, so canonical order appends.
        ordered.append(record)
        revision += 1
        return record
    }

    // MARK: Deletion (v0.34.0)

    /// Delete one message from this store: mint a tombstone
    /// under this phone's identity (the shared per-device
    /// sequence), drop the target from the set, and rewrite
    /// the file without its line — the content leaves the
    /// disk, not just the screen. Deleting an ID this store
    /// doesn't hold still mints the tombstone: its standing
    /// job is to refuse the target if it ever arrives.
    /// Deleting an already-deleted ID returns the standing
    /// tombstone and changes nothing.
    @discardableResult
    func deleteLocal(targetId: String) -> SyncedChatTombstone {
        if let existing = tombstonesById.values.first(where: { $0.targetId == targetId }) {
            return existing
        }
        let tombstone = SyncedChatTombstone(
            id: UUID().uuidString.lowercased(),
            deviceId: deviceId,
            seq: nextSeq,
            prevId: ordered.last?.id,
            ts: Date().timeIntervalSince1970 * 1_000,
            targetId: targetId)
        nextSeq += 1
        tombstonesById[tombstone.id] = tombstone
        tombstonedTargets.insert(targetId)
        byId.removeValue(forKey: targetId)
        ordered = ChatSyncRules.order(Array(byId.values))
        rewriteFile()
        revision += 1
        return tombstone
    }

    /// Delete EVERY message this store holds — one tombstone
    /// per message, chained in canonical order, then a
    /// single rewrite that leaves the file holding only
    /// tombstone lines. The tombstones sync to the core on
    /// the next exchange, and the deletion lands there the
    /// same way: this is the Settings → Privacy "Delete chat
    /// history" hammer, and it is deliberately exactly as
    /// strong on the Mac as it is here.
    @discardableResult
    func deleteAllLocal() -> [SyncedChatTombstone] {
        guard !ordered.isEmpty else { return [] }
        var minted: [SyncedChatTombstone] = []
        var prevId: String? = ordered.last?.id
        for record in ordered {
            let tombstone = SyncedChatTombstone(
                id: UUID().uuidString.lowercased(),
                deviceId: deviceId,
                seq: nextSeq,
                prevId: prevId,
                ts: Date().timeIntervalSince1970 * 1_000,
                targetId: record.id)
            nextSeq += 1
            prevId = tombstone.id
            minted.append(tombstone)
            tombstonesById[tombstone.id] = tombstone
            tombstonedTargets.insert(record.id)
        }
        byId = [:]
        ordered = []
        rewriteFile()
        revision += 1
        return minted
    }

    /// Fold records in from a sync exchange. Returns the newly
    /// added records in canonical order (arrivals the view
    /// hasn't shown), the IDs a newly applied tombstone
    /// REMOVED from the view (v0.34.0 — the caller takes those
    /// bubbles off the screen in the same beat), and the
    /// number of divergent copies met.
    /// A winning incoming copy is filed too (the filed loser
    /// stays — the fold resolves the pair on every load).
    ///
    /// v0.34.0: tombstones fold FIRST. A message whose ID is
    /// tombstoned — by a tombstone that arrived in this same
    /// exchange or any earlier one — is refused: never filed,
    /// never added, never counted as a conflict. That refusal
    /// is the tombstone-first rule, and it is what makes a
    /// deletion survive a peer that still holds the message.
    func ingest(
        _ incoming: [SyncedChatRecord],
        tombstones incomingTombstones: [SyncedChatTombstone] = []
    ) -> (added: [SyncedChatRecord], removedIds: [String], conflicts: Int) {
        var added: [SyncedChatRecord] = []
        var removedIds: [String] = []
        var conflicts = 0
        var viewChanged = false
        var fileNeedsRewrite = false
        var newTombstones: [SyncedChatTombstone] = []

        // Phase 1: tombstones. A newly applied one removes
        // its target from the set (and, via the rewrite
        // below, from the file) in this same pass.
        for raw in incomingTombstones {
            guard let tombstone = SyncedChatTombstone.validated(raw) else { continue }
            let heldBefore = tombstonesById[tombstone.id]
            if let conflict = ChatSyncRules.foldTombstone(tombstone, into: &tombstonesById) {
                conflicts += 1
                conflictCount += 1
                // The incoming copy won (the held copy wasn't
                // kept): file it too — the filed loser stays,
                // and the fold resolves the pair on every load.
                if let heldBefore,
                   !ChatSyncRules.sameTombstone(conflict.kept, heldBefore) {
                    newTombstones.append(tombstone)
                }
            } else if heldBefore == nil {
                newTombstones.append(tombstone)
            }
            // Whatever copy won, its target is suppressed
            // from here on.
            if let winner = tombstonesById[tombstone.id],
               !tombstonedTargets.contains(winner.targetId) {
                tombstonedTargets.insert(winner.targetId)
                if byId.removeValue(forKey: winner.targetId) != nil {
                    removedIds.append(winner.targetId)
                    viewChanged = true
                    fileNeedsRewrite = true
                }
            }
        }

        // Phase 2: messages, with the suppression set live.
        for raw in incoming {
            guard let record = SyncedChatRecord.validated(raw) else { continue }
            if tombstonedTargets.contains(record.id) { continue }
            let wasHeld = byId[record.id]
            if let conflict = ChatSyncRules.fold(record, into: &byId) {
                conflicts += 1
                conflictCount += 1
                viewChanged = true
                // The incoming copy won (the held copy wasn't
                // kept): file it too — the filed loser stays,
                // and the fold resolves the pair on every load.
                if let held = wasHeld, !ChatSyncRules.same(conflict.kept, held) {
                    appendLine(record)
                }
                continue
            }
            if wasHeld == nil {
                appendLine(record)
                added.append(record)
            }
        }

        // The file: a removal rewrites it whole (the rewrite
        // below regenerates every line from memory, new
        // arrivals included, so the appends above are
        // superseded, never lost); without a removal, the
        // new tombstone lines simply append.
        if fileNeedsRewrite {
            rewriteFile()
        } else {
            for tombstone in newTombstones {
                appendLine(tombstone)
            }
        }
        if !added.isEmpty || viewChanged {
            ordered = ChatSyncRules.order(Array(byId.values))
            revision += 1
        }
        let addedIds = Set(added.map(\.id))
        return (ordered.filter { addedIds.contains($0.id) }, removedIds, conflicts)
    }

    // MARK: Storage (JSONL in the app sandbox)

    private var storeFileURL: URL? {
        guard let base = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        let dir = base.appendingPathComponent("GUS", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("chat-history.jsonl")
    }

    private static let lineEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    private func load() {
        guard let url = storeFileURL,
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8)
        else { return }
        let decoder = JSONDecoder()
        var folded: [String: SyncedChatRecord] = [:]
        var foldedTombstones: [String: SyncedChatTombstone] = [:]
        for line in text.split(separator: "\n") {
            let lineData = Data(line.utf8)
            // Tombstone lines first: their decoder requires
            // the kind discriminant, so a message line never
            // matches it, and a tombstone line (no direction,
            // no text) never matches the message decode.
            if let tombstone = try? decoder.decode(
                SyncedChatTombstone.self, from: lineData),
                let valid = SyncedChatTombstone.validated(tombstone) {
                if ChatSyncRules.foldTombstone(valid, into: &foldedTombstones) != nil {
                    conflictCount += 1
                }
                continue
            }
            guard let record = try? decoder.decode(
                SyncedChatRecord.self, from: lineData),
                let valid = SyncedChatRecord.validated(record)
            else { continue }
            if ChatSyncRules.fold(valid, into: &folded) != nil {
                conflictCount += 1
            }
        }
        tombstonesById = foldedTombstones
        tombstonedTargets = Set(foldedTombstones.values.map(\.targetId))
        // A tombstoned message can still be on disk exactly
        // once in the store's life: a crash (or an older
        // build) left its line beside the tombstone's. It
        // leaves the set here, and the rewrite below takes
        // its line with it — deleted content does not get
        // to stay filed just because the process died
        // mid-delete.
        var droppedLine = false
        for targetId in tombstonedTargets {
            if folded.removeValue(forKey: targetId) != nil {
                droppedLine = true
            }
        }
        byId = folded
        ordered = ChatSyncRules.order(Array(folded.values))
        if droppedLine {
            rewriteFile()
        }
    }

    private func appendLine(_ record: SyncedChatRecord) {
        guard let url = storeFileURL,
              var line = try? Self.lineEncoder.encode(record)
        else { return }
        line.append(0x0A)
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: line)
        } else {
            try? line.write(to: url, options: [])
        }
    }

    private func appendLine(_ tombstone: SyncedChatTombstone) {
        guard let url = storeFileURL,
              var line = try? Self.lineEncoder.encode(tombstone)
        else { return }
        line.append(0x0A)
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: line)
        } else {
            try? line.write(to: url, options: [])
        }
    }

    /// Rewrite the store file from memory — the physical
    /// half of deletion. Every held message in canonical
    /// order, then every tombstone in its deterministic
    /// order, written to a sibling temp file and swapped in
    /// atomically (the proposals store's pattern, and the
    /// core migration's). A conflict pair's losing copy is
    /// not regenerated: phone-side losers are diagnostic
    /// only — the core archives them durably — and a rewrite
    /// happens only on the deletion path, where shedding a
    /// duplicate line is no loss.
    private func rewriteFile() {
        guard let url = storeFileURL else { return }
        var data = Data()
        for record in ChatSyncRules.order(Array(byId.values)) {
            guard var line = try? Self.lineEncoder.encode(record) else { continue }
            line.append(0x0A)
            data.append(line)
        }
        for tombstone in allTombstones {
            guard var line = try? Self.lineEncoder.encode(tombstone) else { continue }
            line.append(0x0A)
            data.append(line)
        }
        let tmp = url.appendingPathExtension("tmp")
        do {
            try data.write(to: tmp, options: [])
            if FileManager.default.fileExists(atPath: url.path) {
                _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
            } else {
                try FileManager.default.moveItem(at: tmp, to: url)
            }
        } catch {
            try? FileManager.default.removeItem(at: tmp)
        }
    }
}

// MARK: - Wire conversion (GUSClient's sync shapes)

extension SyncedChatRecord {
    init(wire: ChatSyncMessage) {
        self.init(
            id: wire.id,
            deviceId: wire.deviceId,
            seq: wire.seq,
            prevId: wire.prevId,
            ts: wire.ts,
            direction: wire.direction,
            text: wire.text,
            photos: wire.photos)
    }

    var wire: ChatSyncMessage {
        ChatSyncMessage(
            id: id, deviceId: deviceId, seq: seq, prevId: prevId,
            ts: ts, direction: direction, text: text, photos: photos)
    }
}

extension SyncedChatTombstone {
    init(wire: ChatSyncTombstone) {
        self.init(
            id: wire.id,
            deviceId: wire.deviceId,
            seq: wire.seq,
            prevId: wire.prevId,
            ts: wire.ts,
            targetId: wire.targetId)
    }

    var wire: ChatSyncTombstone {
        ChatSyncTombstone(
            id: id, deviceId: deviceId, seq: seq, prevId: prevId,
            ts: ts, targetId: targetId)
    }
}
