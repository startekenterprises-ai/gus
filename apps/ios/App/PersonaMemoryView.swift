import SwiftUI

/// One persona's memory page (v0.39.0) — the whole bucket,
/// readable and curable: every line the persona carries,
/// with add-by-typing, edit, forget-one, and forget-all.
///
/// Reached from the Personas tab's memory card, which
/// names the bucket for whoever is picked (a starter,
/// General, or Custom) — this page is keyed by that same
/// persona id, so the page the operator reads is the
/// bucket the prompt is composed from.
///
/// The copy carries the two facts that define the feature:
/// memories are NOT chat history (Settings → Privacy's
/// delete-all leaves them standing; this page is the only
/// place they are deleted), and they never sync — they
/// live on this iPhone, and the only place they travel is
/// into this persona's prompt on this phone.
///
/// Incognito locks the page's writing hand, not its eyes:
/// while incognito is on, every mutating control is
/// disabled and the reason is shown — incognito never
/// writes anything down — while the list stays readable,
/// exactly as the persona still reads it mid-conversation.
struct PersonaMemoryView: View {
    let personaID: String
    let personaName: String

    @ObservedObject private var store = PersonaMemoryStore.shared
    @ObservedObject private var incognitoMode = IncognitoMode.shared
    @State private var newLine = ""
    @State private var editingIndex: Int?
    @State private var editingText = ""
    @State private var confirmDeleteAll = false

    private var lines: [String] { store.lines(for: personaID) }
    private var locked: Bool { incognitoMode.isOn }

    var body: some View {
        List {
            Section {
                Text("These lines are background \(personaName) carries into every chat and call — part of \(personaName)'s prompt, on this iPhone only. They aren't chat history: deleting your chat history doesn't touch them, they never sync to your Mac, and nothing joins this list on its own — only what you save here or with Remember in a chat.")
                    .font(.callout)
                    .foregroundColor(.secondary)
            }
            if locked {
                Section {
                    Text("Incognito is on, so nothing here can be added or changed — incognito never writes anything down. You can still read the list, and \(personaName) still uses it while you talk.")
                        .font(.callout)
                        .foregroundColor(.orange)
                }
            }
            Section("Remembered") {
                if lines.isEmpty {
                    Text("Nothing yet. Add a line below, or long-press one of your own messages in a chat and tap Remember for \(personaName).")
                        .foregroundColor(.secondary)
                }
                ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                    if editingIndex == index {
                        editorRow(index: index)
                    } else {
                        lineRow(index: index, line: line)
                    }
                }
            }
            Section("Add") {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Something for \(personaName) to remember…",
                              text: $newLine, axis: .vertical)
                        .disabled(locked)
                    Button("Add") { addLine() }
                        .disabled(locked || newLine.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if !lines.isEmpty {
                Section {
                    Button("Forget everything here", role: .destructive) {
                        confirmDeleteAll = true
                    }
                    .disabled(locked)
                }
            }
        }
        .navigationTitle("\(personaName)'s memory")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Forget everything \(personaName) remembers?",
            isPresented: $confirmDeleteAll,
            titleVisibility: .visible
        ) {
            Button("Forget everything", role: .destructive) {
                store.removeAll(for: personaID)
            }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("Every line in this list goes, for good. Your chat history is separate and isn't touched.")
        }
    }

    /// One saved line. A tap starts editing it (unless
    /// incognito has locked the page); the swipe carries
    /// Edit and Forget. While incognito is on there are no
    /// swipe actions at all — the page offers no write it
    /// would then refuse.
    @ViewBuilder
    private func lineRow(index: Int, line: String) -> some View {
        Text(line)
            .contentShape(Rectangle())
            .onTapGesture {
                if !locked {
                    editingIndex = index
                    editingText = line
                }
            }
            .swipeActions(edge: .trailing) {
                if !locked {
                    Button("Forget", role: .destructive) {
                        store.remove(at: index, from: personaID)
                    }
                    Button("Edit") {
                        editingIndex = index
                        editingText = line
                    }
                    .tint(.accentColor)
                }
            }
    }

    /// The inline editor for one line: Save writes through
    /// the store (which refuses an emptied line — forgetting
    /// is the swipe's act, not an edit's accident), Cancel
    /// leaves the line exactly as it was.
    private func editorRow(index: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Memory", text: $editingText, axis: .vertical)
            HStack(spacing: 12) {
                Button("Save") {
                    store.update(at: index, in: personaID, with: editingText)
                    editingIndex = nil
                }
                .disabled(editingText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Cancel", role: .cancel) { editingIndex = nil }
            }
            .font(.callout)
        }
    }

    private func addLine() {
        store.add(newLine, to: personaID)
        newLine = ""
    }
}
