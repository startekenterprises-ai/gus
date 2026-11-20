import AppKit
import AVFoundation
import SwiftUI

/// The right sidebar (v0.10.1): three tabs, where the pre-tab
/// sidebar stacked identity over approvals over history in one
/// long scroll —
///
///   Activity  — what GUS has been doing: the jobs feed.
///   Approvals — the parked queue as Approve/Deny cards, with
///               the resolution history beneath (the sidebar's
///               original centerpiece; every history entry
///               carries its job id, traceable to the job's
///               settlement receipt in the Jobs view).
///   Identity  — who this GUS is: the customizable avatar and
///               name, live status, the Memory summary, and
///               the voice picker.
///
/// v0.11.0: the avatar + name live in a FIXED HEADER above the
/// tabs (the Muse app's arrangement), so who this GUS is
/// stays visible on every tab; the Identity tab keeps the
/// editors (photo, name, voice) that change them.
///
/// Nothing here is a second source of truth: every tab renders
/// the model's polled state, and the rail's Approvals section
/// still exists for the narrow window, where this sidebar
/// folds away.
struct SidebarView: View {
    @ObservedObject var model: DesktopModel
    @State private var tab: Tab = .activity

    enum Tab {
        case activity, approvals, identity
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            identityHeader
            Divider()
            tabBar
            Divider()
            switch tab {
            case .activity:
                ActivityTabView(model: model)
            case .approvals:
                ApprovalsTabView(model: model)
            case .identity:
                IdentityTabView(model: model)
            }
        }
        .frame(width: 300)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    /// The fixed identity header (v0.11.0): the avatar and the
    /// display name, pinned above the tabs so identity never
    /// vanishes when the operator switches to Activity or
    /// Approvals — the v0.10.1 layout kept both inside the
    /// Identity tab alone, and switching tabs lost them. The
    /// status line rides under the name (it is identity too:
    /// running, mode, spend). Editing stays in the Identity
    /// tab; this header only shows.
    /// v0.14.0: the header goes VERTICAL and the avatar goes
    /// prominent (~76 pt, centered) — who this GUS is leads
    /// the sidebar instead of riding in its corner, and the
    /// avatar's animation state (DesktopModel.avatarState)
    /// says what GUS is doing at a glance.
    private var identityHeader: some View {
        VStack(spacing: 5) {
            // v0.11.1: the model's display avatar — the custom
            // photo when set, else the bundled GUS character
            // (through v0.11.0 the bare app icon stood here).
            // v0.12.0: it breathes — see AnimatedAvatarView.
            AnimatedAvatarView(
                image: model.displayAvatarImage,
                size: 76,
                state: model.avatarState
            )
            Text(model.displayName)
                .font(.title3)
                .fontWeight(.semibold)
                .lineLimit(1)
            Text(model.statusLine)
                .font(.caption2)
                .foregroundColor(model.status?.killed == true ? .red : .secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .help("This GUS — the avatar and name from the Identity tab, pinned here so they stay visible on every tab.")
    }

    private var tabBar: some View {
        HStack(spacing: 4) {
            tabButton(.activity, symbol: "clock.arrow.circlepath", label: "Activity",
                      help: "Activity — what GUS has been doing: every job, its state, its cost, and how it ended.")
            tabButton(.approvals, symbol: "doc.text", label: "Approvals",
                      badge: model.approvals.count,
                      help: "Approvals — consequential actions parked for your yes or no, and the history of how they were resolved. The badge counts what's waiting.")
            tabButton(.identity, symbol: "person.crop.circle", label: "Identity",
                      help: "Identity — this GUS's avatar, name, status, memory, and voice. The avatar and name are yours to change.")
        }
        .padding(8)
    }

    private func tabButton(_ target: Tab, symbol: String, label: String, badge: Int = 0, help: String) -> some View {
        Button {
            tab = target
        } label: {
            VStack(spacing: 3) {
                Image(systemName: symbol)
                    .font(.system(size: 15))
                    .overlay(alignment: .topTrailing) {
                        if badge > 0 {
                            Text("\(badge)")
                                .font(.caption2)
                                .fontWeight(.bold)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(Color.orange))
                                .foregroundColor(.white)
                                .offset(x: 10, y: -6)
                        }
                    }
                Text(label)
                    .font(.caption2)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(tab == target ? Color.accentColor.opacity(0.20) : Color.clear)
            )
            .foregroundColor(tab == target ? .accentColor : .secondary)
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(label)
    }
}

/// Activity (v0.10.1): the jobs feed, sidebar-width — the
/// same records the Jobs section lists full-width (kind,
/// state, cost, outcome), compacted for a glance. Read-only,
/// like the section: jobs are started from chat, Telegram,
/// voice, and schedules, never from a feed.
struct ActivityTabView: View {
    @ObservedObject var model: DesktopModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                Text("Activity")
                    .font(.headline)
                    .padding(.bottom, 2)
                if model.jobs.isEmpty {
                    Text(model.reachable
                        ? "No jobs yet. Jobs you start from chat, Telegram, voice, or a schedule land here."
                        : "The panel isn't reachable yet — activity appears when the control plane responds.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    ForEach(model.jobs) { job in
                        activityRow(job)
                        Divider()
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func activityRow(_ job: PanelJob) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(job.kind)
                    .font(.callout)
                    .fontWeight(.semibold)
                Text(job.state)
                    .font(.caption2)
                    .fontWeight(.medium)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(stateColor(job.state).opacity(0.20)))
                    .foregroundColor(stateColor(job.state))
                Spacer()
                Text(GusFormat.usd(job.costUsd))
                    .font(.caption)
                    .fontWeight(.medium)
            }
            if let note = job.outcomeNote {
                Text(note)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
            }
            Text(GusFormat.time(job.createdAt))
                .font(.caption2)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
    }

    private func stateColor(_ state: String) -> Color {
        switch state {
        case "verified-done": return .green
        case "failed-loudly": return .red
        case "needs-approval": return .orange
        case "running": return .blue
        default: return .secondary
        }
    }
}

/// Approvals (v0.10.1): the sidebar's original centerpiece,
/// now its own tab — the pending queue as native Approve/Deny
/// cards (the shared ApprovalCardView, so a resolution here
/// resolves everywhere), with the resolution history beneath.
struct ApprovalsTabView: View {
    @ObservedObject var model: DesktopModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                approvalsSection
                historySection
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var approvalsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Approvals")
                    .font(.headline)
                if !model.approvals.isEmpty {
                    Text("\(model.approvals.count)")
                        .font(.caption)
                        .fontWeight(.bold)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.orange.opacity(0.25)))
                }
            }
            if model.approvals.isEmpty {
                Text("Nothing parked. Consequential actions appear here — naming the exact action — before they run.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                ForEach(model.approvals) { approval in
                    ApprovalCardView(model: model, approval: approval)
                }
            }
        }
    }

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("History")
                .font(.headline)
            if model.approvalsHistory.isEmpty {
                Text("No resolutions yet.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                ForEach(model.approvalsHistory) { entry in
                    historyRow(entry)
                }
            }
        }
    }

    private func historyRow(_ entry: PanelApprovalHistoryEntry) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(historySymbol(entry.status))
                .font(.callout)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.summary)
                    .font(.callout)
                Text(historyDetail(entry))
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func historySymbol(_ status: String) -> String {
        switch status {
        case "approved", "consumed": return "✅"
        case "denied": return "🚫"
        case "expired": return "⌛"
        default: return "•"
        }
    }

    private func historyDetail(_ entry: PanelApprovalHistoryEntry) -> String {
        var parts = [entry.status]
        if let by = entry.resolvedBy { parts.append("by \(by)") }
        if let at = entry.resolvedAt { parts.append(GusFormat.time(at)) }
        parts.append("job \(entry.jobId)")
        return parts.joined(separator: " · ")
    }
}

/// Identity (v0.10.1): who this GUS is — and the operator's
/// to shape. The avatar and display name themselves live in
/// the sidebar's fixed header now (v0.11.0 — visible on every
/// tab); this tab carries the EDITORS: the photo buttons, the
/// name field, live status, the voice pickers, and the Memory
/// summary (the v0.10 context pack's status, read from the
/// panel — files present, pending candidates, quarantines).
/// The customizations persist on this Mac (the name in the
/// app's preferences, the photo as a PNG in the app's state
/// dir — see DesktopModel's identity section).
///
/// The voice pickers: the endpoint engine's picker writes
/// through the panel's own voice settings — the same file
/// Settings → Voice edits — and offers the Kokoro list. The
/// built-in engine's picker (v0.11.0) lists the voices
/// installed on this Mac and is app-side (see
/// DesktopModel.localTtsVoiceId): the built-in synthesizer
/// speaks with the chosen voice, in calls and tests alike.
struct IdentityTabView: View {
    @ObservedObject var model: DesktopModel
    @State private var nameDraft = ""
    /// v0.14.0: the "Make me an avatar" sheet's visibility.
    @State private var makeAvatarPresented = false
    /// v0.11.1: the built-in voice picker's language filter —
    /// the same UserDefaults key Settings → Voice binds, so
    /// the two pickers filter identically.
    @AppStorage("gus.localTtsVoiceLanguage") private var localVoiceLanguage = "en"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                avatarEditor
                nameEditor
                statusBlock
                Divider()
                voiceBlock
                Divider()
                memoryBlock
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear { nameDraft = model.displayName }
    }

    // MARK: Avatar + name

    /// The avatar editor: the picture itself is in the fixed
    /// header above the tabs now; what lives here is changing
    /// it. (Through v0.10.1 this block also carried the big
    /// round display — it moved, it wasn't duplicated.)
    private var avatarEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Avatar")
                .font(.headline)
            Text("Shown in the header above these tabs, on every tab. Until you choose a photo, the built-in GUS avatar stands in; a chosen photo is kept as a copy in the app's state folder.")
                .font(.caption)
                .foregroundColor(.secondary)
            HStack(spacing: 8) {
                Button("Change photo…") { model.chooseAvatarImage() }
                    .help("Change the avatar — pick any image on this Mac. A copy is kept in the app's state folder and shown round-cropped in the header.")
                // v0.14.0: GUS can make one, as an ordinary job.
                Button("Make me an avatar…") { makeAvatarPresented = true }
                    .help("Ask GUS to create an avatar from your description — an ordinary job; the finished image lands in the avatar slot and the header picks it up.")
                if model.hasCustomAvatar {
                    Button("Reset") { model.resetAvatar() }
                        .help("Reset the avatar — remove your photo and go back to the built-in GUS avatar.")
                }
            }
            .controlSize(.small)
            .sheet(isPresented: $makeAvatarPresented) {
                MakeAvatarView(model: model)
            }
        }
    }

    private var nameEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Name")
                .font(.headline)
            HStack(spacing: 8) {
                TextField("GUS", text: $nameDraft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { model.setDisplayName(nameDraft) }
                    .help("The name shown under the avatar and wherever the app names your agent. Stored on this Mac only — GUS has no accounts for it to be an account name.")
                Button("Save") { model.setDisplayName(nameDraft) }
                    .disabled(nameDraft.trimmingCharacters(in: .whitespacesAndNewlines) == model.displayName)
                    .help("Save the name — it takes the avatar's caption and the chat speaker label with it.")
            }
        }
    }

    private var statusBlock: some View {
        VStack(spacing: 4) {
            Text(model.statusLine)
                .font(.caption)
                .foregroundColor(model.status?.killed == true ? .red : .secondary)
                .multilineTextAlignment(.center)
            if let version = model.status?.version {
                Text("v\(version)")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: Voice

    private var voiceBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Voice")
                .font(.headline)
            if let v = model.voiceSettings {
                if (v.ttsEngine ?? "local") == "endpoint" {
                    Picker("Spoken voice", selection: voiceSelection) {
                        ForEach(voiceOptions(current: v.ttsVoice), id: \.self) { name in
                            Text(name).tag(name)
                        }
                    }
                    .help("The voice GUS speaks with on calls — a Kokoro voice on your speech endpoint. Saved to the same voice settings Settings → Voice edits, and takes effect on the next call.")
                    Text("Kokoro voices on your speech endpoint (\(v.ttsModel.isEmpty ? "kokoro" : v.ttsModel)). The same setting Settings → Voice edits — one file, two doors.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    // v0.11.0: the built-in engine HAS a picker
                    // now — the voices installed on this Mac,
                    // enumerated live, with the Mac's default as
                    // the first entry. The choice is app-side
                    // (DesktopModel.localTtsVoiceId) and the
                    // built-in synthesizer actually speaks with
                    // it; through v0.10.1 this spot honestly
                    // offered nothing, because the setting
                    // wasn't wired to anything audible.
                    // v0.11.1: a language filter above the
                    // picker (default English, remembered) —
                    // the unfiltered list was every language and
                    // country variant on the Mac, a junk drawer;
                    // within a language the premium/enhanced
                    // voices sort first and say so.
                    Picker("Voice language", selection: voiceLanguageSelection) {
                        ForEach(DesktopModel.speechVoiceLanguages, id: \.self) { code in
                            Text(DesktopModel.languageDisplayName(code)).tag(code)
                        }
                    }
                    .help("Filter the built-in voice list to one language — the Mac's voices for every other language stay installed, just out of this list. The same filter as Settings → Voice.")
                    Picker("Built-in voice", selection: localVoiceSelection) {
                        Text("Mac default voice").tag("")
                        ForEach(DesktopModel.pickerVoices(forLanguage: voiceLanguageSelection.wrappedValue, selectedId: model.localTtsVoiceId), id: \.identifier) { voice in
                            Text(localVoiceLabel(voice)).tag(voice.identifier)
                        }
                    }
                    .help("The voice built-in speech uses — one of the voices installed on this Mac (download more in System Settings → Accessibility → Spoken Content). Premium and Enhanced voices sort first. Takes effect on the next spoken sentence.")
                    HStack(spacing: 8) {
                        Button("Test voice") { model.testLocalVoice() }
                            .controlSize(.small)
                            .help("Hear the selected built-in voice speak one test sentence — the same synthesizer a call uses.")
                        Button("Open Settings → Voice") {
                            // v0.14.0: deep-link — the section
                            // userInfo preselects the Voice pane.
                            NotificationCenter.default.post(
                                name: .gusOpenSettings, object: nil,
                                userInfo: ["section": SettingsSection.voice.rawValue])
                        }
                        .controlSize(.small)
                        .help("Open Settings at the Voice pane — it chooses the speech engine (built-in, or your endpoint) and carries this same built-in voice picker.")
                    }
                    Text("The voices installed on this Mac. The same choice as Settings → Voice — one setting, two doors.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            } else {
                Text("Voice settings appear when the control plane responds.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }

    private var voiceSelection: Binding<String> {
        Binding(
            get: {
                let current = model.voiceSettings?.ttsVoice ?? ""
                return current.isEmpty ? "af_heart" : current
            },
            set: { model.setTtsVoice($0) }
        )
    }

    /// The built-in voice picker's binding: the model's
    /// app-side choice ("" = the Mac's default voice).
    private var localVoiceSelection: Binding<String> {
        Binding(
            get: { model.localTtsVoiceId },
            set: { model.setLocalTtsVoice($0) }
        )
    }

    /// The language filter's binding (v0.11.1): the stored
    /// choice when voices exist for it, else English when
    /// present, else the first language on offer — the
    /// selector never points at a language with no voices.
    private var voiceLanguageSelection: Binding<String> {
        Binding(
            get: {
                let languages = DesktopModel.speechVoiceLanguages
                if languages.contains(localVoiceLanguage) { return localVoiceLanguage }
                return languages.contains("en") ? "en" : (languages.first ?? "en")
            },
            set: { localVoiceLanguage = $0 }
        )
    }

    /// A voice row's label (v0.11.1): name + quality from the
    /// shared helper; a voice riding in from outside the
    /// filter (the saved pick, kept so the selection is never
    /// stranded) also names its language, so its presence in
    /// the list explains itself.
    private func localVoiceLabel(_ voice: AVSpeechSynthesisVoice) -> String {
        let label = DesktopModel.speechVoiceLabel(voice)
        if DesktopModel.primaryLanguage(of: voice) != voiceLanguageSelection.wrappedValue {
            return "\(label) (\(voice.language))"
        }
        return label
    }

    /// The Kokoro list, with the voice on file kept at the
    /// top when it isn't a standard name (a hand-set voice in
    /// Settings must not vanish from its own picker).
    private func voiceOptions(current: String) -> [String] {
        var options = DesktopModel.kokoroVoices
        if !current.isEmpty, !options.contains(current) {
            options.insert(current, at: 0)
        }
        return options
    }

    // MARK: Memory

    private var memoryBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Memory")
                .font(.headline)
            if let mem = model.memoryStatus {
                memoryRow("Context pack", mem.enabled ? "On" : "Off")
                memoryRow("Files present", "\(mem.files.filter { $0.exists }.count) of \(mem.files.count)")
                memoryRow("Pending candidates", "\(mem.pendingCandidates)")
                if !mem.quarantinedSections.isEmpty {
                    Text("Quarantined by the secret-guard: \(mem.quarantinedSections.map(\.section).joined(separator: ", ")) — held out of every pack until the files are cleaned.")
                        .font(.caption)
                        .foregroundColor(.orange)
                }
                ForEach(mem.warnings, id: \.self) { warning in
                    Text(warning)
                        .font(.caption)
                        .foregroundColor(.orange)
                }
                Text("The pack is assembled from ~/.gus/state/context/ for each job and Shield-scanned before any model sees it. This release's memory is read-only: edit those files in a text editor. The write loop — GUS proposing candidates for you to promote — arrives in a later slice.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                Text("Memory status appears when the control plane responds.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }

    private func memoryRow(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
                .font(.callout)
            Spacer()
            Text(value)
                .font(.callout)
                .foregroundColor(.secondary)
        }
    }
}

/// Approvals as a full section (GUI polish, 2026-11-16): the
/// rail's document entry. The same records the right sidebar
/// carries — the pending queue as resolvable cards (the shared
/// ApprovalCardView, so a resolution here resolves everywhere)
/// and the resolution history beneath — widened to the content
/// column for when the operator wants the queue as the main
/// view, or the window is narrow and the sidebar is folded.
/// Nothing here is a second source of truth: it renders the
/// model's approvals and approvalsHistory, exactly like the
/// sidebar does.
struct ApprovalsView: View {
    @ObservedObject var model: DesktopModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Approvals")
                            .font(.headline)
                        if !model.approvals.isEmpty {
                            Text("\(model.approvals.count)")
                                .font(.caption)
                                .fontWeight(.bold)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(Color.orange.opacity(0.25)))
                        }
                    }
                    if model.approvals.isEmpty {
                        Text("Nothing parked. Consequential actions appear here — naming the exact action — before they run.")
                            .font(.callout)
                            .foregroundColor(.secondary)
                    } else {
                        ForEach(model.approvals) { approval in
                            ApprovalCardView(model: model, approval: approval)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("History")
                        .font(.headline)
                    if model.approvalsHistory.isEmpty {
                        Text("No resolutions yet.")
                            .font(.callout)
                            .foregroundColor(.secondary)
                    } else {
                        ForEach(model.approvalsHistory) { entry in
                            historyRow(entry)
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func historyRow(_ entry: PanelApprovalHistoryEntry) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(historySymbol(entry.status))
                .font(.callout)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.summary)
                    .font(.callout)
                Text(historyDetail(entry))
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func historySymbol(_ status: String) -> String {
        switch status {
        case "approved", "consumed": return "✅"
        case "denied": return "🚫"
        case "expired": return "⌛"
        default: return "•"
        }
    }

    private func historyDetail(_ entry: PanelApprovalHistoryEntry) -> String {
        var parts = [entry.status]
        if let by = entry.resolvedBy { parts.append("by \(by)") }
        if let at = entry.resolvedAt { parts.append(GusFormat.time(at)) }
        parts.append("job \(entry.jobId)")
        return parts.joined(separator: " · ")
    }
}

/// What the header avatar is doing (v0.14.0) — derived by
/// DesktopModel.avatarState from the polled state (a parked
/// approval, a call's phase, a running job), never set by a
/// view. Each case carries its own breathing tempo, peak
/// scale, and glow in AnimatedAvatarView below.
enum AvatarState {
    case idle, listening, thinking, speaking, working, needsApproval
}

/// The header avatar, alive (v0.12.0): a gentle breathing
/// scale and a soft glow pulse on the operator's avatar —
/// the bundled GUS character or their custom image, animated
/// as-is (the artwork is never redrawn). The motion is pure
/// transform + shadow on an already-rendered image, animated
/// by the render server: no timers, no per-frame CPU at rest
/// beyond the compositor's slow ambient loop. While a voice
/// call is speaking the pulse strengthens and quickens — the
/// header shows the call's life without a word of UI. Reduce
/// Motion (System Settings → Accessibility) stills it
/// completely: same avatar, no animation, no glow swell.
///
/// v0.14.0: the animation is STATE-driven (AvatarState) and
/// the view takes a size — the sidebar header shows it
/// prominent at ~76 pt. needsApproval pulses fast in orange
/// so a parked approval is visible from across the room; the
/// rest are tempos and tints on the same breathing mechanism.
/// A state change re-arms the animation (onChange below), so
/// the new tempo starts now instead of at the old cycle's end.
struct AnimatedAvatarView: View {
    let image: NSImage
    var size: CGFloat = 38
    var state: AvatarState = .idle
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    /// One state's animation shape: breathing duration, peak
    /// scale, glow color, glow opacity (and, for thinking, a
    /// larger glow radius — a slower, wider thought).
    private var shape: (duration: Double, scale: CGFloat, color: Color, opacity: Double, radius: CGFloat) {
        switch state {
        case .idle: return (2.6, 1.03, .accentColor, 0.35, 6)
        case .listening: return (1.6, 1.04, .green, 0.4, 7)
        case .thinking: return (3.2, 1.03, .accentColor, 0.5, 11)
        case .speaking: return (0.85, 1.06, .accentColor, 0.55, 9)
        case .working: return (1.8, 1.02, .blue, 0.4, 6)
        case .needsApproval: return (0.9, 1.04, .orange, 0.6, 9)
        }
    }

    var body: some View {
        let animated = !reduceMotion
        Image(nsImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: size, height: size)
            .clipShape(Circle())
            .overlay(Circle().stroke(Color.secondary.opacity(0.35), lineWidth: 1))
            .scaleEffect(animated && breathing ? shape.scale : 1.0)
            .shadow(
                color: shape.color.opacity(animated && breathing ? shape.opacity : 0.15),
                radius: animated && breathing ? shape.radius : 3
            )
            .animation(
                animated
                    ? .easeInOut(duration: shape.duration).repeatForever(autoreverses: true)
                    : nil,
                value: breathing
            )
            .onAppear { breathing = animated }
            .onChange(of: reduceMotion) { _, reduced in
                breathing = !reduced
            }
            .onChange(of: state) { _, _ in
                // Re-arm under the new state's tempo: drop to
                // rest, then breathe again — the .animation
                // above is re-read with the new duration.
                breathing = false
                if animated { breathing = true }
            }
    }
}

/// "Make me an avatar" (v0.14.0): the Identity tab's sheet.
/// Honest shape: GUS makes the avatar as an ordinary job —
/// the operator describes it, DesktopModel.requestAvatar
/// posts the request to chat, and the finished image must
/// land in the desktop avatar slot
/// (~/.gus/state/desktop/avatar.png), which the header picks
/// up on its own when the file changes. A photo always works
/// as the fallback, and the sheet says all of that in words
/// rather than promising magic.
struct MakeAvatarView: View {
    @ObservedObject var model: DesktopModel
    @Environment(\.dismiss) private var dismiss
    @State private var description = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Make me an avatar")
                .font(.title3)
                .fontWeight(.semibold)
            Text("Describe the avatar you want, and GUS works on it as an ordinary job — scanned, capped, and receipted like any other. When the finished image lands in the desktop avatar slot (~/.gus/state/desktop/avatar.png), the header picks it up automatically. If GUS can't produce one, a photo always works.")
                .font(.callout)
                .foregroundColor(.secondary)
            TextField("e.g. a calm brass robot owl, face-forward, deep navy background", text: $description)
                .textFieldStyle(.roundedBorder)
                .onSubmit { askGus() }
            HStack {
                Button("Use a photo instead…") {
                    model.chooseAvatarImage()
                    dismiss()
                }
                .help("Skip the job — pick any image on this Mac as the avatar, the way Change photo always has.")
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Ask GUS to create it") { askGus() }
                    .buttonStyle(.borderedProminent)
                    .disabled(description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .help("Send the request as a chat job — GUS creates the image and saves the final PNG into the avatar slot.")
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    private func askGus() {
        model.requestAvatar(description: description)
        dismiss()
    }
}
