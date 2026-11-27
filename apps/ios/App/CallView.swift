import SwiftUI

/// The front door: a live call with GUS. Tap Call and talk —
/// full-duplex, with barge-in; there is deliberately no
/// push-to-talk anywhere in this app (Glenn's ruling,
/// 2026-11-19: dead air while holding a button is where a
/// demo dies). While the call runs, the screen shows what GUS
/// is doing — listening, thinking, speaking — the live
/// transcript as you speak, and the turns so far.
struct CallView: View {
    /// Extra bottom room that clears the floating tab
    /// bar's pill while it is visible (v0.17.4) — sized
    /// from the 0.17.3 screenshot, where the standard
    /// 20 pt bottom padding still left the call button's
    /// bottom edge behind the pill.
    private static let tabBarClearance: CGFloat = 72

    @StateObject private var call = CallSession()

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

                if !call.liveTranscript.isEmpty {
                    Text(call.liveTranscript)
                        .font(.callout)
                        .italic()
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(4)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity)
                        .fixedSize(horizontal: false, vertical: true)
                }

                List(call.turns) { turn in
                    VStack(alignment: .leading, spacing: 2) {
                        if let transcript = turn.transcript, !transcript.isEmpty {
                            Text(transcript).font(.callout)
                        }
                        if let reply = turn.replyText, !reply.isEmpty {
                            Text(reply)
                                .font(.callout)
                                .foregroundColor(.accentColor)
                        }
                        if turn.interrupted {
                            Text("Interrupted — speech cut, nothing else stopped.")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
                .listStyle(.plain)

                Spacer()

                if inCall {
                    // The three controls share the row's width
                    // equally (v0.17.0): flexible labels, tight
                    // spacing — the fixed 90pt minimums plus
                    // 24pt gaps could exceed the screen and
                    // spill off both edges.
                    HStack(spacing: 12) {
                        Button {
                            call.setSpeaker(!call.isSpeakerOn)
                        } label: {
                            Label("Speaker",
                                  systemImage: call.isSpeakerOn ? "speaker.wave.2.fill" : "speaker.slash.fill")
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)

                        Button {
                            call.setMuted(!call.isMuted)
                        } label: {
                            Label(call.isMuted ? "Unmute" : "Mute",
                                  systemImage: call.isMuted ? "mic.slash.fill" : "mic.fill")
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)

                        Button(role: .destructive) {
                            call.endCall()
                        } label: {
                            Label("End", systemImage: "phone.down.fill")
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
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
            // is visible, and the turns List claims the layout
            // space the clearance would otherwise come from —
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
