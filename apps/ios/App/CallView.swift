import SwiftUI
import AVKit

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
    @State private var didAutoStart = false
    @State private var showPersonaPicker = false

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
            VStack(spacing: 16) {
                // The face is the persona door (v0.30.0):
                // tap it to switch personas mid-visit — the
                // pick writes the same key Settings writes
                // and lands when the brain next loads.
                Button {
                    showPersonaPicker = true
                } label: {
                    AvatarFaceView(level: call.voiceLevel,
                                   speaking: call.gusSpeaking,
                                   listening: inCall && call.corePhase == "listening")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Choose persona")
                .padding(.top, 12)

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

                if let notice = call.speechNotice {
                    Text(notice)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let error = call.errorText {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.orange)
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity)
                        .fixedSize(horizontal: false, vertical: true)
                }

                transcriptPanel

                if inCall {
                    composer

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
                    HStack(spacing: 12) {
                        CallControlButton(
                            title: "Speaker",
                            systemImage: call.outputRouteIsSpeaker ? "speaker.wave.2.fill" : "speaker.slash.fill",
                            filled: call.outputRouteIsSpeaker,
                            fillColor: .accentColor
                        ) { call.setSpeaker(!call.outputRouteIsSpeaker) }

                        CallRouteButton()

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
                } else {
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
            }
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

    // MARK: - Transcript (v0.23.0)

    /// The running transcript of the call, from the data the
    /// session already keeps: completed turns from
    /// `call.turns`, the in-flight reply from
    /// `call.liveReplyText` (sentences land as their playback
    /// starts), and your in-progress words from
    /// `call.liveTranscript`. Auto-scrolls to the newest line
    /// as any of the three changes; the panel flexes to
    /// whatever height the rest of the screen leaves it, so
    /// the controls and composer never move.
    private var transcriptPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Transcript")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)
                .textCase(.uppercase)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if call.turns.isEmpty && call.liveReplyText.isEmpty && call.liveTranscript.isEmpty {
                            Text("What you say and what GUS answers will appear here as you talk.")
                                .font(.callout)
                                .foregroundColor(.secondary)
                        }
                        ForEach(call.turns) { turn in
                            transcriptTurn(turn)
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
                .onChange(of: call.liveTranscript) { _ in scrollTranscript(proxy) }
                .onChange(of: call.liveReplyText) { _ in scrollTranscript(proxy) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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

/// One call control (v0.23.0): a 60 pt circle with its label
/// underneath. Filled means the state is ON — accent for
/// Speaker, orange for Muted (the state that needs noticing),
/// red always for End. Unfilled is a plain ring with a
/// secondary icon. Same size and spacing for all three, so
/// the row reads as one instrument, not three buttons that
/// happen to share a line.
private struct CallControlButton: View {
    let title: String
    let systemImage: String
    let filled: Bool
    let fillColor: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                ZStack {
                    Circle()
                        .fill(filled ? fillColor : Color.secondary.opacity(0.12))
                        .frame(width: 60, height: 60)
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
/// Each face's crop and mouth calibration lives in
/// PersonaFace (LocalBrain.swift, beside the persona it
/// belongs to); every constant is eyeballed until Glenn
/// sees it on his phone and says it is right.
private struct AvatarFaceView: View {
    let level: Float
    let speaking: Bool
    let listening: Bool

    @State private var breathe = false
    @State private var pulse = false

    /// v0.20.0: the stock avatar pick (Settings → Avatar),
    /// the same key the Mac keeps — "girl" shows AvatarGirl,
    /// anything else is the boy in Avatar, the default.
    /// v0.31.0: it only decides the face when no persona is
    /// active (or the everyday assistant, who shares the
    /// boy) — a persona's own portrait outranks it.
    @AppStorage("gus.avatar.stock") private var stockAvatar = "boy"
    private var face: PersonaFace {
        PersonaFace.current(stockGirl: stockAvatar == "girl")
    }

    /// v0.31.0: properly large (see the type comment) —
    /// the old 120 pt face read as a thumbnail next to the
    /// transcript; this one IS the call screen.
    private let side: CGFloat = 232

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
                    ZStack {
                        Ellipse()
                            .fill(Color(red: 0.25, green: 0.13, blue: 0.04).opacity(0.85))
                            .frame(width: s * face.mouthWidth, height: mouthHeight(at: context.date))
                            .position(x: s * face.mouthCenterX, y: s * face.mouthCenterY)
                    }
                    .frame(width: s, height: s)
                }
            }
        }
        .frame(width: side, height: side)
        .clipShape(Circle())
        .animation(.spring(response: 0.16, dampingFraction: 0.5), value: level)
    }

    /// Mouth height for a tick: closed is a thin line; the
    /// published level opens it proportionally (the
    /// fractions scale with the face), with a gentle
    /// flutter while speech is sounding so a long sentence
    /// does not hold a statue's mouth. Pure view math on
    /// the published level — the audio path never hears
    /// about any of this.
    private func mouthHeight(at date: Date) -> CGFloat {
        let open = CGFloat(level)
        guard open > 0.01 else { return side * 0.021 }
        let flutter = 0.94 + 0.06 * sin(date.timeIntervalSinceReferenceDate * 11)
        return side * (0.021 + open * 0.085 * CGFloat(flutter))
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
                    .frame(width: 60, height: 60)
                RoutePickerView()
                    .frame(width: 60, height: 60)
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
