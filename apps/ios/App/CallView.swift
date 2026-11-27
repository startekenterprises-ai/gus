import SwiftUI

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
struct CallView: View {
    /// Extra bottom room that clears the floating tab
    /// bar's pill while it is visible (v0.17.4) — sized
    /// from the 0.17.3 screenshot, where the standard
    /// 20 pt bottom padding still left the call button's
    /// bottom edge behind the pill.
    private static let tabBarClearance: CGFloat = 72

    @StateObject private var call = CallSession()
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
                AvatarFaceView(level: call.voiceLevel,
                               speaking: call.gusSpeaking,
                               listening: inCall && call.corePhase == "listening")
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
                    // three equal circles with the label
                    // UNDER the icon, so state reads at a
                    // glance across a room — a filled accent
                    // circle means Speaker is on, a filled
                    // orange circle means you are muted, and
                    // End is always the red one. Through
                    // v0.22.0 these were bordered text
                    // buttons whose on/off difference was a
                    // swapped SF Symbol and the word Mute
                    // flipping to Unmute — easy to misread
                    // mid-demo (Glenn, 2026-11-26).
                    HStack(spacing: 12) {
                        CallControlButton(
                            title: "Speaker",
                            systemImage: call.isSpeakerOn ? "speaker.wave.2.fill" : "speaker.slash.fill",
                            filled: call.isSpeakerOn,
                            fillColor: .accentColor
                        ) { call.setSpeaker(!call.isSpeakerOn) }

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
                        ) { call.endCall() }
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
            // Tab-bar clearance (v0.17.4): the floating tab
            // bar overlays the bottom of this screen while it
            // is visible, and the transcript panel claims the
            // layout space the clearance would otherwise come from —
            // in 0.17.3 the pre-call "Call GUS" button sat
            // with its bottom hidden behind the tab-bar pill
            // (operator's screenshot, 2026-11-20). While the
            // bar is up (not in a call), add enough bottom
            // room to clear the pill with margin. In a call
            // the bar hides (below) and the layout is exactly
            // as before — the in-call controls do not move.
            .padding(.bottom, inCall ? 0 : Self.tabBarClearance)
            .navigationTitle("Call")
            .navigationBarTitleDisplayMode(.inline)
            // The tab bar hides while a call is live
            // (v0.16.0): the Speaker / Mute / End controls
            // sit at the bottom of this screen, and the tab
            // bar covered them (Glenn's screenshot,
            // 2026-11-20). It returns when the call ends.
            .toolbar(inCall ? .hidden : .visible, for: .tabBar)
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
/// forward 2026-11-20): the stock avatar, decoded from its
/// own .b64 master by build-ipa.sh into Avatar.imageset —
/// cropped to the head, with a mouth that moves with
/// Kokoro's voice. v0.20.0: the art is the hyper-realistic
/// pair Glenn approved — the boy in Avatar (the default),
/// the girl in AvatarGirl — picked in Settings over
/// gus.avatar.stock, the same key the Mac keeps; the plush
/// portrait that filled this spot through v0.19.0 stays in
/// git history. Each face carries its own crop and mouth
/// calibration below, measured from its pixels the way the
/// plush's was — and, like the plush's, eyeballed until
/// Glenn sees it on his phone and says it is right.
///
/// The mouth is an amplitude lip-flap, deliberately NOT
/// lip-sync: KokoroPlayer publishes the RMS of the samples
/// it is already playing (once per utterance, one pass over
/// data already in memory), and the ellipse's height
/// follows it. The animation adds no work to the audio
/// path: a 12 fps TimelineView reshapes one small ellipse,
/// and the breathing scale and listening pulse are plain
/// view transforms. If any of this ever threatened the
/// call, the face goes, not the call (Glenn's hard rule).
///
/// Placement was measured from the art itself (below);
/// the exact sit of the mouth is eyeballed until Glenn
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
    @AppStorage("gus.avatar.stock") private var stockAvatar = "boy"
    private var isGirl: Bool { stockAvatar == "girl" }
    private var imageName: String { isGirl ? "AvatarGirl" : "Avatar" }

    private let side: CGFloat = 120
    // The square window on the face inside the shipped
    // square art, as fractions of the image, per face
    // (v0.20.0, measured from the new portraits' pixels):
    // the boy's face spans x ~0.115–0.885, hairline y
    // ~0.153, chin ~0.953, mouth center ~(0.50, 0.773)
    // spanning ~0.20; the girl's face spans x ~0.315–0.685
    // inside her hair, hairline y ~0.27, chin ~0.715,
    // mouth center ~(0.505, 0.60) spanning ~0.13. Each
    // window frames its face a touch tighter than the
    // head, so the face fills the circle edge to edge
    // (full-bleed), as the plush's window did.
    private var cropOriginX: CGFloat { isGirl ? 0.225 : 0.14 }
    private var cropOriginY: CGFloat { isGirl ? 0.215 : 0.193 }
    private var cropSide: CGFloat { isGirl ? 0.55 : 0.72 }
    // The mouth's center and width inside that window,
    // mapped from the full-image measurements above, so
    // the ellipse sits on the mouth: closed reads as the
    // smile, open reads as the mouth opening inside it.
    private var mouthCenterX: CGFloat { isGirl ? 0.509 : 0.50 }
    private var mouthCenterY: CGFloat { isGirl ? 0.70 : 0.806 }
    private var mouthWidth: CGFloat { isGirl ? 0.236 : 0.278 }

    var body: some View {
        ZStack {
            Circle()
                .fill(Color.accentColor.opacity(speaking ? 0.3 : 0.15))
                .frame(width: side + 14, height: side + 14)
            if listening {
                Circle()
                    .stroke(Color.accentColor.opacity(0.35), lineWidth: 2)
                    .frame(width: side + 14, height: side + 14)
                    .scaleEffect(pulse ? 1.1 : 1.0)
                    .opacity(pulse ? 0.15 : 0.6)
            }
            face
        }
        .scaleEffect(breathe ? 1.015 : 1.0)
        .accessibilityHidden(true)
        .onAppear {
            withAnimation(.easeInOut(duration: 2.8).repeatForever(autoreverses: true)) {
                breathe = true
            }
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }

    private var face: some View {
        GeometryReader { geo in
            let s = geo.size.width
            let rendered = s / cropSide
            ZStack(alignment: .topLeading) {
                Image(imageName)
                    .resizable()
                    .frame(width: rendered, height: rendered)
                    .offset(x: -cropOriginX * rendered, y: -cropOriginY * rendered)
                TimelineView(.periodic(from: .now, by: 1.0 / 12.0)) { context in
                    ZStack {
                        Ellipse()
                            .fill(Color(red: 0.25, green: 0.13, blue: 0.04).opacity(0.85))
                            .frame(width: s * mouthWidth, height: mouthHeight(at: context.date))
                            .position(x: s * mouthCenterX, y: s * mouthCenterY)
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
    /// published level opens it up to ~10 pt more, with a
    /// gentle flutter while speech is sounding so a long
    /// sentence does not hold a statue's mouth. Pure view
    /// math on the published level — the audio path never
    /// hears about any of this.
    private func mouthHeight(at date: Date) -> CGFloat {
        let open = CGFloat(level)
        guard open > 0.01 else { return side * 0.021 }
        let flutter = 0.94 + 0.06 * sin(date.timeIntervalSinceReferenceDate * 11)
        return side * (0.021 + open * 0.085 * CGFloat(flutter))
    }
}
