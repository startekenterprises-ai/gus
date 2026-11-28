import SwiftUI
import AVKit
import AVFoundation
import ReplayKit
import UIKit

/// The front door: a live call with GUS. Tap Call and talk —
/// full-duplex, with barge-in; there is deliberately no
/// push-to-talk anywhere in this app (Glenn's ruling,
/// 2026-11-19: dead air while holding a button is where a
/// demo dies). While the call runs, the screen shows what GUS
/// is doing — listening, thinking, speaking — and the running
/// transcript of the conversation.
///
/// v0.23.0 (Glenn's demo feedback, 2026-11-26): the
/// transcript is a real panel now — labeled, auto-scrolling,
/// your words landing as you speak and GUS's as he speaks
/// them — with a composer under it for typing mid-call, and
/// a cleaned-up control row whose states read at a glance:
/// a filled circle means the thing is ON.
///
/// v0.29.0: no longer a tab — Chat presents this screen as
/// a full-screen cover from its header phone button. The
/// screen itself is the same; only the way out changed:
/// Done (shown whenever no call is live) leaves without
/// calling, and End hangs up AND dismisses back to Chat.
///
/// v0.30.0: the cover STARTS the call — Chat's phone button
/// is the only door in, and tapping it means "call", so
/// autoStart connects on appear (Muse's one-tap shape;
/// Glenn, 2026-11-27) instead of landing on an idle screen
/// that asks for a second tap. The in-screen Call button
/// stays for one job: re-calling after a call has ended
/// while the cover is still up. The avatar is a button now
/// too — tapping the face opens the persona picker.
struct CallView: View {
    /// Set by the presenting door: true means connect the
    /// moment this screen appears. Only Chat's cover passes
    /// true today; the default keeps the screen's old
    /// idle-first behavior for any future host.
    let autoStart: Bool
    @Environment(\.dismiss) private var dismiss
    @StateObject private var call = CallSession()
    /// The persona pick, observed (v0.32.0): the name under
    /// the face and the face itself derive from LocalBrain
    /// at render time; this is what makes a mid-visit
    /// carousel pick land on this screen the moment the
    /// sheet closes — through v0.31.0 the pick only showed
    /// once the call's own state happened to redraw things,
    /// and no name was shown here at all (Glenn, 2026-11-27).
    @ObservedObject private var personaSelection = PersonaSelection.shared
    @State private var didAutoStart = false
    @State private var showPersonaPicker = false
    /// v0.36.0: the system camera sheet for the in-call
    /// camera button — presented only after the permission
    /// gate in openCamera() says the way is clear.
    @State private var showCamera = false

    init(autoStart: Bool = false) {
        self.autoStart = autoStart
    }
    /// The mid-call composer's draft (v0.23.0). Local view
    /// state only — a sent message goes through
    /// CallSession.sendTypedMessage, the spoken final's own
    /// doors; nothing typed is stored anywhere else.
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    private var inCall: Bool { call.phase == .live || call.phase == .connecting }

    private var statusText: String {
        switch call.phase {
        case .idle: return "Tap Call to talk to GUS."
        case .connecting: return "Connecting…"
        case .ended: return "Call ended."
        case .live:
            switch call.corePhase {
            case "listening": return "Listening…"
            case "thinking": return "Thinking…"
            case "speaking": return "GUS is speaking — just talk over him to interrupt."
            default: return "On call."
            }
        }
    }

    var body: some View {
        NavigationStack {
            callContent
            .padding(20)
            .navigationTitle("Call")
            .navigationBarTitleDisplayMode(.inline)
            // The way out (v0.29.0): this screen is a
            // full-screen cover now, not a tab — there is no
            // tab bar to clear or hide (the v0.17.4 clearance
            // padding and the v0.16.0 tab-bar hiding went
            // with the tab). While no call is live, Done
            // dismisses back to Chat; during a call the End
            // control is the way out and dismisses itself.
            .toolbar {
                if !inCall {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }
                    }
                }
            }
            // One tap means call (v0.30.0): the cover
            // connects on appear when the door asked it to.
            // didAutoStart keeps a later re-appear (the
            // persona sheet closing, say) from re-dialing a
            // call the operator already ended.
            .onAppear {
                if autoStart && !didAutoStart {
                    didAutoStart = true
                    call.startCall()
                }
            }
            .sheet(isPresented: $showPersonaPicker) {
                PersonaPickerSheet()
            }
            // The in-call camera (v0.36.0): the SYSTEM
            // camera, full-screen, one photo per presentation
            // — the pragmatic v1 (no custom viewfinder, no
            // streaming). What comes back goes straight to
            // CallSession.sendPhotoTurn; a cancel is just a
            // dismissal, nothing recorded.
            .fullScreenCover(isPresented: $showCamera) {
                CallCameraPicker { image in
                    showCamera = false
                    if let image,
                       let raw = image.jpegData(compressionQuality: 0.9) {
                        call.sendPhotoTurn(rawImageData: raw)
                    }
                }
                .ignoresSafeArea()
            }
            // Shield quarantine (v0.15.7): a held turn waits
            // here for the operator's one-time decision. Send
            // anyway proceeds with THIS turn only — the scan's
            // receipt already stands in the Shield log.
            .alert("Shield held that", isPresented: Binding(
                get: { call.pendingShieldQuarantine != nil },
                set: { if !$0 { call.dropShieldQuarantine() } }
            ), presenting: call.pendingShieldQuarantine) { _ in
                Button("Send anyway") { call.overrideShieldQuarantine() }
                Button("Drop it", role: .cancel) { call.dropShieldQuarantine() }
            } message: { held in
                Text("What you said matched \(held.ruleID) — Shield quarantined it before GUS heard it. The scan is recorded in Settings → Security → Shield log.")
            }
        }
    }

    // MARK: - Body sections (v0.40.1)

    /// Why these exist: through v0.39.0, `body` above was
    /// one monolithic expression — a NavigationStack over
    /// a VStack holding the face/Watch section, the name
    /// and status lines, the transcript, the controls,
    /// and the composer — and the 0.39.0 archive failed
    /// at CallView.swift:85 with "the compiler is unable
    /// to type-check this expression in reasonable time".
    /// The sections below are that same view tree,
    /// factored at its natural seams so each expression
    /// type-checks on its own. Code motion only: no view,
    /// modifier, binding, or conditional changed.
    private var callContent: some View {
        VStack(spacing: 16) {
            headerSection

            statusBlock

            transcriptPanel

            inCallSection
        }
    }

    @ViewBuilder
    private var headerSection: some View {
        // The face is the persona door (v0.30.0):
        // tap it to switch personas mid-visit — the
        // pick writes the same key Settings writes
        // and lands when the brain next loads.
        // Watch mode (v0.37.0): while the camera is
        // on, the layout goes FaceTime-shaped — the
        // persona shrinks to a participant TILE and
        // the camera's tiles sit beside it, all on
        // screen at once; the persona is never
        // replaced by the camera. Off, the face is
        // the screen again.
        // Screen viewing (v0.45.0): screen sharing
        // takes the same FaceTime shape — the "Your
        // screen" tile joins the camera's tile beside
        // the persona, never replacing it.
        if call.watchOn || call.screenSharing {
            HStack(alignment: .top, spacing: 12) {
                personaFaceButton(side: 104)
                VStack(alignment: .leading, spacing: 8) {
                    if call.watchOn {
                        onAirPill
                        WatchPreviewHost(view: call.watchPreviewView)
                            .frame(maxWidth: .infinity)
                            .frame(height: 118)
                            .background(Color.black)
                            .cornerRadius(10)
                            .clipped()
                        watchControlsRow
                    }
                    if call.screenSharing {
                        screenSharingPill
                        screenTile
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .padding(.top, 12)
        } else {
            // Space discipline (v0.47.2): while a call is
            // live, the face steps down from the screen's
            // dominant visual to a participant's size —
            // the transcript below is the record of the
            // call and needs the room more (see
            // transcriptPanel's floor). Pre-call the face
            // keeps its full 232: there is nothing else
            // competing for the screen yet.
            personaFaceButton(side: inCall ? 150 : 232)
                .padding(.top, 12)
        }
    }

    @ViewBuilder
    private var statusBlock: some View {
        // Who you're talking to (v0.32.0): the
        // active persona's name under the face,
        // always on this screen — a call is the one
        // place the operator couldn't tell whose
        // voice they were hearing (Glenn, 2026-11-27).
        // The name is LocalBrain.activeDisplayName,
        // the one derivation every surface shares,
        // and it moves with the pick (see
        // personaSelection above).
        Text(LocalBrain.activeDisplayName)
            .font(.title3)
            .fontWeight(.semibold)
            .multilineTextAlignment(.center)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity)

        // Layout discipline (v0.17.0): every text on
        // this screen is width-flexible — it wraps or
        // shrinks inside the screen's margins, never
        // hard-clips at the edges. The 0.16 screens
        // let the status line and the button row lay
        // out wider than the phone and spill off both
        // sides; nothing here may size itself past
        // the container again.
        Text(statusText)
            .font(.headline)
            .multilineTextAlignment(.center)
            .lineLimit(3)
            .minimumScaleFactor(0.75)
            .frame(maxWidth: .infinity)
            .fixedSize(horizontal: false, vertical: true)

        Text(call.callMode == .onDevice
             ? "On-device — the brain and voice live on this iPhone."
             : "Core — this call's brain is your GUS core.")
            .font(.caption)
            .foregroundColor(.secondary)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity)
            .fixedSize(horizontal: false, vertical: true)

        // The four notices (speech / watch / screen /
        // error) are transient status, not reading
        // material: while a call is live each is capped
        // at 2 lines (v0.47.2) so a stack of them can't
        // crowd the transcript off the screen; pre-call
        // they keep 3, when nothing competes.
        if let notice = call.speechNotice {
            Text(notice)
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(inCall ? 2 : 3)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let notice = call.watchNotice {
            Text(notice)
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(inCall ? 2 : 3)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let notice = call.screenNotice {
            Text(notice)
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(inCall ? 2 : 3)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let error = call.errorText {
            Text(error)
                .font(.caption)
                .foregroundColor(.orange)
                .multilineTextAlignment(.center)
                .lineLimit(inCall ? 2 : 3)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var inCallSection: some View {
        if inCall {
            composer

            // Push to talk (v0.41.0): the hold button
            // exists ONLY when this call runs in
            // push-to-talk mode — a hands-free call's
            // layout is exactly what it has always been.
            if call.inputMode == .pushToTalk {
                pushToTalkButton
            }

            callControlsRow

            // Screen viewing (v0.45.0): the Share
            // screen row — its own row, not a seventh
            // circle in the control row above (six is
            // already the row's limit). See
            // screenShareSection.
            screenShareSection
        } else {
            startCallButton
        }
    }

    /// The hold-to-talk button (v0.41.0): a press-and-hold,
    /// not a tap — the press barges in and starts the
    /// capture, the release sends it (CallSession
    /// .begin/endPushToTalk). It wears its state: while
    /// held it fills with the accent and its words change,
    /// so the operator can feel the mode from the button
    /// alone, mid-conversation, without reading anything
    /// small. The long-press gesture's pressing callback
    /// reports both edges — and a cancelled press (a
    /// system gesture stealing the touch) reports the
    /// release edge too, so a hold can never stick on.
    private var pushToTalkButton: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16)
                .fill(call.pttHolding ? Color.accentColor : Color.secondary.opacity(0.25))
            Label(call.pttHolding ? "Listening — release to send" : "Hold to talk",
                  systemImage: "mic.fill")
                .font(.headline)
                .foregroundColor(call.pttHolding ? .white : .primary)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 64)
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .onLongPressGesture(minimumDuration: 0, maximumDistance: .infinity, pressing: { pressing in
            if pressing {
                call.beginPushToTalk()
            } else {
                call.endPushToTalk()
            }
        }, perform: {})
        .accessibilityLabel("Hold to talk")
    }

    private var callControlsRow: some View {
        // The control row (v0.23.0 cleanup):
        // equal circles with the label UNDER the
        // icon, so state reads at a glance across
        // a room — a filled accent circle means
        // Speaker is on, a filled orange circle
        // means you are muted, and End is always
        // the red one. Through v0.22.0 these were
        // bordered text buttons whose on/off
        // difference was a swapped SF Symbol and
        // the word Mute flipping to Unmute — easy
        // to misread mid-demo (Glenn, 2026-11-26).
        // v0.31.0: the Speaker circle now shows the
        // ACTUAL route (CallSession
        // .outputRouteIsSpeaker — the session's
        // live route, not the toggle's intent),
        // and a fourth control joins: Devices, the
        // system route picker, for Bluetooth and
        // every other output the phone can see.
        // v0.36.0: a fifth control joins: Camera —
        // one tap, one photo, sent as the next
        // turn of the call (see openCamera and
        // CallSession.sendPhotoTurn). Never
        // automatic, never a stream.
        // v0.37.0: a sixth joins: Watch — the
        // call's camera as the persona's eyes, an
        // explicit per-call toggle that never
        // starts itself (see CallSession.setWatch).
        // Six controls is why the circles are
        // 50 pt now: at 60 the row outgrew the
        // screen it lives on.
        HStack(spacing: 8) {
            CallControlButton(
                title: "Speaker",
                systemImage: call.outputRouteIsSpeaker ? "speaker.wave.2.fill" : "speaker.slash.fill",
                filled: call.outputRouteIsSpeaker,
                fillColor: .accentColor
            ) { call.setSpeaker(!call.outputRouteIsSpeaker) }

            CallRouteButton()

            CallControlButton(
                title: "Camera",
                systemImage: "camera.fill",
                filled: false,
                fillColor: .accentColor
            ) { openCamera() }

            CallControlButton(
                title: call.watchOn ? "Watching" : "Watch",
                systemImage: "video.fill",
                filled: call.watchOn,
                fillColor: .accentColor
            ) { call.setWatch(on: !call.watchOn) }

            CallControlButton(
                title: call.isMuted ? "Muted" : "Mute",
                systemImage: call.isMuted ? "mic.slash.fill" : "mic.fill",
                filled: call.isMuted,
                fillColor: .orange
            ) { call.setMuted(!call.isMuted) }

            CallControlButton(
                title: "End",
                systemImage: "phone.down.fill",
                filled: true,
                fillColor: .red
            ) { call.endCall(); dismiss() }
        }
    }

    private var startCallButton: some View {
        Button {
            call.startCall()
        } label: {
            Label("Call GUS", systemImage: "phone.fill")
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(minWidth: 160)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
    }

    // MARK: - Face + Watch (v0.37.0)

    /// The persona face as its picker button (v0.30.0's
    /// door, factored out in v0.37.0): one face, two sizes —
    /// the screen's dominant visual normally, a participant
    /// tile while watching.
    private func personaFaceButton(side: CGFloat) -> some View {
        Button {
            showPersonaPicker = true
        } label: {
            AvatarFaceView(level: call.voiceLevel,
                           speaking: call.gusSpeaking,
                           listening: inCall && call.corePhase == "listening",
                           side: side)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose persona")
    }

    /// The on-air indicator: while Watch is on, this pill is
    /// on screen — a red dot, the word, and the promise.
    /// There is no state in which the camera runs without it.
    private var onAirPill: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Color.red)
                .frame(width: 8, height: 8)
            Text("Watching")
                .font(.caption)
                .fontWeight(.semibold)
            Text("— frames aren't saved")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    /// The watch controls (v0.37.0), Grok-shaped: Flip
    /// swaps front/back (meaningless in Both, so disabled
    /// there), Both runs both cameras at once (offered
    /// only where the phone can), and Torch lights the
    /// back camera's world (disabled whenever the back
    /// camera isn't live or has no torch).
    private var watchControlsRow: some View {
        HStack(spacing: 18) {
            watchMiniButton(
                title: "Flip",
                systemImage: "arrow.triangle.2.circlepath.camera",
                filled: false
            ) {
                call.setWatchMode(call.watchMode == .front ? .back : .front)
            }
            .disabled(call.watchMode == .both)
            .opacity(call.watchMode == .both ? 0.4 : 1)

            if call.watchBothSupported {
                watchMiniButton(
                    title: "Both",
                    systemImage: "rectangle.split.2x1",
                    filled: call.watchMode == .both
                ) {
                    call.setWatchMode(call.watchMode == .both ? .back : .both)
                }
            }

            watchMiniButton(
                title: "Torch",
                systemImage: "flashlight.on.fill",
                filled: call.watchTorchOn
            ) {
                call.setWatchTorch(!call.watchTorchOn)
            }
            .disabled(!call.watchTorchUsable)
            .opacity(call.watchTorchUsable ? 1 : 0.4)
        }
    }

    private func watchMiniButton(
        title: String,
        systemImage: String,
        filled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: systemImage)
                    .font(.body)
                    .foregroundColor(filled ? .accentColor : .secondary)
                Text(title)
                    .font(.caption2)
                    .foregroundColor(.primary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }

    // MARK: - Screen viewing (v0.45.0)

    /// The sharing indicator: while the operator's screen
    /// is being shared, this pill is on screen beside the
    /// tile — the app's own word, next to the system's red
    /// indicator that iOS keeps up the whole time. There
    /// is no state in which the screen is shared without
    /// both.
    private var screenSharingPill: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Color.red)
                .frame(width: 8, height: 8)
            Text("Sharing your screen")
                .font(.caption)
                .fontWeight(.semibold)
            Text("— frames aren't saved")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    /// The "Your screen" tile: the rolling preview frame
    /// the broadcast extension posts into the app group —
    /// the operator sees exactly what the call sees. Until
    /// the first frame lands it says so, in words.
    private var screenTile: some View {
        ZStack {
            Color.black
            if let preview = call.screenPreview {
                Image(uiImage: preview)
                    .resizable()
                    .scaledToFit()
            } else {
                Text("Your screen — waiting for the first frame…")
                    .font(.caption)
                    .foregroundColor(.white.opacity(0.7))
                    .multilineTextAlignment(.center)
                    .padding(8)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 118)
        .cornerRadius(10)
        .clipped()
        .accessibilityLabel("Your shared screen")
    }

    /// The Share screen row (v0.45.0), under the control
    /// row. What it holds depends on the call:
    ///  - Core, not sharing: the SYSTEM broadcast picker.
    ///    Tapping it opens iOS's own broadcast UI, and the
    ///    operator starts the broadcast THERE — per-session
    ///    consent is Apple's rule, so this app never starts
    ///    a broadcast itself, and the row says so before
    ///    the tap, not after.
    ///  - Core, sharing: the state and the way out (the
    ///    system's indicator / Control Center — the app
    ///    cannot stop a broadcast either).
    ///  - On-device: a plain button that explains itself
    ///    (CallSession.screenShareRefused) — no picker is
    ///    ever presented, because there is nothing that
    ///    could see the screen.
    /// The explainer under the row is always there, in
    /// plain words, BEFORE any sharing starts: what GUS
    /// will see, the red indicator, and how sharing ends.
    @ViewBuilder
    private var screenShareSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            if call.callMode == .onDevice {
                Button { call.screenShareRefused() } label: {
                    screenShareRow
                }
                .buttonStyle(.plain)
            } else {
                screenShareRow
            }
            Text("GUS sees your screen only while sharing is on. iOS shows a red indicator the whole time you share, and sharing stops the moment you stop the broadcast.")
                .font(.caption)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var screenShareRow: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(call.screenSharing ? Color.red : Color.secondary.opacity(0.12))
                    .frame(width: 50, height: 50)
                if call.callMode == .core && !call.screenSharing {
                    // The picker IS the button — the system
                    // draws its broadcast glyph in the circle.
                    BroadcastPickerHost()
                        .frame(width: 50, height: 50)
                } else {
                    Image(systemName: "rectangle.on.rectangle")
                        .font(.title3)
                        .foregroundColor(call.screenSharing ? .white : .secondary)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(call.screenSharing ? "Sharing your screen" : "Share screen")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(.primary)
                Text(screenShareCaption)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .contentShape(Rectangle())
    }

    private var screenShareCaption: String {
        if call.screenSharing {
            return "GUS can see your screen now. Stop any time from the red indicator or Control Center."
        }
        if call.callMode == .onDevice {
            return "Screen sharing needs Core mode — tap to hear why."
        }
        return "Tap the button, then start the broadcast in the system's prompt — you start it there, every time."
    }

    // MARK: - Transcript (v0.23.0)

    /// The running transcript of the call, from the data the
    /// session already keeps: completed turns from
    /// `call.turns`, the in-flight reply from
    /// `call.liveReplyText` (sentences land as their playback
    /// starts), and your in-progress words from
    /// `call.liveTranscript`. Auto-scrolls to the newest line
    /// as any of the three changes; the panel flexes to
    /// whatever height the rest of the screen leaves it, so
    /// the controls and composer never move — down to a
    /// floor (v0.47.2): the panel is the only flexible
    /// element in callContent, and everything the screen
    /// gained since v0.23.0 (the persona name, Camera and
    /// Watch controls, stackable notices, push-to-talk,
    /// the Share screen row) was quietly spending its
    /// height, squeezing it toward invisibility on
    /// shorter screens. The minHeight below is the
    /// guarantee that can't happen again; the room comes
    /// from the in-call face stepping down (headerSection)
    /// and the notices' live-call line cap (statusBlock).
    /// The stack inside is a plain VStack, not a
    /// LazyVStack: call turn counts are modest, and a lazy
    /// stack's not-yet-realized bottom anchor made
    /// ScrollViewReader.scrollTo silently no-op — the
    /// anchor now always exists when scrollTranscript
    /// fires.
    private var transcriptPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Transcript")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)
                .textCase(.uppercase)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if call.turns.isEmpty && call.photoEntries.isEmpty && call.liveReplyText.isEmpty && call.liveTranscript.isEmpty {
                            Text("What you say and what GUS answers will appear here as you talk.")
                                .font(.callout)
                                .foregroundColor(.secondary)
                        }
                        // v0.36.0: camera entries interleave at
                        // their turn anchors — an entry taken
                        // before turn N renders just before
                        // turn N's rows (in Core mode that IS
                        // the photo's own turn: the photo went
                        // in, the reply came back under it).
                        // Entries anchored past the last turn
                        // (an on-device photo, whose spoken
                        // answer is a local turn that may not
                        // have landed yet, or a permission
                        // denial) render after the turns, before
                        // the live rows.
                        ForEach(Array(call.turns.enumerated()), id: \.element.id) { index, turn in
                            ForEach(call.photoEntries.filter { $0.turnAnchor == index }) { entry in
                                photoEntryRow(entry)
                            }
                            transcriptTurn(turn)
                        }
                        ForEach(call.photoEntries.filter { $0.turnAnchor >= call.turns.count }) { entry in
                            photoEntryRow(entry)
                        }
                        if showLiveReply {
                            transcriptRow(speaker: "GUS", text: call.liveReplyText, tint: .accentColor)
                        }
                        if !call.liveTranscript.isEmpty {
                            transcriptRow(speaker: "You", text: call.liveTranscript + " …", tint: .primary, italic: true)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(Self.transcriptBottomID)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: call.turns.count) { _ in scrollTranscript(proxy) }
                .onChange(of: call.photoEntries.count) { _ in scrollTranscript(proxy) }
                .onChange(of: call.liveTranscript) { _ in scrollTranscript(proxy) }
                .onChange(of: call.liveReplyText) { _ in scrollTranscript(proxy) }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 170, maxHeight: .infinity, alignment: .topLeading)
        .padding(12)
        .background(Color.secondary.opacity(0.08))
        .cornerRadius(12)
    }

    private static let transcriptBottomID = "transcript-bottom"

    private func scrollTranscript(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo(Self.transcriptBottomID, anchor: .bottom)
        }
    }

    /// The in-flight reply row shows only until the finished
    /// turn lands carrying the same words — then the turn's
    /// own row is the record and the live row steps aside.
    private var showLiveReply: Bool {
        guard !call.liveReplyText.isEmpty else { return false }
        return call.turns.last?.replyText != call.liveReplyText
    }

    @ViewBuilder
    private func transcriptTurn(_ turn: VoiceSessionState.Turn) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if turn.watch == true {
                // An ambient Watch observation (v0.37.0):
                // nobody spoke — GUS looked. The caption
                // says so; the reply row below is the
                // comment, in GUS's name as always.
                Text("GUS LOOKED — WATCH")
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundColor(.secondary)
            }
            if let transcript = turn.transcript, !transcript.isEmpty {
                transcriptRow(speaker: "You", text: transcript, tint: .primary)
            }
            if let reply = turn.replyText, !reply.isEmpty {
                transcriptRow(speaker: "GUS", text: reply, tint: .accentColor)
            }
            if turn.interrupted {
                Text("Interrupted — speech cut, nothing else stopped.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }

    private func transcriptRow(speaker: String, text: String, tint: Color, italic: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(speaker)
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)
            Text(text)
                .font(.callout)
                .italic(italic)
                .foregroundColor(tint)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// One camera entry in the transcript (v0.36.0): the
    /// "You" row for a photo — the thumbnail when there is
    /// one (a problem entry has none), and under it, in
    /// caption words, what happened to it. This row is the
    /// visible record that a photo was taken on this call;
    /// nothing about a capture is silent.
    @ViewBuilder
    private func photoEntryRow(_ entry: CallPhotoEntry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("You")
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)
            if let data = entry.imageData, let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 160)
                    .cornerRadius(8)
            }
            Text(entry.note)
                .font(.caption)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The camera button's gate (v0.36.0). Permission first,
    /// in context: a denial (or a device with no camera)
    /// lands as plain words in the transcript via
    /// CallSession.notePhotoProblem — the operator is never
    /// left wondering whether a photo happened. Granted (or
    /// not yet asked — the system prompt then appears over
    /// this very screen, in context) opens the system
    /// camera. Exactly one photo per presentation.
    private func openCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted:
            call.notePhotoProblem(
                "Camera access is off for GUS — turn it on in Settings → GUS → Camera if you want GUS to see.")
        case .authorized, .notDetermined:
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                showCamera = true
            } else {
                call.notePhotoProblem("This device has no camera GUS can use.")
            }
        @unknown default:
            call.notePhotoProblem("The camera isn't available right now.")
        }
    }

    // MARK: - Composer (v0.23.0)

    /// Type while talking: the draft sends into the same
    /// conversation through CallSession.sendTypedMessage —
    /// the spoken final's own doors (Shield gate on-device,
    /// the core's server-side scan in Core mode) — and the
    /// reply is spoken as part of the call. The keyboard
    /// changes nothing about hearing; the mic stays live.
    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Type a message…", text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .textFieldStyle(.roundedBorder)
                .focused($composerFocused)
                .onSubmit(sendDraft)
            Button(action: sendDraft) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title)
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send message")
        }
    }

    private func sendDraft() {
        let text = draft
        draft = ""
        call.sendTypedMessage(text)
    }
}

/// One call control (v0.23.0): a circle with its label
/// underneath. Filled means the state is ON — accent for
/// Speaker, orange for Muted (the state that needs noticing),
/// red always for End. Unfilled is a plain ring with a
/// secondary icon. Same size and spacing for all, so
/// the row reads as one instrument, not buttons that
/// happen to share a line. v0.37.0: 50 pt, down from 60 —
/// the row holds six controls now (Watch joined), and six
/// 60 pt circles are wider than the phone.
private struct CallControlButton: View {
    let title: String
    let systemImage: String
    let filled: Bool
    // Required, and declared before `action` (v0.43.1):
    // v0.40.1's archive failed because the Camera call
    // site omitted this argument — but the v0.41.1 fix
    // (a default here) broke the call sites that DO pass
    // it: a defaulted parameter immediately before the
    // trailing-closure `action` breaks trailing-closure
    // matching (the Speaker site failed with extra /
    // missing argument errors). So every call site
    // passes fillColor explicitly, even Camera, whose
    // button is never filled and never reads the value.
    let fillColor: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                ZStack {
                    Circle()
                        .fill(filled ? fillColor : Color.secondary.opacity(0.12))
                        .frame(width: 50, height: 50)
                    Image(systemName: systemImage)
                        .font(.title3)
                        .foregroundColor(filled ? .white : .secondary)
                }
                Text(title)
                    .font(.caption)
                    .foregroundColor(.primary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }
}

/// The face on the call screen (v0.15.5, "the face" —
/// Glenn approved the direction 2026-11-19 and pulled it
/// forward 2026-11-20): the avatar, decoded from its own
/// .b64 master by build-ipa.sh into its imageset — cropped
/// to the head, with a mouth that moves with Kokoro's
/// voice. v0.20.0: the art is the hyper-realistic pair
/// Glenn approved — the boy in Avatar (the default), the
/// girl in AvatarGirl — picked in Settings over
/// gus.avatar.stock, the same key the Mac keeps; the plush
/// portrait that filled this spot through v0.19.0 stays in
/// git history.
///
/// v0.31.0 (Glenn): the face is the ACTIVE PERSONA's —
/// PersonaFace.current resolves it (the persona's own
/// portrait, or the stock pick for General/Custom) — and
/// it is MUCH larger: 232 pt, the screen's dominant
/// visual in the shape of Muse's call screen, with the
/// transcript flexing around it and the controls unmoved
/// below. The animation grows with it: the mouth-flap at
/// full size, a breathing idle (a slow ±3% swell, so the
/// face feels alive in silence), and an unmistakable
/// speaking state — the backing disc swells with the
/// voice level itself and a ring pulses outward while
/// GUS talks; the listening pulse from before stays for
/// the hearing phases.
///
/// The mouth is an amplitude lip-flap, deliberately NOT
/// lip-sync: KokoroPlayer publishes the RMS of the samples
/// it is already playing (once per utterance, one pass over
/// data already in memory), and the ellipse's height
/// follows it. The animation adds no work to the audio
/// path: a 12 fps TimelineView reshapes one small ellipse,
/// and the breathing scale and pulses are plain view
/// transforms. If any of this ever threatened the call,
/// the face goes, not the call (Glenn's hard rule).
///
/// v0.32.0 polish (Glenn: the flap was "not very pretty"):
/// the mouth no longer chases the raw level. A MouthFlap
/// smoother sits between the published level and the
/// ellipse — fast attack, slower decay, advanced once per
/// tick — so the mouth moves at a syllable-like cadence
/// instead of jittering with every RMS step; the vertical
/// travel is shorter; the opening is eased (small levels
/// barely part the lips); and the patch itself is softer —
/// lower opacity, a whisper of blur on its edge — so it
/// reads as part of the face rather than pasted on. The
/// mouth centers are measured now, too (LocalBrain's
/// PersonaFace note). Still an amplitude flap, honestly:
/// prettier, not a viseme engine.
///
/// Each face's crop and mouth calibration lives in
/// PersonaFace (LocalBrain.swift, beside the persona it
/// belongs to); every constant is eyeballed until Glenn
/// sees it on his phone and says it is right.
/// The flap's memory (v0.32.0): one smoothed level,
/// advanced once per TimelineView tick toward the live
/// target. Attack (target above the smoothed value) takes
/// a big step per tick — a syllable's onset lands at once;
/// decay takes a small one, so the mouth settles shut over
/// several ticks instead of snapping. Mutating this inside
/// the tick closure is safe: nothing here publishes, so no
/// view invalidation rides on it — the TimelineView's own
/// clock is the redraw.
private final class MouthFlap: ObservableObject {
    private(set) var smoothed: CGFloat = 0

    func advance(toward target: CGFloat) -> CGFloat {
        let step: CGFloat = target > smoothed ? 0.55 : 0.24
        smoothed += (target - smoothed) * step
        if abs(target - smoothed) < 0.002 { smoothed = target }
        return smoothed
    }
}

private struct AvatarFaceView: View {
    let level: Float
    let speaking: Bool
    let listening: Bool

    @State private var breathe = false
    @State private var pulse = false
    @StateObject private var flap = MouthFlap()
    /// The pick, observed (v0.32.0) — the face re-derives
    /// the moment a persona is picked, like every other
    /// surface (see CallView's note).
    @ObservedObject private var personaSelection = PersonaSelection.shared

    /// v0.20.0: the stock avatar pick (Settings → Avatar),
    /// the same key the Mac keeps — "girl" shows AvatarGirl,
    /// anything else is the boy in Avatar, the default.
    /// v0.31.0: it only decides the face when no persona is
    /// active (or the Gus persona, who shares the
    /// boy) — a persona's own portrait outranks it.
    @AppStorage("gus.avatar.stock") private var stockAvatar = "boy"
    private var face: PersonaFace {
        PersonaFace.current(stockGirl: stockAvatar == "girl")
    }

    /// v0.31.0: properly large (see the type comment) —
    /// the old 120 pt face read as a thumbnail next to the
    /// transcript; this one IS the call screen.
    /// v0.37.0: the size is the caller's choice now — the
    /// full 232 pt when the face owns the screen, a 104 pt
    /// participant tile while Watch mode's camera tiles
    /// share it.
    var side: CGFloat = 232

    var body: some View {
        ZStack {
            Circle()
                .fill(Color.accentColor.opacity(speaking ? 0.3 : 0.15))
                .frame(width: side + 20, height: side + 20)
                // The speaking swell: the disc breathes with
                // the voice itself, on the same published
                // level the mouth follows.
                .scaleEffect(speaking ? 1.0 + CGFloat(level) * 0.07 : 1.0)
            if speaking {
                Circle()
                    .stroke(Color.accentColor.opacity(0.35), lineWidth: 2)
                    .frame(width: side + 20, height: side + 20)
                    .scaleEffect(pulse ? 1.1 : 1.0)
                    .opacity(pulse ? 0.12 : 0.55)
            }
            if listening {
                Circle()
                    .stroke(Color.accentColor.opacity(0.35), lineWidth: 2)
                    .frame(width: side + 20, height: side + 20)
                    .scaleEffect(pulse ? 1.1 : 1.0)
                    .opacity(pulse ? 0.15 : 0.6)
            }
            faceView
        }
        .scaleEffect(breathe ? 1.03 : 1.0)
        .accessibilityHidden(true)
        .onAppear {
            withAnimation(.easeInOut(duration: 3.4).repeatForever(autoreverses: true)) {
                breathe = true
            }
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }

    private var faceView: some View {
        GeometryReader { geo in
            let s = geo.size.width
            let rendered = s / face.cropSide
            ZStack(alignment: .topLeading) {
                Image(face.imageName)
                    .resizable()
                    .frame(width: rendered, height: rendered)
                    .offset(x: -face.cropOriginX * rendered, y: -face.cropOriginY * rendered)
                TimelineView(.periodic(from: .now, by: 1.0 / 12.0)) { context in
                    // One smoother step per tick (v0.32.0):
                    // the ellipse follows the flap's memory,
                    // never the raw published level — and the
                    // spring that used to animate the raw
                    // level's steps is gone; it was half the
                    // jitter.
                    let tickLevel = flap.advance(toward: speaking ? CGFloat(level) : 0)
                    ZStack {
                        Ellipse()
                            .fill(Color(red: 0.25, green: 0.13, blue: 0.04).opacity(0.78))
                            .frame(width: s * face.mouthWidth,
                                   height: mouthHeight(at: context.date, level: tickLevel))
                            .blur(radius: max(1, s * 0.008))
                            .position(x: s * face.mouthCenterX, y: s * face.mouthCenterY)
                    }
                    .frame(width: s, height: s)
                }
            }
        }
        .frame(width: side, height: side)
        .clipShape(Circle())
    }

    /// Mouth height for a tick, from the SMOOTHED level:
    /// closed is a thinner line than v0.31.0's, the travel
    /// is shorter (0.058 of the face over the line, was
    /// 0.085), and the opening is eased — a smoothstep over
    /// the level, so quiet syllables barely part the lips
    /// and only real volume opens the mouth. A slow, small
    /// flutter rides on top so a held vowel doesn't freeze
    /// the mouth mid-shape. Pure view math — the audio path
    /// never hears about any of this.
    private func mouthHeight(at date: Date, level tickLevel: CGFloat) -> CGFloat {
        guard tickLevel > 0.004 else { return side * 0.018 }
        let clamped = min(max(tickLevel, 0), 1)
        let eased = clamped * clamped * (3 - 2 * clamped)
        let flutter = 0.97 + 0.03 * sin(date.timeIntervalSinceReferenceDate * 7)
        return side * (0.018 + eased * 0.058 * CGFloat(flutter))
    }
}

/// The Devices control (v0.31.0): the system route picker
/// as the control row's fourth circle — Bluetooth
/// headsets, AirPlay, the car, every output the phone can
/// see, in the system's own sheet (AVRoutePickerView).
/// Picking a device there routes the call's audio through
/// the session like any route change: CallSession watches
/// route changes, never fights an external device's route,
/// and the Speaker circle keeps showing the actual route.
private struct CallRouteButton: View {
    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                Circle()
                    .fill(Color.secondary.opacity(0.12))
                    .frame(width: 50, height: 50)
                RoutePickerView()
                    .frame(width: 50, height: 50)
            }
            Text("Devices")
                .font(.caption)
                .foregroundColor(.primary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .accessibilityLabel("Audio devices")
    }
}

private struct RoutePickerView: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let picker = AVRoutePickerView()
        picker.tintColor = .secondaryLabel
        picker.activeTintColor = .systemBlue
        picker.backgroundColor = .clear
        picker.prioritizesVideoDevices = false
        return picker
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}

/// The system camera, wrapped for SwiftUI (v0.36.0): the
/// stock UIImagePickerController in camera mode — the
/// pragmatic v1, no custom viewfinder. One photo per
/// presentation: the delegate hands back the captured
/// image (or nil on cancel) and the cover dismisses.
private struct CallCameraPicker: UIViewControllerRepresentable {
    let onCapture: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCapture: onCapture) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCapture: (UIImage?) -> Void
        init(onCapture: @escaping (UIImage?) -> Void) { self.onCapture = onCapture }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            onCapture(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCapture(nil)
        }
    }
}

/// The Watch preview's SwiftUI host (v0.37.0): the capture
/// controller's container view, embedded as-is — the
/// controller owns the preview layers and their layout;
/// this host only gives the view a place on the call
/// screen. The view is the session's one preview surface,
/// created with the CallSession and reused across calls.
private struct WatchPreviewHost: UIViewRepresentable {
    let view: UIView

    func makeUIView(context: Context) -> UIView { view }

    func updateUIView(_ uiView: UIView, context: Context) {}
}

/// The system broadcast picker's SwiftUI host (v0.45.0):
/// RPSystemBroadcastPickerView is the ONLY door to a
/// ReplayKit broadcast — tapping it presents iOS's own
/// broadcast UI (the consent surface), with our extension
/// preselected via preferredExtension, and the operator
/// starts the broadcast there. The microphone button is
/// off: the call already has the operator's voice through
/// its own hearing path; the broadcast is for the screen.
private struct BroadcastPickerHost: UIViewRepresentable {
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(
            frame: CGRect(x: 0, y: 0, width: 50, height: 50))
        picker.preferredExtension = "com.startekenterprises.gus.broadcast"
        picker.showsMicrophoneButton = false
        return picker
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}
