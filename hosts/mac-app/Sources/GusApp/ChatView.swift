import SwiftUI

/// THE Call button — one view, one source of truth, and the
/// ONLY Call button in the app. It lives in the window's top
/// bar, next to Invite (GUI polish, 2026-11-16 — the operator's
/// layout call, matching the Muse app's arrangement). History:
/// through 0.9.8 the top bar carried a second copy; v0.9.9
/// removed it and kept the composer's, because two working
/// Call buttons confused more than they helped. That rule —
/// exactly one — still stands; only the seat changed, and the
/// composer's copy is gone. The label, the icon, the action,
/// and the (absence of a) disabled condition live here and
/// nowhere else. In a call the button is End Call (the
/// hang-up); out of one it is Call (the preflight + session
/// start, in the model). There is no state in which it is
/// disabled: a call that can't start says why in the notice
/// rather than greying the button. The in-call strip (Mute,
/// Shield chip) is unaffected — it still renders in ChatView
/// while a call is open.
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
/// operator's messages and GUS's delivered replies — the
/// CONVERSATION, and (v0.12.0) only the conversation. Through
/// v0.11.1 the transcript also carried a status line per job and
/// the secure log sat in a block under it; Glenn's verdict was
/// that the two together flooded the chat and taxed the window.
/// Both are gone from here: per-job settlement lines no longer
/// render as transcript entries, and the secure log lives in
/// the Jobs section at full size. What remains is ONE slim
/// live-status strip above the composer carrying the newest
/// log line. v0.14.5 (the operator's call): tapping the strip
/// expands the log IN PLACE as a bounded panel — the same
/// SecureLogView, filters and all, in a hard-capped slot above
/// the composer; the Jobs section keeps the full-size log and
/// gains export.
/// Submitting goes through POST /api/chat — the panel-chat
/// channel adapter — so a message from this window is scanned,
/// classified, capped, and receipted exactly like one from
/// Telegram. Pending approvals for chat jobs appear as cards
/// above the composer and resolve through the same panel
/// endpoints as every other surface.
struct ChatView: View {
    @ObservedObject var model: DesktopModel
    @FocusState private var composerFocused: Bool
    /// The live-status strip's visibility — one UserDefaults
    /// switch (default ON: security-first, the record is the
    /// product). The key predates the strip: through v0.11.1 it
    /// bound the in-chat secure log, and the operator's choice
    /// carries over rather than resetting. The same switch
    /// lives in the Jobs log's header and in Settings →
    /// General. Hiding never stops the recording; it only
    /// closes the window onto it.
    @AppStorage("gus.secureLogVisible") private var secureLogVisible = true
    /// v0.14.5: the strip expands in place into the bounded
    /// log panel (the operator's call: the log visible from
    /// chat again, but never the whole page). Session state,
    /// not a setting — every launch starts collapsed, on the
    /// one-line strip.
    @State private var logPanelExpanded = false

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
            // v0.43.0: the persona strip — who is on, at the
            // top of the conversation, and the picker
            // itself (PersonaViews.swift): the active
            // persona's face ringed, a tap away from
            // switching. The same component the Identity
            // tab hosts in full; here it rides compact.
            PersonaStripView(model: model, compact: true)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
            Divider()
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
            if secureLogVisible {
                Divider()
                liveStatusStrip
                if logPanelExpanded {
                    Divider()
                    // v0.14.5: the secure log in chat, bounded:
                    // the SAME SecureLogView the Jobs section
                    // hosts (one log store, one filter model —
                    // including the Caught & stopped demo chip),
                    // in a hard-capped slot: header + a 190pt
                    // list ≈ a third of the window, never the
                    // whole page, its own scroll inside.
                    SecureLogView(model: model, expands: false, boundedHeight: 190)
                }
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

    /// The live-status strip (v0.12.0): ONE line above the
    /// composer carrying the newest entry of the secure log —
    /// flagged lines read orange, as they do in the log itself.
    /// Before anything is recorded it falls back to the newest
    /// job in this conversation, then to a plain statement that
    /// the recording is on. v0.14.5: tapping toggles the
    /// bounded in-chat log panel (see the body) — the full
    /// secure log still lives in the Jobs section, with export.
    /// Collapsed, this strip is still one line, one render —
    /// the performance shape v0.12.0 bought stays bought.
    private var liveStatusStrip: some View {
        Button {
            logPanelExpanded.toggle()
        } label: {
            HStack(spacing: 8) {
                Circle()
                    .fill(model.reachable ? Color.green : Color.secondary)
                    .frame(width: 7, height: 7)
                if let entry = model.timeline.first {
                    Text(entry.line)
                        .font(.caption)
                        .foregroundColor(entry.isFlagged ? .orange : .secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 8)
                    Text(GusFormat.time(entry.ts))
                        .font(.caption2)
                        .foregroundColor(.secondary)
                } else if let job = model.chatJobs.last {
                    Text("job \(job.kind) · \(job.state)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 8)
                    Text(GusFormat.time(job.createdAt))
                        .font(.caption2)
                        .foregroundColor(.secondary)
                } else {
                    Text("Live — scans, approvals, and actions are recorded as they happen.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                }
                Image(systemName: logPanelExpanded ? "chevron.down" : "chevron.up")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(Color(nsColor: .controlBackgroundColor))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("The newest line of the secure log. Tap to expand the log right here — bounded, with the same filters as the Jobs section's full log, which also lives there with export. Hide this strip in Settings → General.")
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if model.chatMessages.isEmpty && model.voiceTurns.isEmpty {
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
        }
    }

    private func messageBubble(_ message: PanelChatMessage) -> some View {
        let mine = message.direction == "in"
        return HStack {
            if mine { Spacer(minLength: 60) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
                Text(mine ? "You" : model.displayName)
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

    // MARK: Composer

    /// The composer (GUI polish, 2026-11-16 — the layout
    /// target's arrangement): text field, a mic button, and a
    /// circular up-arrow send. The Call button that sat here
    /// through v0.9.11 moved to the top bar (see
    /// VoiceCallButton); the mic dictates into the composer
    /// through the model's built-in ears, and Send is the same
    /// sendComposer action the "Send" text button always ran —
    /// only its face changed: an arrow in a filled circle,
    /// greyed while the composer holds nothing sendable.
    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Message", text: $model.composerText)
                .textFieldStyle(.roundedBorder)
                .focused($composerFocused)
                .onSubmit { model.sendComposer() }
            micButton
            sendButton
        }
        .padding(12)
    }

    private var canSend: Bool {
        !model.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var sendButton: some View {
        Button { model.sendComposer() } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 14, weight: .semibold))
                .frame(width: 28, height: 28)
                .background(Circle().fill(canSend ? Color.accentColor : Color.secondary.opacity(0.25)))
                .foregroundColor(.white)
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .help("Send — the message goes through the same scan, caps, and receipts as any channel")
    }

    /// The dictation mic: tap to talk, tap again to stop. Red
    /// while a sitting is open (the app's recording language —
    /// the call strip's waveform and Mute read the same way).
    /// Disabled during a call, when the microphone is the
    /// call's; the model refuses then too, with the reason in
    /// the notice. Dictated words land in the composer as
    /// text — nothing is sent until Send.
    private var micButton: some View {
        Button { model.toggleComposerDictation() } label: {
            Image(systemName: model.dictating ? "mic.fill" : "mic")
                .font(.system(size: 15))
                .frame(width: 28, height: 28)
                .foregroundColor(model.dictating ? .red : .secondary)
        }
        .buttonStyle(.plain)
        .disabled(model.voiceInCall)
        .help(model.dictating
            ? "Stop dictating — the words in the composer stay"
            : "Dictate — talk and the words land in the composer (built-in speech recognition; nothing is sent until you press Send)")
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
                // v0.43.0: whose call this is — the persona
                // on, named in the strip, so the voice being
                // heard has its owner in view.
                if let persona = model.activePersona {
                    Text("with \(persona.name)")
                        .font(.callout)
                        .foregroundColor(.secondary)
                }
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
                    .help("Approve — run exactly this action, once. The approval is spent as it is used; anything different parks again for a fresh yes.")
                Button("🚫 Deny") { model.resolve(approval, approve: false) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Deny — this action never runs. The job settles as denied, with a receipt, and the resolution lands in the Approvals history.")
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
