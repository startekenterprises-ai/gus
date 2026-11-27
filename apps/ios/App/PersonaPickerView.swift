import SwiftUI

/// The persona picker (v0.30.0; redesigned v0.31.0) — one
/// view, three hosts: the sheet behind the avatar tap
/// (Chat's top-center face, the call screen's face) and the
/// Personas tab. It reads and writes the SAME single source
/// of truth Settings uses — LocalBrain.personaStarters for
/// the shelf and LocalBrain.customPrompt for the pick — so
/// no prompt string exists in a second place, and a pick
/// made here is the pick Settings' editor shows (and vice
/// versa).
///
/// v0.44.0: the shelf carries the operator's own created
/// personas after the shipped six (CustomPersonaStore),
/// picks write a persona's EFFECTIVE words (its saved
/// edit when one stands), and the card at the bottom is
/// the customization door — edit a starter's words, or
/// create, edit, and delete personas of their own
/// (PersonaEditorView).
///
/// v0.31.0: the picker is a horizontal strip of FACES —
/// each persona wears its own portrait now, name underneath,
/// no blurbs; the selected face is ringed and a touch
/// larger. And a pick is a package: the persona's prompt,
/// its VOICE (gus.voice.kokoroVoice, the key Settings'
/// voice picker reads), and — for the Devil — its BRAIN.
/// Picking the Devil when the Most open brain is already on
/// the phone switches brains in-process (holders reload at
/// the next turn or call; no app restart); when it isn't,
/// the card below the strip offers the download, and the
/// switch happens on its own when the download lands if
/// the Devil is still picked. The persona applies either
/// way.
///
/// "General" clears the key: the general-purpose assistant,
/// no persona, wearing the stock face. A prompt the
/// operator edited in Settings matches no starter; the
/// picker says so with a Custom cell rather than
/// pretending a starter is selected. The precedence is
/// LocalBrain.activePrompt's and is untouched here: the
/// Gmail demo pitch (Settings → Call mode) wins over any
/// persona while it's on.
struct PersonaPickerView: View {
    /// Sheet hosts set this so a pick closes the sheet; the
    /// tab host leaves it off and the pick just lands.
    var dismissOnSelect = false
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var library = ModelLibrary.shared
    /// v0.32.0: the pick is observed, not snapshotted. This
    /// view used to copy LocalBrain.customPrompt into @State
    /// on appear — its own cells stayed right, but every
    /// OTHER surface kept its stale copy. The picker now
    /// reads the same observable the headers and the call
    /// screen read, so one pick moves every highlight, face,
    /// and name in the same beat.
    @ObservedObject private var selection = PersonaSelection.shared
    /// The voice audition's state (v0.33.0) — observed so
    /// the voice card's error line lands when a preview
    /// fails, not on some later redraw.
    @ObservedObject private var preview = VoicePreviewPlayer.shared
    /// The persona memory store (v0.39.0) — observed so
    /// the memory card's count moves the beat a line is
    /// remembered or forgotten, wherever it happened.
    @ObservedObject private var memoryStore = PersonaMemoryStore.shared
    /// The created personas (v0.44.0) — observed so a
    /// create, an edit, or a delete in the editor below
    /// moves the strip and the management rows in the
    /// same beat.
    @ObservedObject private var customStore = CustomPersonaStore.shared
    /// The editor's current target (v0.44.0): a starter
    /// to edit, a created persona to edit, or a new one
    /// to make. Presented as a sheet over the picker.
    @State private var editorTarget: PersonaEditorTarget?
    @AppStorage("gus.avatar.stock") private var stockAvatar = "boy"

    /// The stored pick, mirrored live by PersonaSelection.
    private var currentPrompt: String? { selection.prompt }
    /// A paired brain the picked persona wants that isn't
    /// on the phone yet — drives the download card.
    @State private var downloadOffer: ModelDownloadEntry?
    /// One plain line after a brain switch, so the switch
    /// is said out loud instead of happening silently.
    @State private var switchNote: String?
    /// The voice card's current voice for the persona on
    /// (v0.33.0) — a mirror of its assignment-or-default,
    /// refreshed when the pick changes and when a row is
    /// tapped, since the assignment store is defaults, not
    /// observable state.
    @State private var cardVoiceID: String?

    /// A saved prompt that no persona on the shelf
    /// matches — the operator's own hand-edited words
    /// from Settings. (A CREATED persona is on the shelf
    /// and matches by its own words, so this state is
    /// only ever the anonymous edit — the cell below
    /// keeps its "Custom" name for it.)
    private var currentIsCustom: Bool {
        guard let currentPrompt else { return false }
        return !LocalBrain.allPersonas.contains { $0.effectivePrompt == currentPrompt }
    }

    /// The stock face — what General wears (and what a
    /// custom prompt wears): the girl only when Settings'
    /// stock pick says so, the boy otherwise.
    private var stockFace: PersonaFace {
        stockAvatar == "girl" ? .girl : .boy
    }

    /// The download card's brain state, for the auto-switch
    /// watch below.
    private var pendingDownloadState: ModelLibrary.EntryState? {
        guard let offer = downloadOffer else { return nil }
        return library.state(of: offer)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                strip
                if let starter = LocalBrain.activeStarter {
                    voiceCard(starter)
                }
                memoryCard
                if let offer = downloadOffer {
                    downloadCard(offer)
                }
                if let switchNote {
                    Text(switchNote)
                        .font(.callout)
                        .foregroundColor(.secondary)
                }
                manageCard
                Text("A pick is a package: the persona's words, its voice, its face, and its memory change together, and they land right away — the brain reloads in this same app run with your next message or call. While the Gmail demo pitch is on (Settings → Call mode), it wins over any persona. A persona's voice can be changed in the card above (the Personas tab is its home — a pick made from the avatar sheet closes the sheet first): tap the play button to hear a voice say the persona's line before you choose it.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding(16)
        }
        .sheet(item: $editorTarget) { target in
            PersonaEditorView(target: target)
        }
        .onAppear {
            cardVoiceID = LocalBrain.activeStarter?.assignedVoiceID
        }
        .onChange(of: selection.prompt) { _ in
            cardVoiceID = LocalBrain.activeStarter?.assignedVoiceID
        }
        // The offered download landed: if the persona that
        // wanted this brain is still picked, switch to it
        // on our own — the operator shouldn't have to come
        // back and tap anything (Glenn's brain-switch
        // friction, 2026-11-27).
        .onChange(of: pendingDownloadState) { state in
            if state == .ready { finishPendingDownload() }
        }
    }

    // MARK: - The strip

    private var strip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 14) {
                cell(name: "General", face: stockFace,
                     selected: currentPrompt == nil) {
                    choose(nil)
                }
                ForEach(LocalBrain.personaStarters) { starter in
                    cell(name: starter.name, face: starter.face,
                         selected: currentPrompt == starter.effectivePrompt) {
                        choose(starter)
                    }
                }
                // The operator's own (v0.44.0): created
                // personas ride the same strip, right
                // after the shipped shelf — same cells,
                // same pick, same package.
                ForEach(customStore.starters) { starter in
                    cell(name: starter.name, face: starter.face,
                         selected: currentPrompt == starter.effectivePrompt) {
                        choose(starter)
                    }
                }
                if currentIsCustom {
                    cell(name: "Custom", face: stockFace, selected: true) {}
                }
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 4)
        }
    }

    private func cell(name: String, face: PersonaFace, selected: Bool,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                ZStack {
                    if selected {
                        Circle()
                            .stroke(Color.accentColor, lineWidth: 3)
                            .frame(width: 72, height: 72)
                    }
                    PersonaAvatarView(face: face, side: 64)
                }
                .frame(width: 76, height: 76)
                .scaleEffect(selected ? 1.05 : 1.0)
                Text(name)
                    .font(.caption)
                    .fontWeight(selected ? .semibold : .regular)
                    .foregroundColor(selected ? .primary : .secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .frame(width: 76)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    // MARK: - Picking

    private func choose(_ starter: PersonaStarter?) {
        // The write publishes through PersonaSelection (the
        // setter's job since v0.32.0), so this view's
        // highlight — and every other surface's face and
        // name — moves with the pick, no local copy to sync.
        // The words written are the persona's EFFECTIVE
        // words (v0.44.0) — an edited starter is picked by
        // its edit, so the pick and the identity match in
        // LocalBrain.activeStarter read the same text.
        LocalBrain.customPrompt = starter?.effectivePrompt
        switchNote = nil
        downloadOffer = nil
        if let starter {
            // The persona's voice comes with it — the
            // operator's own assignment when one is saved
            // (v0.33.0), else the persona's shipped voice —
            // written to the same persisted pick Settings'
            // voice picker reads, so the two never disagree
            // about who speaks.
            if let voice = KokoroVoice.all.first(where: { $0.id == starter.assignedVoiceID }) {
                KokoroVoice.selected = voice
            }
            pairBrain(for: starter)
        }
        // A sheet pick normally closes the sheet — but a
        // pick that raised the download card keeps it open:
        // the card IS the next step of that pick, and
        // dismissing would hide the Download button the
        // operator is being offered.
        if dismissOnSelect && downloadOffer == nil { dismiss() }
    }

    /// The brain half of a pick (v0.31.0): a starter may
    /// declare the brain it works best with (only the
    /// Devil does — the Most open brain). Already running
    /// on it: nothing to do. On the phone: switch, in
    /// process. Not on the phone: offer the download; the
    /// persona applies either way.
    private func pairBrain(for starter: PersonaStarter) {
        guard let pairedID = starter.pairedBrainID,
              let entry = GUSModelManifest.entry(id: pairedID) else { return }
        if ActiveBrain.resolved()?.id == pairedID { return }
        if ModelStore.isPresent(entry) {
            library.useBrain(entry)
            switchNote = "Switched to the \(entry.plainName) — \(starter.name)'s own brain. It loads with your next message or call; no restart needed."
        } else {
            downloadOffer = entry
        }
    }

    private func finishPendingDownload() {
        guard let entry = downloadOffer else { return }
        downloadOffer = nil
        // Switch only if the persona that wanted this
        // brain is still the one picked — a download that
        // lands after the operator moved on changes
        // nothing under them.
        guard LocalBrain.activeStarter?.pairedBrainID == entry.id else { return }
        library.useBrain(entry)
        switchNote = "The \(entry.plainName) is ready — switched to it. It loads with your next message or call."
    }

    // MARK: - The voice card

    /// The persona-on's voice card (v0.33.0): every catalog
    /// voice as a row — tap to make it this persona's (the
    /// assignment persists per persona, and because this
    /// persona is the one on, the live voice pick follows),
    /// tap the play button to hear that voice say the
    /// persona's own line first. A reset row appears only
    /// while an assignment exists, returning the persona to
    /// its shipped voice.
    private func voiceCard(_ starter: PersonaStarter) -> some View {
        let current = cardVoiceID ?? starter.assignedVoiceID
        return VStack(alignment: .leading, spacing: 8) {
            Text("Voice for \(starter.name)")
                .font(.callout)
                .fontWeight(.semibold)
            Text("Hear a voice before you choose it — the play button speaks \(starter.name)'s line in that voice. A first listen may take a moment while the voice is fetched.")
                .font(.caption)
                .foregroundColor(.secondary)
            ForEach(KokoroVoice.all) { voice in
                VoiceChoiceRow(
                    voice: voice,
                    selected: current == voice.id,
                    previewLine: starter.previewLine
                ) {
                    PersonaVoiceAssignment.setVoiceID(voice.id, forPersona: starter.id)
                    cardVoiceID = voice.id
                    KokoroVoice.selected = voice
                }
            }
            if PersonaVoiceAssignment.voiceID(forPersona: starter.id) != nil {
                Button("Back to \(starter.name)'s shipped voice") {
                    PersonaVoiceAssignment.setVoiceID(nil, forPersona: starter.id)
                    cardVoiceID = starter.voiceID
                    if let shipped = KokoroVoice.all.first(where: { $0.id == starter.voiceID }) {
                        KokoroVoice.selected = shipped
                    }
                }
                .font(.callout)
            }
            if let error = preview.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.orange)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08))
        .cornerRadius(12)
    }

    // MARK: - The memory card

    /// Whose memory the card below opens: the id is
    /// LocalBrain.activeMemoryPersonaID — the one
    /// derivation injection and Remember also use — and
    /// the name is the picker's own word for that state
    /// (the general bucket's owner is "General" here,
    /// though the same state answers to Gus in a chat).
    private var memoryBucket: (id: String, name: String) {
        let id = LocalBrain.activeMemoryPersonaID
        if let starter = LocalBrain.activeStarter { return (id, starter.name) }
        return (id, id == "general" ? "General" : "Custom")
    }

    /// The memory door (v0.39.0): one card for whoever is
    /// on, naming their bucket and its size, opening the
    /// page where the lines are kept and cured. Memory is
    /// per persona, so its home is beside the voice card —
    /// the other half of what makes this persona this
    /// persona — and the pick decides whose memory this
    /// is, exactly as it decides whose voice is above.
    private var memoryCard: some View {
        let bucket = memoryBucket
        let count = memoryStore.lines(for: bucket.id).count
        return VStack(alignment: .leading, spacing: 8) {
            Text("Memory for \(bucket.name)")
                .font(.callout)
                .fontWeight(.semibold)
            Text(count == 0
                 ? "Nothing remembered yet — \(bucket.name) starts every conversation fresh. Save one of your messages with Remember, or add lines on the memory page."
                 : "\(count) \(count == 1 ? "thing" : "things") remembered — background \(bucket.name) carries into every chat and call, on this iPhone only.")
                .font(.caption)
                .foregroundColor(.secondary)
            NavigationLink {
                PersonaMemoryView(personaID: bucket.id, personaName: bucket.name)
            } label: {
                Label("Open \(bucket.name)'s memory", systemImage: "brain.head.profile")
                    .font(.callout)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08))
        .cornerRadius(12)
    }

    // MARK: - The make-it-yours card

    /// The customization door (v0.44.0): every starter's
    /// words can be edited (the edit is an override — the
    /// shipped words stay shipped, and Reset removes the
    /// edit), and personas of the operator's own can be
    /// created, edited, and deleted. The editor is one
    /// sheet (PersonaEditorView) with three targets; this
    /// card is just its index — a row per persona, an
    /// "Edited" marker where an override stands, and the
    /// New persona button at the top.
    private var manageCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Make it yours")
                .font(.callout)
                .fontWeight(.semibold)
            Text("Edit a starter's words — your edit replaces them until you reset it — or create a persona of your own: a name, its words, a voice, and a face from the portraits already here. Your personas live on this iPhone only.")
                .font(.caption)
                .foregroundColor(.secondary)
            Button {
                editorTarget = .new
            } label: {
                Label("New persona", systemImage: "plus.circle")
                    .font(.callout)
            }
            ForEach(LocalBrain.personaStarters) { starter in
                manageRow(name: starter.name,
                          edited: starter.hasPromptOverride) {
                    editorTarget = .starter(starter)
                }
            }
            ForEach(customStore.personas) { record in
                manageRow(name: record.name, edited: false) {
                    editorTarget = .custom(record)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08))
        .cornerRadius(12)
    }

    private func manageRow(name: String, edited: Bool,
                           action: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Text(name)
                .font(.callout)
            if edited {
                Text("Edited")
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.15))
                    .cornerRadius(6)
            }
            Spacer()
            Button("Edit", action: action)
                .font(.callout)
        }
    }

    // MARK: - The download card

    private func downloadCard(_ entry: ModelDownloadEntry) -> some View {
        let personaName = LocalBrain.activeStarter?.name ?? "This persona"
        return VStack(alignment: .leading, spacing: 8) {
            Text("\(personaName) works best with the \(entry.plainName).")
                .font(.callout)
                .fontWeight(.semibold)
            switch library.state(of: entry) {
            case .ready:
                Text("Ready — switching now…")
                    .font(.callout)
                    .foregroundColor(.secondary)
            case .downloading(let fraction):
                ProgressView(value: fraction) {
                    Text("Downloading… \(Int(fraction * 100))% — it switches on its own when it lands.")
                        .font(.caption)
                }
            case .verifying:
                ProgressView() { Text("Checking it over…").font(.caption) }
            case .failed(let message):
                Text(message)
                    .font(.callout)
                    .foregroundColor(.orange)
                HStack(spacing: 10) {
                    Button("Try again") { library.download(entry) }
                        .buttonStyle(.borderedProminent)
                    Button("Not now") { downloadOffer = nil }
                        .buttonStyle(.bordered)
                }
            case .notDownloaded:
                Text("It isn't on this iPhone yet — a \(entry.sizeText) download, once. \(personaName) still applies with the current brain if you'd rather not.")
                    .font(.callout)
                    .foregroundColor(.secondary)
                HStack(spacing: 10) {
                    Button("Download it now") { library.download(entry) }
                        .buttonStyle(.borderedProminent)
                    Button("Not now") { downloadOffer = nil }
                        .buttonStyle(.bordered)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08))
        .cornerRadius(12)
    }
}

/// The sheet form of the picker, hosted by the avatar tap
/// in Chat and on the call screen: the picker in a
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

/// One persona's portrait as a round chip: the shipped
/// square art, framed by the face's own measured window
/// (PersonaFace) so every surface shows the same crop of
/// the same face — the picker strip, Chat's top-center
/// avatar, the debate labels, the call screen.
struct PersonaAvatarView: View {
    let face: PersonaFace
    var side: CGFloat = 64

    var body: some View {
        GeometryReader { geo in
            let s = geo.size.width
            let rendered = s / CGFloat(face.cropSide)
            Image(face.imageName)
                .resizable()
                .frame(width: rendered, height: rendered)
                .offset(x: -CGFloat(face.cropOriginX) * rendered,
                        y: -CGFloat(face.cropOriginY) * rendered)
        }
        .frame(width: side, height: side)
        .clipShape(Circle())
    }
}

/// The face the app wears right now — the active persona's
/// own portrait, or the stock pick when no starter is on
/// (PersonaFace.current holds the rule). Chat's top-center
/// avatar is this view, large. v0.32.0: it observes
/// PersonaSelection, so the face changes in the same beat
/// as the pick — through v0.31.0 it only re-derived when
/// some unrelated state redrew the host.
struct ActivePersonaAvatarView: View {
    @ObservedObject private var selection = PersonaSelection.shared
    @AppStorage("gus.avatar.stock") private var stockAvatar = "boy"
    var side: CGFloat = 30

    var body: some View {
        PersonaAvatarView(
            face: PersonaFace.current(stockGirl: stockAvatar == "girl"),
            side: side)
    }
}

/// One voice's row in a chooser list (v0.33.0) — Settings'
/// voice lists and the Personas tab's voice card share it:
/// the name, a check when this voice is the current pick,
/// and the audition button. Tapping the row CHOOSES the
/// voice; the play button never chooses anything — hearing
/// and picking are separate acts, so a voice can be
/// auditioned without disturbing the one in use.
struct VoiceChoiceRow: View {
    let voice: KokoroVoice
    let selected: Bool
    let previewLine: String
    let onSelect: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onSelect) {
                HStack {
                    Text(voice.displayName)
                        .foregroundColor(.primary)
                    Spacer()
                    if selected {
                        Image(systemName: "checkmark")
                            .foregroundColor(.accentColor)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            VoicePreviewButton(voice: voice, line: previewLine)
        }
    }
}

/// The audition button (v0.33.0): speaks a few words in
/// this voice, on the spot (VoicePreviewPlayer) — tap
/// again to stop it. While a call is live the button is
/// not offered at all: a preview must never reach into a
/// call, so the control simply isn't there (and the
/// player refuses besides).
struct VoicePreviewButton: View {
    let voice: KokoroVoice
    let line: String
    @ObservedObject private var preview = VoicePreviewPlayer.shared

    var body: some View {
        if !CallSession.isAnyCallLive {
            Button {
                preview.toggle(voice: voice, line: line)
            } label: {
                if preview.activeVoiceID == voice.id {
                    if preview.isPreparing {
                        ProgressView()
                    } else {
                        Image(systemName: "stop.circle.fill")
                            .font(.title3)
                    }
                } else {
                    Image(systemName: "play.circle")
                        .font(.title3)
                }
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(
                preview.activeVoiceID == voice.id
                    ? "Stop the preview"
                    : "Hear \(voice.shortName)")
        }
    }
}
