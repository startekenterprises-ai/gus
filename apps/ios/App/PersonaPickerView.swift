import SwiftUI

/// The persona picker (v0.30.0) — one view, three hosts: the
/// sheet behind the avatar tap (Chat's header, the call
/// screen's face) and the Personas tab. It reads and writes
/// the SAME single source of truth Settings uses —
/// LocalBrain.personaStarters for the shelf and
/// LocalBrain.customPrompt for the pick — so no prompt
/// string exists in a second place, and a pick made here is
/// the pick Settings' editor shows (and vice versa).
///
/// "General" clears the key: the general-purpose assistant,
/// no persona. A prompt the operator edited in Settings
/// matches no starter; the picker says so with a Custom row
/// rather than pretending a starter is selected. The
/// precedence is LocalBrain.activePrompt's and is untouched
/// here: the Gmail demo pitch (Settings → Call mode) wins
/// over any persona while it's on, and any pick lands when
/// the brain next loads — the next app start, as Settings
/// has always said.
///
/// The switcher changes the persona PROMPT only. Per-persona
/// avatar faces are a separate, pending item — the face on
/// the call screen stays the stock avatar (gus.avatar.stock)
/// whichever persona is picked.
struct PersonaPickerView: View {
    /// Sheet hosts set this so a pick closes the sheet; the
    /// tab host leaves it off and the pick just lands.
    var dismissOnSelect = false
    @Environment(\.dismiss) private var dismiss
    @State private var currentPrompt: String? = LocalBrain.customPrompt

    /// A saved prompt that no starter matches — the
    /// operator's own edited words from Settings.
    private var currentIsCustom: Bool {
        guard let currentPrompt else { return false }
        return !LocalBrain.personaStarters.contains { $0.prompt == currentPrompt }
    }

    var body: some View {
        List {
            Section {
                row(name: "General",
                    blurb: "The general-purpose assistant — no persona.",
                    selected: currentPrompt == nil) {
                    choose(nil)
                }
                ForEach(LocalBrain.personaStarters) { starter in
                    row(name: starter.name,
                        blurb: starter.blurb,
                        selected: currentPrompt == starter.prompt) {
                        choose(starter.prompt)
                    }
                }
                if currentIsCustom {
                    row(name: "Custom",
                        blurb: "Your own words — edit them in Settings → Persona starters.",
                        selected: true) {}
                }
            } footer: {
                Text("The persona is the prompt the on-device brain loads with, so a change lands the next time the app starts. While the Gmail demo pitch is on (Settings → Call mode), it wins over any persona. Making a starter's words your own still happens in Settings — nothing here is locked.")
            }
        }
        .onAppear { currentPrompt = LocalBrain.customPrompt }
    }

    private func choose(_ prompt: String?) {
        LocalBrain.customPrompt = prompt
        currentPrompt = LocalBrain.customPrompt
        if dismissOnSelect { dismiss() }
    }

    private func row(name: String, blurb: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .foregroundColor(.primary)
                    Text(blurb)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundColor(.accentColor)
                }
            }
            .contentShape(Rectangle())
        }
    }
}

/// The sheet form of the picker, hosted by the avatar tap
/// in Chat's header and on the call screen: the picker in a
/// navigation stack with a Done button of its own (a pick
/// also dismisses, via dismissOnSelect).
struct PersonaPickerSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PersonaPickerView(dismissOnSelect: true)
                .navigationTitle("Personas")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}

/// The stock avatar as a small round chip — the face Chat's
/// header wears (v0.30.0), and the tap target for the
/// persona picker. It frames the face with the SAME window
/// fractions AvatarFaceView (the call screen) measured from
/// the portraits — boy: origin (0.14, 0.193), side 0.72;
/// girl: origin (0.225, 0.215), side 0.55 — so the chip and
/// the call-screen face are the same face, not two crops.
/// The pick is gus.avatar.stock, the key Settings and the
/// Mac keep; anything but "girl" is the boy, the default.
struct AvatarThumbnailView: View {
    @AppStorage("gus.avatar.stock") private var stockAvatar = "boy"
    var side: CGFloat = 30

    private var isGirl: Bool { stockAvatar == "girl" }
    private var cropOriginX: CGFloat { isGirl ? 0.225 : 0.14 }
    private var cropOriginY: CGFloat { isGirl ? 0.215 : 0.193 }
    private var cropSide: CGFloat { isGirl ? 0.55 : 0.72 }

    var body: some View {
        GeometryReader { geo in
            let s = geo.size.width
            let rendered = s / cropSide
            Image(isGirl ? "AvatarGirl" : "Avatar")
                .resizable()
                .frame(width: rendered, height: rendered)
                .offset(x: -cropOriginX * rendered, y: -cropOriginY * rendered)
        }
        .frame(width: side, height: side)
        .clipShape(Circle())
    }
}
