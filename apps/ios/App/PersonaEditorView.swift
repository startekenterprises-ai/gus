import SwiftUI

/// What the persona editor is open on (v0.44.0): a
/// shipped starter (edit its words), a created persona
/// (edit everything), or a blank page (create one).
enum PersonaEditorTarget: Identifiable {
    case new
    case starter(PersonaStarter)
    case custom(CustomPersona)

    var id: String {
        switch self {
        case .new: return "new"
        case .starter(let starter): return "starter-\(starter.id)"
        case .custom(let record): return "custom-\(record.id)"
        }
    }
}

/// The persona editor (v0.44.0) — one sheet, three jobs,
/// reached from the Personas tab's "Make it yours" card.
///
/// A STARTER's edit is its words only: the prompt field
/// opens on the persona's effective words (its saved edit
/// when one stands, else the shipped words), Save keeps
/// the edit as an override (PersonaPromptOverrides), and
/// Reset to shipped removes it. The starter's name, face,
/// and voice are its shipped identity and are not edited
/// here — the voice has its own card on the Personas tab.
/// Saving the shipped words verbatim IS a reset: no
/// override is kept for text that changes nothing.
///
/// A CREATED persona is edited whole: name, words, voice,
/// and face. Its voice folds the way a starter's does —
/// the record carries a base voice (set at creation) and
/// the Personas tab's card overlays an assignment; the
/// editor opens on the effective voice and Save folds the
/// pick into the record and clears the overlay, so the
/// voice heard after saving is the voice picked here.
///
/// Saving while the persona is the one picked refreshes
/// the pick to the new words in the same beat — identity
/// is the prompt text (LocalBrain.activeStarter), so an
/// edit that didn't refresh it would quietly unpick the
/// persona into the anonymous Custom state.
///
/// Deleting a created persona sits behind a confirm that
/// says the hard part out loud: its saved memories are
/// deleted with it (CustomPersonaStore.delete forgets
/// the bucket and clears the voice assignment). Deleting
/// the persona that is on falls back to General.
struct PersonaEditorView: View {
    let target: PersonaEditorTarget

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var customStore = CustomPersonaStore.shared
    @ObservedObject private var preview = VoicePreviewPlayer.shared

    @State private var name: String
    @State private var promptText: String
    @State private var voiceID: String
    @State private var faceImageName: String
    @State private var confirmDelete = false

    /// The seed a new persona's words open with: a working
    /// skeleton in the house shape (spoken, short, plain)
    /// with one bracketed place to say who this persona
    /// is. It is a beginning, not a form — kept verbatim
    /// it is still a valid, if unfinished, persona.
    static let newPersonaTemplate = """
        You are GUS playing a character of the person's own invention, \
        speaking out loud in a live phone call: one to three short \
        sentences, plain everyday words, no lists, no markdown, no code. \
        [Write who this persona is here: their character, what they know, \
        how they speak, and how they treat the person.] Stay in character, \
        be warm, and say plainly when you don't know something instead of \
        inventing it. Keep answers short; the person can always ask \
        for more.
        """

    init(target: PersonaEditorTarget) {
        self.target = target
        switch target {
        case .new:
            _name = State(initialValue: "")
            _promptText = State(initialValue: Self.newPersonaTemplate)
            _voiceID = State(initialValue: "am_michael")
            _faceImageName = State(initialValue: PersonaFace.boy.imageName)
        case .starter(let starter):
            _name = State(initialValue: starter.name)
            _promptText = State(initialValue: starter.effectivePrompt)
            _voiceID = State(initialValue: starter.assignedVoiceID)
            _faceImageName = State(initialValue: starter.face.imageName)
        case .custom(let record):
            _name = State(initialValue: record.name)
            _promptText = State(initialValue: record.prompt)
            // The editor opens on the persona's EFFECTIVE
            // voice — its assignment when one stands, else
            // its base — so an unrelated edit never changes
            // what the persona sounds like (see save()).
            _voiceID = State(initialValue:
                PersonaVoiceAssignment.voiceID(forPersona: record.id) ?? record.voiceID)
            _faceImageName = State(initialValue: record.faceImageName)
        }
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedPrompt: String {
        promptText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSave: Bool {
        guard !trimmedPrompt.isEmpty else { return false }
        switch target {
        case .starter: return true
        case .new, .custom: return !trimmedName.isEmpty
        }
    }

    private var title: String {
        switch target {
        case .new: return "New persona"
        case .starter(let starter): return "Edit \(starter.name)"
        case .custom(let record): return "Edit \(record.name)"
        }
    }

    /// The line the editor's voice rows audition: the
    /// persona's own preview line for a starter; for a
    /// created persona, its name in a plain sentence.
    private var previewLine: String {
        switch target {
        case .starter(let starter): return starter.previewLine
        case .new, .custom:
            return "Hi, I'm \(trimmedName.isEmpty ? "your new persona" : trimmedName). This is my voice."
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    switch target {
                    case .starter(let starter):
                        starterHeader(starter)
                    case .new, .custom:
                        identityFields
                    }
                    wordsField
                    switch target {
                    case .starter(let starter):
                        starterReset(starter)
                    case .new, .custom:
                        voicePicker
                    }
                    if case .custom(let record) = target {
                        deleteSection(record)
                    }
                    if let error = preview.lastError {
                        Text(error)
                            .font(.caption)
                            .foregroundColor(.orange)
                    }
                }
                .padding(16)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(!canSave)
                }
            }
        }
    }

    // MARK: - Sections

    private func starterHeader(_ starter: PersonaStarter) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                PersonaAvatarView(face: starter.face, side: 56)
                VStack(alignment: .leading, spacing: 2) {
                    Text(starter.name)
                        .font(.headline)
                    Text(starter.blurb)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            Text(starter.hasPromptOverride
                 ? "These are your saved words for \(starter.name). The shipped words are still underneath — Reset brings them back. The name, face, and voice stay \(starter.name)'s own; the voice is changed in the card on the Personas tab."
                 : "These are \(starter.name)'s shipped words. Saving makes them yours — your edit is what's used, and the shipped words stay underneath, one Reset away.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private var identityFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField("Name", text: $name)
                .font(.headline)
                .textInputAutocapitalization(.words)
            Text("Face — a portrait already on this iPhone; a created persona borrows one.")
                .font(.caption)
                .foregroundColor(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(PersonaFaceCatalog.choices, id: \.imageName) { face in
                        Button {
                            faceImageName = face.imageName
                        } label: {
                            VStack(spacing: 4) {
                                ZStack {
                                    if faceImageName == face.imageName {
                                        Circle()
                                            .stroke(Color.accentColor, lineWidth: 3)
                                            .frame(width: 64, height: 64)
                                    }
                                    PersonaAvatarView(face: face, side: 58)
                                }
                                .frame(width: 68, height: 68)
                                Text(PersonaFaceCatalog.label(for: face))
                                    .font(.caption2)
                                    .foregroundColor(
                                        faceImageName == face.imageName ? .primary : .secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(PersonaFaceCatalog.label(for: face))
                        .accessibilityAddTraits(
                            faceImageName == face.imageName ? [.isSelected] : [])
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private var wordsField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Its words — the prompt this persona thinks with")
                .font(.callout)
                .fontWeight(.semibold)
            TextEditor(text: $promptText)
                .frame(minHeight: 180)
                .padding(6)
                .background(Color.secondary.opacity(0.08))
                .cornerRadius(10)
        }
    }

    private func starterReset(_ starter: PersonaStarter) -> some View {
        Group {
            if starter.hasPromptOverride {
                Button("Reset to shipped words", role: .destructive) {
                    let wasActive = LocalBrain.customPrompt == starter.effectivePrompt
                    PersonaPromptOverrides.setPrompt(nil, for: starter.id)
                    promptText = starter.prompt
                    if wasActive {
                        LocalBrain.customPrompt = starter.prompt
                    }
                }
                .font(.callout)
            }
        }
    }

    private var voicePicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Voice")
                .font(.callout)
                .fontWeight(.semibold)
            Text("Tap the play button to hear a voice say the persona's line before you choose it.")
                .font(.caption)
                .foregroundColor(.secondary)
            ForEach(KokoroVoice.all) { voice in
                VoiceChoiceRow(
                    voice: voice,
                    selected: voiceID == voice.id,
                    previewLine: previewLine
                ) {
                    voiceID = voice.id
                }
            }
        }
    }

    private func deleteSection(_ record: CustomPersona) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Button("Delete \(record.name)", role: .destructive) {
                confirmDelete = true
            }
            .font(.callout)
        }
        .confirmationDialog(
            "Delete \(record.name)?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button("Delete \(record.name)", role: .destructive) {
                delete(record)
            }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("The persona goes, and its saved memories are deleted with it — they can't be brought back.")
        }
    }

    // MARK: - Saving

    private func save() {
        switch target {
        case .starter(let starter):
            let wasActive = LocalBrain.customPrompt == starter.effectivePrompt
            if trimmedPrompt == starter.prompt {
                // Saving the shipped words verbatim is a
                // reset — no override is kept for text
                // that changes nothing.
                PersonaPromptOverrides.setPrompt(nil, for: starter.id)
            } else {
                PersonaPromptOverrides.setPrompt(promptText, for: starter.id)
            }
            if wasActive {
                LocalBrain.customPrompt = starter.effectivePrompt
            }
        case .new:
            let record = customStore.create(
                name: trimmedName, prompt: promptText,
                voiceID: voiceID, faceImageName: faceImageName)
            // A new persona is picked the moment it
            // exists — the package lands together: words,
            // voice, face (the picker's choose, in
            // miniature; created personas pair no brain).
            LocalBrain.customPrompt = record.prompt
            if let voice = KokoroVoice.all.first(where: { $0.id == record.voiceID }) {
                KokoroVoice.selected = voice
            }
        case .custom(let record):
            let wasActive = LocalBrain.activeStarter?.id == record.id
            var updated = record
            updated.name = trimmedName
            updated.prompt = promptText
            updated.faceImageName = faceImageName
            updated.voiceID = voiceID
            customStore.update(updated)
            // The editor's voice pick folds into the
            // record and the assignment overlay clears —
            // the voice picked here is the voice the
            // persona has, with nothing standing over it.
            PersonaVoiceAssignment.setVoiceID(nil, forPersona: record.id)
            if wasActive {
                LocalBrain.customPrompt = updated.prompt
                if let voice = KokoroVoice.all.first(where: { $0.id == voiceID }) {
                    KokoroVoice.selected = voice
                }
            }
        }
        dismiss()
    }

    private func delete(_ record: CustomPersona) {
        let wasActive = LocalBrain.activeStarter?.id == record.id
        customStore.delete(id: record.id)
        // Deleting the persona that is on falls back to
        // General — the pick is cleared, never left
        // pointing at words nobody owns anymore.
        if wasActive {
            LocalBrain.customPrompt = nil
        }
        dismiss()
    }
}
