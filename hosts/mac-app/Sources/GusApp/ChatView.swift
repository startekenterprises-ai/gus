import SwiftUI

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
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if model.chatMessages.isEmpty && model.chatJobs.isEmpty && model.voiceExchanges.isEmpty {
                        Text("No messages yet. Say hello — or give GUS a job.")
                            .foregroundColor(.secondary)
                            .padding(.top, 8)
                    }
                    ForEach(Array(model.chatMessages.enumerated()), id: \.offset) { _, message in
                        messageBubble(message)
                    }
                    ForEach(Array(model.voiceExchanges.enumerated()), id: \.offset) { _, message in
                        messageBubble(message)
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
            .onChange(of: model.voiceExchanges.count) { _, _ in
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
            callButton
        }
        .padding(12)
    }

    /// Call GUS (v0.9): push-to-talk. The transcript the service
    /// hears becomes a normal job (same scan, caps, receipts), the
    /// answer comes back spoken. While a job is parked, the call
    /// is how you answer it: the read-back names the exact phrases
    /// ("confirm" / "yes, do it" / "no") that count.
    private var callButton: some View {
        Group {
            switch model.voiceState {
            case .idle:
                Button {
                    model.toggleVoiceCall()
                } label: {
                    Label("Call", systemImage: "phone.fill")
                }
                .buttonStyle(.bordered)
                .help("Call GUS — talk instead of typing. Nothing listens until you tap; the words go through the same pipeline as a typed message.")
            case .recording:
                Button {
                    model.toggleVoiceCall()
                } label: {
                    Label("Stop & Send", systemImage: "stop.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .help("Stop recording and send what you said")
            case .thinking:
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.small)
                    Text("GUS is answering…")
                        .font(.callout)
                        .foregroundColor(.secondary)
                }
                .help("Transcribing, running, and speaking the reply — a real job sits behind this call")
            }
        }
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
