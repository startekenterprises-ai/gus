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
    @AppStorage("gus.avatar.stock") private var stockAvatar = "boy"
    @State private var currentPrompt: String? = LocalBrain.customPrompt
    /// A paired brain the picked persona wants that isn't
    /// on the phone yet — drives the download card.
    @State private var downloadOffer: ModelDownloadEntry?
    /// One plain line after a brain switch, so the switch
    /// is said out loud instead of happening silently.
    @State private var switchNote: String?

    /// A saved prompt that no starter matches — the
    /// operator's own edited words from Settings.
    private var currentIsCustom: Bool {
        guard let currentPrompt else { return false }
        return !LocalBrain.personaStarters.contains { $0.prompt == currentPrompt }
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
                if let offer = downloadOffer {
                    downloadCard(offer)
                }
                if let switchNote {
                    Text(switchNote)
                        .font(.callout)
                        .foregroundColor(.secondary)
                }
                Text("A pick is a package: the persona's words, its voice, and its face change together, and they land right away — the brain reloads in this same app run with your next message or call. While the Gmail demo pitch is on (Settings → Call mode), it wins over any persona. Making a starter's words your own still happens in Settings — nothing here is locked.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding(16)
        }
        .onAppear { currentPrompt = LocalBrain.customPrompt }
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
                         selected: currentPrompt == starter.prompt) {
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
        LocalBrain.customPrompt = starter?.prompt
        currentPrompt = LocalBrain.customPrompt
        switchNote = nil
        downloadOffer = nil
        if let starter {
            // The persona's voice comes with it — the same
            // persisted pick Settings' voice picker reads,
            // so the two never disagree about who speaks.
            if let voice = KokoroVoice.all.first(where: { $0.id == starter.voiceID }) {
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
/// avatar is this view, large.
struct ActivePersonaAvatarView: View {
    @AppStorage("gus.avatar.stock") private var stockAvatar = "boy"
    var side: CGFloat = 30

    var body: some View {
        PersonaAvatarView(
            face: PersonaFace.current(stockGirl: stockAvatar == "girl"),
            side: side)
    }
}
