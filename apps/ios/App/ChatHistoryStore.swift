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
}

// MARK: - The store

final class ChatHistoryStore {
    /// This phone's sync device ID — minted once, kept in
    /// UserDefaults (an identity, not a secret).
    let deviceId: String

    /// Every record held, in canonical causal order.
    private(set) var ordered: [SyncedChatRecord] = []
    private var byId: [String: SyncedChatRecord] = [:]
    private var nextSeq: Int
    /// Divergent copies seen this session (diagnostic only —
    /// the core archives the losers durably).
    private(set) var conflictCount = 0

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
        nextSeq = (ordered.filter { $0.deviceId == deviceId }.map(\.seq).max() ?? 0) + 1
    }

    var allIds: [String] { Array(byId.keys) }

    func record(id: String) -> SyncedChatRecord? { byId[id] }

    func messages(forIds ids: [String]) -> [SyncedChatRecord] {
        ids.compactMap { byId[$0] }
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
        return record
    }

    /// Fold records in from a sync exchange. Returns the newly
    /// added records in canonical order (arrivals the view
    /// hasn't shown) and the number of divergent copies met.
    /// A winning incoming copy is filed too (the filed loser
    /// stays — the fold resolves the pair on every load).
    func ingest(_ incoming: [SyncedChatRecord]) -> (added: [SyncedChatRecord], conflicts: Int) {
        var added: [SyncedChatRecord] = []
        var conflicts = 0
        var viewChanged = false
        for raw in incoming {
            guard let record = SyncedChatRecord.validated(raw) else { continue }
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
        if !added.isEmpty || viewChanged {
            ordered = ChatSyncRules.order(Array(byId.values))
        }
        let addedIds = Set(added.map(\.id))
        return (ordered.filter { addedIds.contains($0.id) }, conflicts)
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
        for line in text.split(separator: "\n") {
            guard let record = try? decoder.decode(
                SyncedChatRecord.self, from: Data(line.utf8)),
                let valid = SyncedChatRecord.validated(record)
            else { continue }
            if ChatSyncRules.fold(valid, into: &folded) != nil {
                conflictCount += 1
            }
        }
        byId = folded
        ordered = ChatSyncRules.order(Array(folded.values))
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
