import Combine
import Foundation

/// Per-persona memory (v0.39.0) — what a persona has been
/// asked to remember, kept on this iPhone and nowhere else.
///
/// Each persona keeps a bucket: an ordered list of short
/// lines the operator chose to save (oldest first, newest
/// last). A line gets in only two ways, both deliberate —
/// the Remember action on one of the operator's own chat
/// messages, or typing it on the persona's Memory page.
/// There is NO automatic extraction: GUS never decides on
/// its own that something was worth remembering, so what a
/// persona "knows" about the person is exactly what the
/// person can read, edit, and delete on that page.
///
/// Where the lines go: into that persona's composed prompt
/// (LocalBrain.composedPrompt, personaID:) as a background
/// block — on-device chat, on-device calls, and debate
/// passes, each debater carrying only its OWN bucket. The
/// lines never enter chat history, never ride chat sync,
/// never appear in a log or a Shield receipt, and are not
/// touched by Settings → Privacy's delete-all (that delete
/// is chat history; curated memory is deleted here, on the
/// Memory page, by its owner).
///
/// Buckets are keyed by persona identity: every starter id
/// on the shelf, plus "general" (no persona picked) and
/// "custom" (the operator's own edited prompt, which
/// matches no starter) — LocalBrain.activeMemoryPersonaID
/// makes that derivation in one place.
///
/// Incognito reads but never writes: composition still
/// injects the active bucket during an incognito
/// conversation (reading is not writing — the conversation
/// itself stays unstored), while every write door in this
/// store's callers closes — the Remember action is not
/// offered and the Memory page's controls are disabled.
final class PersonaMemoryStore: ObservableObject {
    static let shared = PersonaMemoryStore()

    /// The whole store under one defaults key: a JSON
    /// object from persona id to its ordered lines — the
    /// library's own persistence habit (CustomBrainStore),
    /// deliberately separate from the chat store and from
    /// the download records.
    static let defaultsKey = "gus.personaMemory"

    /// The injection caps: at most this many lines ride a
    /// prompt, and the framed block (header + lines) stays
    /// within this many characters. Most-recent lines win
    /// when a bucket outgrows the caps; a line is included
    /// whole or not at all — never truncated mid-way. The
    /// caps bound PROMPT size only: the bucket itself keeps
    /// everything the operator saved, and the Memory page
    /// shows all of it.
    static let maxLines = 20
    static let maxBlockCharacters = 1500

    @Published private(set) var buckets: [String: [String]] = [:]

    /// Composition can be asked for off the main actor (a
    /// brain loading on a call's behalf), so the dictionary
    /// itself is lock-guarded; the published mirror is
    /// updated on the main queue, the PersonaSelection
    /// pattern.
    private let lock = NSLock()
    private var storage: [String: [String]] = [:]

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
           let decoded = try? JSONDecoder().decode([String: [String]].self, from: data) {
            storage = decoded
            buckets = decoded
        }
    }

    private func persist() {
        if storage.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.defaultsKey)
        } else if let data = try? JSONEncoder().encode(storage) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
    }

    /// One mutation, applied under the lock, persisted,
    /// and mirrored to the published buckets on the main
    /// queue so the pages that show counts and lines move
    /// in the same beat as the write.
    private func mutate(_ change: (inout [String: [String]]) -> Void) {
        lock.lock()
        change(&storage)
        persist()
        let snapshot = storage
        lock.unlock()
        let apply = { self.buckets = snapshot }
        if Thread.isMainThread {
            apply()
        } else {
            DispatchQueue.main.async(execute: apply)
        }
    }

    // MARK: - Reading

    /// One bucket's lines, oldest first — the order the
    /// Memory page shows and the order the block keeps.
    func lines(for personaID: String) -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage[personaID] ?? []
    }

    // MARK: - Writing

    /// Append a line to a bucket. Whitespace-only text is
    /// refused — a memory is words, not a blank.
    func add(_ line: String, to personaID: String) {
        let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        mutate { $0[personaID, default: []].append(text) }
    }

    /// Replace one line in place. An edit that empties the
    /// line is refused (deleting is its own act, below), so
    /// a stray save can never silently drop a memory.
    func update(at index: Int, in personaID: String, with text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        mutate {
            guard var lines = $0[personaID], lines.indices.contains(index) else { return }
            lines[index] = trimmed
            $0[personaID] = lines
        }
    }

    /// Forget one line.
    func remove(at index: Int, from personaID: String) {
        mutate {
            guard var lines = $0[personaID], lines.indices.contains(index) else { return }
            lines.remove(at: index)
            $0[personaID] = lines.isEmpty ? nil : lines
        }
    }

    /// Forget the whole bucket — the Memory page's
    /// delete-all, behind its own confirm. Nothing else in
    /// the app can do this: chat-history deletion is a
    /// different store and leaves curated memory standing.
    func removeAll(for personaID: String) {
        mutate { $0[personaID] = nil }
    }

    // MARK: - The prompt block

    /// The block this bucket adds to its persona's composed
    /// prompt, or nil when the bucket is empty — an empty
    /// bucket changes nothing, and the composed prompt is
    /// byte-identical to the pre-memory composition.
    func memoryBlock(for personaID: String) -> String? {
        Self.block(lines: lines(for: personaID))
    }

    /// Frame lines as background: a header that tells the
    /// persona what these are and how to hold them (use
    /// them naturally; never recite the list), then the
    /// lines themselves. Selection walks newest first and
    /// takes whole lines while both caps allow — a line
    /// that cannot fit whole is skipped, never cut — then
    /// the chosen lines are restored to their saved order.
    static func block(lines: [String]) -> String? {
        guard !lines.isEmpty else { return nil }
        let header = "Things the person asked you to remember — background for this conversation: use it naturally when it fits, and never read the list out or recite it back."
        var chosen: [String] = []
        var length = header.count
        for line in lines.reversed() {
            if chosen.count >= maxLines { break }
            // Each line rides as "\n- " + the line itself.
            let cost = line.count + 3
            if length + cost > maxBlockCharacters { continue }
            chosen.append(line)
            length += cost
        }
        guard !chosen.isEmpty else { return nil }
        return header + chosen.reversed().map { "\n- \($0)" }.joined()
    }
}
