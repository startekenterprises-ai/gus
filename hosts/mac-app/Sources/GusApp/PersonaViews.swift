import SwiftUI

// Persona surfaces on the Mac (v0.43.0): the picker
// strip, the Identity tab's persona block (voice card +
// memory door), and the per-persona Memory page — the
// Mac's parity with the iPhone's Personas tab, in the
// Mac app's own layout language. Everything here reads
// and writes through DesktopModel (the pick, the voice
// application) and MacPersonaMemoryStore (the buckets) —
// no second source of truth, the rule the iPhone's
// picker states for itself.

/// A persona's portrait, round-cropped to the face
/// window the iPhone's PersonaFace carries (the crop
/// fractions assume the square bundled portraits, as
/// they do on the iPhone). A portrait that failed to
/// load falls back to the app's own avatar image rather
/// than an empty circle.
struct PersonaAvatarView: View {
    let starter: MacPersonaStarter
    var side: CGFloat = 44

    var body: some View {
        Group {
            if let image = MacPersonaAvatars.image(for: starter) {
                let face = starter.face
                let scaled = side / face.cropSide
                Image(nsImage: image)
                    .resizable()
                    .frame(width: scaled, height: scaled)
                    .offset(
                        x: (0.5 - (face.cropOriginX + face.cropSide / 2)) * scaled,
                        y: (0.5 - (face.cropOriginY + face.cropSide / 2)) * scaled
                    )
                    .frame(width: side, height: side)
                    .clipped()
            } else {
                Image(nsImage: DesktopModel.fallbackAvatarImage
                      ?? NSApplication.shared.applicationIconImage)
                    .resizable()
                    .frame(width: side, height: side)
            }
        }
        .clipShape(Circle())
    }
}

/// The persona picker (v0.43.0): a horizontal strip of
/// faces — General first (the app's own avatar; no
/// persona), then the six starters — name underneath,
/// the selected face ringed and a touch larger, exactly
/// the iPhone picker's shape. One component, two hosts:
/// the Chat top bar (compact) and the Identity tab's
/// persona block (full, with the active persona's blurb
/// under the strip). A pick lands through
/// DesktopModel.pickPersona: prompt, voice, and — in a
/// call — the session's persona context all move in the
/// same beat, and the next turn carries the pick.
struct PersonaStripView: View {
    @ObservedObject var model: DesktopModel
    var compact = false

    private var faceSide: CGFloat { compact ? 34 : 44 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 10) {
                    generalCell
                    ForEach(MacPersona.personaStarters) { starter in
                        starterCell(starter)
                    }
                }
                .padding(.vertical, 2)
                .padding(.horizontal, 2)
            }
            if !compact {
                Text(activeLine)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
            }
        }
    }

    /// Who is on, in one line under the strip: the
    /// starter's name and blurb, or General's standing.
    private var activeLine: String {
        if let starter = model.activePersona {
            return "\(starter.name) — \(starter.blurb)"
        }
        return "General — the all-purpose GUS, no persona. Pick a face to give this Mac's conversations a persona."
    }

    private var generalCell: some View {
        cell(
            selected: model.activePersona == nil,
            name: "General",
            help: "General — no persona: GUS as himself, with the voice chosen in Settings → Voice."
        ) {
            model.pickPersona(nil)
        } face: {
            Image(nsImage: model.displayAvatarImage)
                .resizable()
                .frame(width: faceSide, height: faceSide)
                .clipShape(Circle())
        }
    }

    private func starterCell(_ starter: MacPersonaStarter) -> some View {
        cell(
            selected: model.activePersona?.id == starter.id,
            name: starter.name,
            help: "\(starter.name) — \(starter.blurb)"
        ) {
            model.pickPersona(starter)
        } face: {
            PersonaAvatarView(starter: starter, side: faceSide)
        }
    }

    private func cell<Face: View>(
        selected: Bool,
        name: String,
        help: String,
        action: @escaping () -> Void,
        @ViewBuilder face: () -> Face
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                face()
                    .overlay(
                        Circle().stroke(
                            selected ? Color.accentColor : Color.clear,
                            lineWidth: 2
                        )
                    )
                    .scaleEffect(selected ? 1.08 : 1.0)
                Text(name)
                    .font(.caption2)
                    .fontWeight(selected ? .semibold : .regular)
                    .foregroundColor(selected ? .primary : .secondary)
                    .lineLimit(1)
                    .frame(width: 58)
            }
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(name)
    }
}

/// The Identity tab's persona block (v0.43.0): the
/// picker, the active persona's voice card, and the
/// memory door. The voice card is where a persona's
/// voice is reassigned and auditioned on the Mac — the
/// iPhone's Personas-tab voice card, at sidebar width:
/// a picker over the eight-voice catalog (the pick is
/// the persona's assignment, persisted per persona; the
/// active persona's pick also writes voice.json through
/// the same full-body save Settings → Voice makes), a
/// reset to the shipped voice when an override exists,
/// and a Preview that speaks the persona's own line in
/// its voice through the Kokoro speech engine — no call
/// needed. Previews are a Kokoro feature: with Built-in
/// (AVSpeech) speech selected the button says so in the
/// notice rather than faking a Kokoro voice with a Mac
/// system voice.
struct PersonaBlockView: View {
    @ObservedObject var model: DesktopModel
    @ObservedObject private var memoryStore = MacPersonaMemoryStore.shared
    @State private var memoryPresented = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Persona")
                .font(.headline)
            PersonaStripView(model: model)
            if let starter = model.activePersona {
                voiceCard(starter)
            } else {
                Text("General speaks with the voice chosen in Settings → Voice — picking a persona applies that persona's own voice there.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            memoryRow
        }
        .sheet(isPresented: $memoryPresented, onDismiss: {
            // A memory write made while a call runs posts
            // the recomposed context to the live session —
            // the next turn of the call carries it, the
            // same landing a pick gets.
            model.syncVoiceSessionPersonaContext()
        }) {
            MacPersonaMemoryView(
                personaID: model.activePersonaBucketID,
                personaName: model.activePersonaDisplayName
            )
        }
    }

    private func voiceCard(_ starter: MacPersonaStarter) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("\(starter.name)'s voice")
                    .font(.callout)
                Picker("", selection: voiceSelection(starter)) {
                    ForEach(MacKokoroVoices.all) { voice in
                        Text(voice.displayName).tag(voice.id)
                    }
                }
                .frame(maxWidth: 220)
                .help("The Kokoro voice \(starter.name) speaks with on this Mac — saved per persona, and applied to the spoken voice now, since \(starter.name) is the persona on.")
            }
            HStack(spacing: 8) {
                Button("Preview voice") { model.previewPersonaVoice(starter) }
                    .help("Hear \(starter.name)'s line in this voice, through the Kokoro speech engine — no call needed. While a call is open the preview waits, rather than talking over it.")
                if MacPersonaVoiceAssignment.voiceID(forPersona: starter.id) != nil {
                    Button("Use shipped voice") { model.setPersonaVoice(nil, for: starter) }
                        .help("Forget your assignment — \(starter.name) goes back to the voice it shipped with (\(MacKokoroVoices.displayName(for: starter.voiceID))).")
                }
            }
            .controlSize(.small)
            Text("Voice previews speak through the Kokoro engine chosen in Settings → Voice (Built-in Kokoro or your endpoint). The pick takes effect for the next spoken sentence.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    /// The voice picker's binding: the persona's
    /// assignment-or-default, written through the model
    /// (which persists it and, for the persona on,
    /// applies it to voice.json in the same beat).
    private func voiceSelection(_ starter: MacPersonaStarter) -> Binding<String> {
        Binding(
            get: { starter.assignedVoiceID },
            set: { model.setPersonaVoice($0, for: starter) }
        )
    }

    /// The memory door: whose bucket, how many lines,
    /// and the page itself — for the persona on, or for
    /// General when no persona is picked (General has a
    /// bucket of its own, as on the iPhone).
    private var memoryRow: some View {
        HStack(spacing: 8) {
            Text("\(model.activePersonaDisplayName)'s memory")
                .font(.callout)
            Text("\(memoryStore.lines(for: model.activePersonaBucketID).count) lines")
                .font(.caption)
                .foregroundColor(.secondary)
            Button("Memory…") { memoryPresented = true }
                .controlSize(.small)
                .help("Open \(model.activePersonaDisplayName)'s memory page — the lines this persona carries into conversations on this Mac, yours to read, add to, edit, and forget.")
        }
    }
}

/// One persona's memory page on the Mac (v0.43.0) — the
/// iPhone Memory page's discipline at sheet size: the
/// whole bucket, readable and curable, with add-by-
/// typing, edit, forget-one, and forget-all behind a
/// confirm. The copy carries the facts that define the
/// feature here: the lines live on THIS Mac only — they
/// do not sync with the iPhone's bucket for the same
/// persona (each device keeps its own, as the iPhone's
/// live only on the iPhone) — and they are not chat
/// history, so nothing else in the app deletes them.
struct MacPersonaMemoryView: View {
    let personaID: String
    let personaName: String

    @ObservedObject private var store = MacPersonaMemoryStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var newLine = ""
    @State private var editingIndex: Int?
    @State private var editingText = ""
    @State private var confirmDeleteAll = false

    private var lines: [String] { store.lines(for: personaID) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(personaName)'s memory")
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
            }
            Text("These lines are background \(personaName) carries into every chat and call from this Mac — part of \(personaName)'s prompt, on this Mac only. They aren't chat history, nothing joins this list on its own, and they never sync: the iPhone's memory for \(personaName) is its own, kept there.")
                .font(.callout)
                .foregroundColor(.secondary)
            Divider()
            if lines.isEmpty {
                Text("Nothing remembered yet. Add the first line below — a name, a preference, anything \(personaName) should carry into the next conversation.")
                    .font(.callout)
                    .foregroundColor(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                            lineRow(index: index, line: line)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            Divider()
            HStack(spacing: 8) {
                TextField("Something for \(personaName) to remember…", text: $newLine)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { addLine() }
                Button("Remember") { addLine() }
                    .disabled(newLine.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if !lines.isEmpty {
                HStack {
                    Spacer()
                    Button("Forget everything", role: .destructive) { confirmDeleteAll = true }
                        .controlSize(.small)
                }
            }
        }
        .padding(14)
        .frame(width: 460, height: 480)
        .confirmationDialog(
            "Forget everything \(personaName) remembers on this Mac?",
            isPresented: $confirmDeleteAll,
            titleVisibility: .visible
        ) {
            Button("Forget everything", role: .destructive) {
                store.removeAll(for: personaID)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every line goes, and \(personaName)'s next conversation starts clean. This is the only place these lines can be deleted — and deleting them can't be undone.")
        }
    }

    private func lineRow(index: Int, line: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            if editingIndex == index {
                TextField("", text: $editingText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { saveEdit(index: index) }
                Button("Save") { saveEdit(index: index) }
                    .controlSize(.small)
                Button("Cancel") { editingIndex = nil }
                    .controlSize(.small)
            } else {
                Text(line)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Edit") {
                    editingIndex = index
                    editingText = line
                }
                .controlSize(.small)
                Button("Forget") { store.remove(at: index, from: personaID) }
                    .controlSize(.small)
            }
        }
    }

    private func addLine() {
        store.add(newLine, to: personaID)
        newLine = ""
    }

    private func saveEdit(index: Int) {
        store.update(at: index, in: personaID, with: editingText)
        editingIndex = nil
    }
}
