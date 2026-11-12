import SwiftUI

/// THE Call button — one view, one source of truth, and since
/// v0.9.9 the ONLY Call button in the app: it lives in the chat
/// composer, and the duplicate the window's top bar carried
/// through 0.9.8 is gone (two working Call buttons confused
/// more than they helped — Glenn's field call). The label, the
/// icon, the action, and the (absence of a) disabled condition
/// live here and nowhere else. In a call the button is End Call
/// (the hang-up); out of one it is Call (the preflight + session
/// start, in the model). There is no state in which it is
/// disabled: a call that can't start says why in the notice
/// rather than greying the button.
struct VoiceCallButton: View {
    @ObservedObject var model: DesktopModel

    var body: some View {
        if model.voiceInCall {
            Button {
                model.endVoiceCall()
            } label: {
                Label("End Call", systemImage: "phone.down.fill")
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .help("End the call — the microphone closes with it")
        } else {
            Button {
                model.startVoiceCall()
            } label: {
                Label("Call", systemImage: "phone.fill")
            }
            .buttonStyle(.bordered)
            .help("Call GUS — a live voice call. The microphone is on only while the call is open; the words go through the same pipeline as a typed message.")
        }
    }
}

/// Chat — the home screen. Renders the same durable transcript the
/// web panel renders (chat.jsonl via /api/chat/history): the
/// operator's messages, GUS's delivered replies, and a status line
/// per job in this conversation. Submitting goes through
/// POST /api/chat — the panel-chat channel adapter — so a message
/// from this window is scanned, classified, capped, and receipted
/// exactly like one from Telegram. Pending approvals for chat jobs
/// appear as cards above the composer and resolve through the same
/// panel endpoints as every other surface.
struct ChatView: View {
    @ObservedObject var model: DesktopModel
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            if !model.reachable {
                Text("GUS isn't answering on the local panel yet. If the services are stopped, choose Start GUS from the menu bar — this view fills in on its own when the control plane responds.")
                    .font(.callout)
                    .foregroundColor(.secondary)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(nsColor: .controlBackgroundColor))
            }
            transcript
            if !model.chatApprovals.isEmpty {
                Divider()
                VStack(spacing: 8) {
                    ForEach(model.chatApprovals) { approval in
                        ApprovalCardView(model: model, approval: approval)
                    }
                }
                .padding(10)
            }
            if model.voiceInCall {
                Divider()
                callStatusStrip
            }
            Divider()
            composer
            if let notice = model.notice {
                Text(notice)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }
        }
        .onChange(of: model.composerFocusToken) { _, _ in
            composerFocused = true
        }
        // v0.9.7: the speech-settings prompt — when built-in
        // listening is walled off by macOS, the call surface
        // itself offers the switches (deep links to the exact
        // Settings panes) instead of leaving a reason in the
        // notice line and sending the operator hunting.
        .alert(
            Text(model.voiceSpeechPrompt?.title ?? ""),
            isPresented: Binding(
                get: { model.voiceSpeechPrompt != nil },
                set: { presented in
                    if !presented { model.voiceSpeechPrompt = nil }
                }
            ),
            presenting: model.voiceSpeechPrompt
        ) { prompt in
            switch prompt {
            case .dictationDisabled:
                Button("Open Dictation Settings") {
                    model.openSystemSettings(pane: "com.apple.preference.keyboard?Dictation")
                }
                Button("Open Siri Settings") {
                    model.openSystemSettings(pane: "com.apple.preference.siri")
                }
                Button("Not now", role: .cancel) { model.voiceSpeechPrompt = nil }
            case .accessDenied:
                Button("Open Speech Recognition Settings") {
                    model.openSystemSettings(pane: "com.apple.preference.security?Privacy_SpeechRecognition")
                }
                Button("Not now", role: .cancel) { model.voiceSpeechPrompt = nil }
            }
        } message: { prompt in
            Text(prompt.message)
        }
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if model.chatMessages.isEmpty && model.chatJobs.isEmpty && model.voiceTurns.isEmpty {
                        Text("No messages yet. Say hello — or give GUS a job.")
                            .foregroundColor(.secondary)
                            .padding(.top, 8)
                    }
                    ForEach(Array(model.chatMessages.enumerated()), id: \.offset) { _, message in
                        messageBubble(message)
                    }
                    ForEach(model.voiceTurns) { turn in
                        if let transcript = turn.transcript, !transcript.isEmpty {
                            messageBubble(PanelChatMessage(ts: turn.startedAt, direction: "in", text: "🎙 \(transcript)"))
                        }
                        if let reply = turn.replyText, !reply.isEmpty {
                            messageBubble(PanelChatMessage(ts: turn.startedAt, direction: "out", text: reply))
                        }
                    }
                    ForEach(model.chatJobs) { job in
                        jobLine(job)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("chat-bottom")
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: model.chatMessages.count) { _, _ in
                proxy.scrollTo("chat-bottom", anchor: .bottom)
            }
            .onChange(of: model.voiceTurns.count) { _, _ in
                proxy.scrollTo("chat-bottom", anchor: .bottom)
            }
            .onChange(of: model.chatJobs.map(\.id).joined()) { _, _ in
                proxy.scrollTo("chat-bottom", anchor: .bottom)
            }
        }
    }

    private func messageBubble(_ message: PanelChatMessage) -> some View {
        let mine = message.direction == "in"
        return HStack {
            if mine { Spacer(minLength: 60) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
                Text(mine ? "You" : "GUS")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                Text(message.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(
                        RoundedRectangle(cornerRadius: 10)
                            .fill(mine ? Color.accentColor.opacity(0.16) : Color(nsColor: .controlBackgroundColor))
                    )
                Text(GusFormat.time(message.ts))
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            if !mine { Spacer(minLength: 60) }
        }
    }

    private func jobLine(_ job: PanelJob) -> some View {
        var text = "— job \(job.kind) · \(job.state) · \(GusFormat.time(job.createdAt))"
        if let note = job.outcomeNote { text += " · \(note)" }
        if let receipt = job.receiptId { text += " · receipt \(receipt)" }
        text += " · \(GusFormat.usd(job.costUsd))"
        return Text(text)
            .font(.caption)
            .foregroundColor(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Composer

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Message", text: $model.composerText)
                .textFieldStyle(.roundedBorder)
                .focused($composerFocused)
                .onSubmit { model.sendComposer() }
            Button("Send") { model.sendComposer() }
                .buttonStyle(.borderedProminent)
                .disabled(model.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .help("Send — the message goes through the same scan, caps, and receipts as any channel")
            VoiceCallButton(model: model)
        }
        .padding(12)
    }

    /// Mute (v0.9.8; made PROMINENT in v0.9.9): the dog-barking
    /// control. While the call is open, one click stops the
    /// microphone feed dead — nothing is transcribed, nothing is
    /// posted to the session, room noise can't trigger barge-in,
    /// and any half-finished sentence is discarded (the model's
    /// toggleVoiceMute owns all of that; this is only its face).
    /// GUS can still speak while muted; unmuting resumes
    /// listening. In 0.9.8 this sat in the composer at text
    /// size and Glenn couldn't spot it mid-call, dogs barking —
    /// so now it lives in the in-call strip, large, labeled in
    /// words ("Mute" / "Unmute", never icon-only), and red
    /// while muted: the mic being OFF is the state the operator
    /// must be able to see at a glance, from across the room.
    private var muteButton: some View {
        Group {
            if model.voiceMuted {
                Button {
                    model.toggleVoiceMute()
                } label: {
                    Label("Unmute", systemImage: "mic.slash.fill")
                        .font(.headline)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(.red)
                .help("Unmute — start listening again")
            } else {
                Button {
                    model.toggleVoiceMute()
                } label: {
                    Label("Mute", systemImage: "mic.fill")
                        .font(.headline)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .help("Mute — GUS hears nothing until you unmute. For the dog barking, the doorbell, the side conversation.")
            }
        }
    }

    /// The Shield chip (v0.9.11): the call's Shield mode for
    /// spoken turns, from the session state — "Shield: fast
    /// scan" when the switch is on (voice scans run the gate's
    /// fast mode; typed messages still get the full review),
    /// "Shield: OFF" when the switch is off and spoken turns
    /// become jobs without the ingress scan. OFF is red, the
    /// same glance-language as the muted Mute button beside
    /// it: the state that changes what guards the call must be
    /// the state you can see from across the room.
    private func shieldChip(_ mode: String) -> some View {
        Group {
            if mode == "off" {
                Label("Shield: OFF", systemImage: "shield.slash")
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundColor(.red)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Color.red.opacity(0.15)))
                    .help("Shield scan is OFF for voice — spoken turns become jobs without the ingress scan (Settings → Voice). Typed messages are always scanned.")
            } else {
                Label("Shield: fast scan", systemImage: "shield.fill")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Color.secondary.opacity(0.15)))
                    .help("Shield scan is ON for voice, in fast mode — deterministic patterns, in about a second. Typed messages get the full semantic review.")
            }
        }
    }

    /// The in-call strip: phase, elapsed time, and the last
    /// turn's measured latency — small, factual, and read from
    /// the session state, never estimated here. v0.9.2 adds the
    /// hearing line under it: the server's levels for what the
    /// call is receiving, next to this app's own mic level.
    private var callStatusStrip: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 10) {
                Image(systemName: "waveform")
                    .foregroundColor(.red)
                Text(model.voicePhase == "thinking" ? "Thinking…" : model.voicePhase == "speaking" ? "Speaking…" : "Listening…")
                    .font(.callout)
                Text(Self.callClock(model.voiceElapsedMs))
                    .font(.callout)
                    .foregroundColor(.secondary)
                if let latency = model.voiceLatencyLine {
                    Text(latency)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                // v0.9.11: the Shield state, in the open — the
                // operator kept having to dig through Settings
                // mid-call to learn which way the voice
                // Shield-scan switch sat, so it sits here now,
                // next to Mute, read from the session state the
                // strip already polls. Absent from an older
                // control plane: no chip, exactly as before.
                if let shieldMode = model.voiceShieldMode {
                    shieldChip(shieldMode)
                }
                // v0.9.9: the prominent Mute lives here, in the
                // strip that only exists while a call is open —
                // big, labeled, and impossible to miss mid-call.
                muteButton
            }
            if let hearing = model.voiceHearingLine {
                Text(hearing)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private static func callClock(_ ms: Double) -> String {
        let total = Int(ms / 1000)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// One pending approval as a native card: what will happen, why it
/// parked, when the park expires, and the two resolutions. Shared
/// by the chat view (inline) and the sidebar queue — the buttons
/// call the same panel endpoint either way, and a resolution here
/// resolves it everywhere.
struct ApprovalCardView: View {
    @ObservedObject var model: DesktopModel
    let approval: PanelApproval

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("⏸ Parked — \(approval.summary)")
                .font(.callout)
                .fontWeight(.semibold)
            Text("Why: \(approval.reason) · No answer by \(GusFormat.time(approval.expiresAt)) counts as a denial.")
                .font(.caption)
                .foregroundColor(.secondary)
            HStack(spacing: 8) {
                Button("✅ Approve — exactly this") { model.resolve(approval, approve: true) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                Button("🚫 Deny") { model.resolve(approval, approve: false) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.orange.opacity(0.10))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.orange.opacity(0.35), lineWidth: 1)
        )
    }
}
