import Combine
import Foundation

/// Persona customization (v0.44.0) — the operator's own
/// hand on the shelf: edits to the shipped starters, and
/// personas of their own invention.
///
/// Two stores live here, both on this iPhone only:
///
/// STARTER EDITS are overrides. A starter's shipped words
/// stay in LocalBrain.personaStarters exactly as shipped
/// (the Mac's roster is pinned to those literals — they
/// are a published text, not a suggestion box), and the
/// operator's edit is kept beside them under
/// gus.personaPromptOverride.<id>. Composition and picks
/// use the EFFECTIVE prompt — the override when one is
/// saved, the shipped words otherwise — and "Reset to
/// shipped" is just deleting the override. An edit never
/// rewrites the starter's identity: name, face, voice
/// defaults, and (for the Devil) the paired brain all
/// follow the persona, edited words or not.
///
/// CREATED PERSONAS are records: a name, a prompt, a
/// voice, and a face chosen from the portraits already on
/// the phone. They persist as Codable JSON under
/// gus.personas.custom (the library's own persistence
/// habit, PersonaMemoryStore's and CustomBrainStore's)
/// with ids of the shape custom-<uuid>. The store vends
/// them as PersonaStarter values, so everything that
/// speaks of a persona — the picker, the call screen,
/// debate, memory buckets, voice assignments — treats a
/// created persona exactly like a shipped one, because in
/// every way that matters it is one.
///
/// Personas are CONFIGURATION, not chat content (the same
/// standing voice assignments have): creating and editing
/// them works identically while incognito is on, and
/// nothing here reads IncognitoMode. A created persona's
/// prompt is the operator's own text on their own device;
/// when the persona is picked, its words ride
/// personaContext to the core under the same discipline
/// as a starter's (v0.40.0: transport and memory only,
/// never logged, never persisted core-side).

/// The shipped starters' saved edits, one defaults key
/// per starter id. Plain storage, read at composition
/// time — an override write therefore lands the same way
/// a pick does: the composed prompt changes, and the
/// holders' staleness check reloads the brain between
/// turns, in-process.
enum PersonaPromptOverrides {
    static func key(for personaID: String) -> String {
        "gus.personaPromptOverride.\(personaID)"
    }

    /// The saved edit for a persona, or nil when the
    /// persona speaks with its shipped (or created) words.
    static func prompt(for personaID: String) -> String? {
        let raw = UserDefaults.standard.string(forKey: key(for: personaID))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? nil : raw
    }

    /// Save an edit. An empty value clears instead — an
    /// emptied edit is a reset, never a persona with no
    /// words.
    static func setPrompt(_ prompt: String?, for personaID: String) {
        if let prompt, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            UserDefaults.standard.set(prompt, forKey: key(for: personaID))
        } else {
            UserDefaults.standard.removeObject(forKey: key(for: personaID))
        }
    }
}

/// One created persona, as saved. The face is named, not
/// framed: the framing (crop, mouth) belongs to the
/// portrait (PersonaFace), and the record only says which
/// portrait it wears — resolved through PersonaFaceCatalog
/// every time it is vended, so a portrait's measured
/// framing improves for every persona wearing it at once.
struct CustomPersona: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var prompt: String
    var voiceID: String
    var faceImageName: String
}

/// The faces a created persona may wear (v0.44.0): the
/// portraits already on the phone — the stock pair plus
/// every starter's own portrait, deduped by image (Gus
/// wears the stock boy, so he contributes no second copy).
/// No uploads: a face is borrowed livery in this build,
/// never new art.
enum PersonaFaceCatalog {
    static var choices: [PersonaFace] {
        var seen = Set<String>()
        var faces: [PersonaFace] = []
        for face in [PersonaFace.boy, PersonaFace.girl]
            + LocalBrain.personaStarters.map(\.face) {
            if seen.insert(face.imageName).inserted {
                faces.append(face)
            }
        }
        return faces
    }

    /// The face a record's image name means; a name the
    /// catalog no longer carries falls back to the stock
    /// boy rather than a blank.
    static func face(forImageName name: String) -> PersonaFace {
        choices.first { $0.imageName == name } ?? .boy
    }

    /// The picker's word for a face: the name of the
    /// persona who wears it on the shipped shelf, or the
    /// stock words for the pair nobody owns.
    static func label(for face: PersonaFace) -> String {
        if face.imageName == PersonaFace.boy.imageName { return "Boy" }
        if face.imageName == PersonaFace.girl.imageName { return "Girl" }
        return LocalBrain.personaStarters
            .first { $0.face.imageName == face.imageName }?.name ?? "Portrait"
    }
}

/// The created personas, kept. One ObservableObject
/// singleton in PersonaMemoryStore's shape: a
/// lock-guarded store (composition can resolve the shelf
/// off the main actor, on a call's behalf) with a
/// published mirror the picker and the debate menus
/// observe, so a create, an edit, or a delete lands on
/// every surface in the same beat.
final class CustomPersonaStore: ObservableObject {
    static let shared = CustomPersonaStore()

    static let defaultsKey = "gus.personas.custom"

    @Published private(set) var personas: [CustomPersona] = []

    private let lock = NSLock()
    private var storage: [CustomPersona] = []

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
           let decoded = try? JSONDecoder().decode([CustomPersona].self, from: data) {
            storage = decoded
            personas = decoded
        }
    }

    private func persist() {
        if storage.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.defaultsKey)
        } else if let data = try? JSONEncoder().encode(storage) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
    }

    private func mutate(_ change: (inout [CustomPersona]) -> Void) {
        lock.lock()
        change(&storage)
        persist()
        let snapshot = storage
        lock.unlock()
        let apply = { self.personas = snapshot }
        if Thread.isMainThread {
            apply()
        } else {
            DispatchQueue.main.async(execute: apply)
        }
    }

    // MARK: - Reading

    /// Every record, in the order they were made — the
    /// order the picker shows them in.
    func all() -> [CustomPersona] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func record(id: String) -> CustomPersona? {
        all().first { $0.id == id }
    }

    /// The records as shelf cells: a created persona IS a
    /// PersonaStarter to every consumer — its own words,
    /// its own voice (the record's voice is its base;
    /// PersonaVoiceAssignment overlays it exactly as it
    /// overlays a shipped voice), no paired brain, and
    /// the borrowed face resolved from the catalog.
    var starters: [PersonaStarter] {
        all().map { record in
            PersonaStarter(
                id: record.id,
                name: record.name,
                blurb: "Your own persona.",
                prompt: record.prompt,
                voiceID: record.voiceID,
                pairedBrainID: nil,
                face: PersonaFaceCatalog.face(forImageName: record.faceImageName))
        }
    }

    // MARK: - Writing

    /// Create a persona. The id is minted here — custom-
    /// plus a UUID — so a created persona's memory bucket
    /// and voice assignment can never collide with a
    /// shipped id or with each other. Name and words are
    /// stored trimmed: identity is a text match against
    /// the stored pick (LocalBrain.activeStarter), and
    /// the pick's own store trims on read — a record kept
    /// untrimmed would never match its own pick.
    @discardableResult
    func create(name: String, prompt: String, voiceID: String,
                faceImageName: String) -> CustomPersona {
        let record = CustomPersona(
            id: "custom-" + UUID().uuidString.lowercased(),
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
            voiceID: voiceID,
            faceImageName: faceImageName)
        mutate { $0.append(record) }
        return record
    }

    /// Save an edit to a created persona, in place — the
    /// id (and with it the memory bucket and the voice
    /// assignment) survives the edit untouched. Words are
    /// trimmed on the way in, for the same match reason
    /// as create.
    func update(_ record: CustomPersona) {
        var record = record
        record.name = record.name.trimmingCharacters(in: .whitespacesAndNewlines)
        record.prompt = record.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        mutate {
            guard let index = $0.firstIndex(where: { $0.id == record.id }) else { return }
            $0[index] = record
        }
    }

    /// Delete a created persona — and what was ITS OWN
    /// goes with it: its memory bucket is forgotten and
    /// its voice assignment cleared, so no orphaned state
    /// outlives the persona it belonged to. (Falling back
    /// when the deleted persona was the one picked is the
    /// editor's act, beside the confirm that asked.)
    func delete(id: String) {
        mutate { $0.removeAll { $0.id == id } }
        PersonaMemoryStore.shared.removeAll(for: id)
        PersonaVoiceAssignment.setVoiceID(nil, forPersona: id)
    }
}
