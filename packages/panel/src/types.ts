/**
 * Panel data contract (foundation spec §§1.2/2.1) — Phase 4.
 *
 * The panel is a control-plane SURFACE, not a channel and never a
 * bypass: every action it offers is delegated to the same engines the
 * Telegram surface uses (the Approval Engine's hash-bound records, the
 * Governor's kill flag and ledger, the Vault Broker). This package
 * defines only the data shapes; the control plane implements them.
 * Nothing here can hold a secret value: vault data crosses this
 * contract as NAMES in one direction and as a one-way store call in
 * the other.
 */

export interface PanelStatusData {
  version: string;
  runtimeVersion?: string;
  /** v0.12.0: the resolved entitlement edition ("self-hosted"
   *  for every install today — the pivot §2.1 skeleton). Optional
   *  on the wire so older backends keep decoding; the control
   *  plane always sends it. */
  edition?: string;
  /** v0.13.0 (redo R1): the one GUS identity's id and its active
   *  provider kind. Optional on the wire like `edition`; the
   *  control plane always sends both. */
  identityId?: string;
  identityProvider?: string;
  killed: boolean;
  shield: {
    provisioned: boolean;
    required: boolean;
    /** The operator's recorded fail policy: "closed" | "open". */
    onUnavailable: string;
    baseUrl: string;
  };
  provider: { id: string; model: string };
  pendingApprovals: number;
  spendTodayUsd: number;
  spendMonthUsd: number;
  /** v0.4: the Governor mode + today's permissive let-throughs. */
  governorMode: "enforcing" | "permissive";
  /** v0.14.6: the budget profile in force (budget-profile.ts in
   *  the control plane) — scales the Governor's caps. Optional
   *  in the type (older backends omit it); the real backend
   *  always sends it. */
  budgetProfile?: "standard" | "generous" | "max" | "unlimited";
  permissiveToday: {
    count: number;
    recent: { ts: number; kind: string; detail: string }[];
  };
  /** v0.4.1: what's actually ON FILE — the saved-settings readout.
   *  Presence only: key state is stored/missing/not-required, never
   *  a value, here or anywhere else in the panel. */
  settings: {
    providerKey: "stored" | "missing" | "not-required";
    telegramConfigured: boolean;
    caps: { maxUsdPerTask?: number; maxUsdPerDay?: number; maxUsdPerMonth?: number };
    delegates: number;
    macWorkDirs: number;
    /** v0.5: the approval-delegation policy on file (approver-
     *  policy.ts in the control plane). It only takes effect while
     *  the Governor is permissive; the readout shows it either way. */
    approverPolicy: PanelApproverPolicyData;
    /** v0.9: the voice channel on file (voice.json in the control
     *  plane). Presence only, like everything in this readout:
     *  enabled + both endpoints set reads "configured"; the URLs
     *  themselves live behind /api/voice/settings. */
    voice: { enabled: boolean; configured: boolean };
  };
}

/** v0.5: approval delegation — who besides the operator may resolve
 *  a parked action, and within what scope. Mirrors ApproverPolicy in
 *  the control plane; all paths default OFF. */
export interface PanelApproverPolicyData {
  gusApprovesDelegates: boolean;
  gusApprovesOwn: boolean;
  delegatesMayApprove: boolean;
  scope: "bounded" | "all_except_floors";
  maxApprovalsPerHour: number;
}

export interface PanelLedgerData {
  /** Raw ledger entries (reserve/settle/refund), oldest first. */
  entries: Record<string, unknown>[];
  audit: {
    reserves: number;
    settles: number;
    refunds: number;
    openReservations: number;
    settledUsd: number;
    reconciles: boolean;
  };
  summary: {
    todayUsd: number;
    monthUsd: number;
    totalUsd: number;
    caps: Record<string, unknown>;
  };
}

export interface PanelShieldReceiptRef {
  receiptId: string;
  /** Public verification page for this receipt, when known. */
  verifyUrl?: string;
}

export interface PanelJobData {
  id: string;
  kind: string;
  state: string;
  createdAt: number;
  updatedAt: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  outcomeNote?: string;
  /** The settlement receipt id. "gus_rcpt_…" = local stub (Phase 0
   *  issuer, kept only where no Shield call applied); "rcpt_…" = a
   *  real, verifiable Agent-Shield receipt. */
  receiptId?: string;
  receiptVerifyUrl?: string;
  shieldReceipts: PanelShieldReceiptRef[];
}

export interface PanelApprovalData {
  id: string;
  jobId: string;
  /** Plain-language description of exactly what will happen. */
  summary: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

/** v0.7: a RESOLVED approval, for the desktop app's Approvals
 *  history (the web panel shows only the pending queue). Read-only:
 *  the same durable records the engine keeps; jobId ties the entry
 *  to its job — and through the job, to its settlement receipt. */
export interface PanelApprovalHistoryData {
  id: string;
  jobId: string;
  summary: string;
  reason: string;
  /** approved | denied | expired | consumed */
  status: string;
  createdAt: number;
  resolvedAt?: number;
  /** Who resolved it — the engine's own stamp, unedited: "panel",
   *  "channel-button", "channel-command", "timeout", "gus",
   *  "delegate:<name>", … */
  resolvedBy?: string;
}

/** v0.8: the Shield gate's operator policy, as written by the
 *  Settings surface (the wizard's shield step also lands here, via
 *  onboarding — it provisions the key and records required=true;
 *  this is the plain policy write: required + fail mode, no
 *  provisioning side effect). */
export interface PanelShieldPolicyData {
  required: boolean;
  /** "closed" | "open" — what happens when the Shield is unreachable. */
  onUnavailable: string;
}

export interface PanelDelegateEntryData {
  name: string;
  /** Channel-native sender id (a Telegram user id, as a string). */
  senderId: string;
}

export interface PanelDelegateConversationData {
  conversationId: string;
  operatorId: string;
  delegates: PanelDelegateEntryData[];
}

/** v0.8: the settings detail the status summary only counts — the
 *  Mac jail's actual contents and the named delegates, for the
 *  desktop app's Settings window. Read-only in this release:
 *  editing policy.json / delegates.json stays an operator file
 *  action, and the app says so rather than pretending otherwise. */
export interface PanelSettingsDetailData {
  macWorkDirs: string[];
  macShellAllowlist: string[];
  delegates: PanelDelegateConversationData[];
  /** The file-bridge binding, when one is configured. */
  bridge?: { conversationId: string; senderId: string };
}

/** v0.9: the voice channel's settings (voice.json in the control
 *  plane) — the operator's local speech services. Plain config, no
 *  secrets: the reference STT/TTS servers are unauthenticated on
 *  loopback, and a credential has no business in a settings file. */
export interface PanelVoiceSettingsData {
  enabled: boolean;
  /** v0.9.6: the transcription engine — "local" (built into the
   *  app) or "endpoint" (the URL below). Optional on the wire so
   *  older surfaces that omit it keep working; the config
   *  default is "local" and the control plane preserves the
   *  stored value on a save that doesn't mention it. */
  sttEngine?: string;
  /** OpenAI-compatible transcription base URL (faster-whisper). */
  sttBaseUrl: string;
  sttModel: string;
  /** v0.9.6: the speech engine — same rule as sttEngine. */
  ttsEngine?: string;
  /** OpenAI-compatible speech base URL (Kokoro-FastAPI). */
  ttsBaseUrl: string;
  ttsModel: string;
  ttsVoice: string;
  /** v0.9.1: barge-in for the live call — talking over a reply
   *  cuts its speech. Optional on the wire so older surfaces
   *  that omit it keep working; the config default is ON and
   *  the control plane preserves the stored value on a save
   *  that doesn't mention it. */
  bargeIn?: boolean;
  /** v0.9.9: the voice Shield-scan switch. ON (default): spoken
   *  turns cross the Agent-Shield ingress scan before becoming
   *  jobs. OFF: the voice channel's ingress scan is skipped
   *  (scan-skipped-by-operator, recorded per turn); every other
   *  channel and rule is unaffected. Optional on the wire, same
   *  preserve-on-omit rule as bargeIn. */
  shieldScan?: boolean;
  /** v0.15.6: the voice config's enginesChosen marker — true
   *  when a picker-presenting surface has saved the engines,
   *  making a stored "local" an explicit choice rather than
   *  the old shipped default. Read-only on this wire: the
   *  control plane derives it from whether a save's body
   *  carried engine values; surfaces never send it. */
  enginesChosen?: boolean;
  /** v0.17.2: the bundled Kokoro engine's status, present on
   *  the settings READ (never sent by surfaces): the
   *  supervisor's last known state, so Settings → Voice can
   *  show Downloading… / Ready / Unavailable + the reason
   *  under the engine picker. */
  bundled?: PanelBundledKokoroStatus;
}

/** v0.17.2: the bundled Kokoro engine's status as the control
 *  plane's supervisor reports it — one plain-language detail
 *  sentence is the contract; surfaces show it verbatim. */
export interface PanelBundledKokoroStatus {
  state: "stopped" | "starting" | "downloading" | "ready" | "unavailable";
  detail: string;
  progress: number | null;
  port: number;
  baseUrl: string;
}

/** v0.9.9: the answer to a Settings → Voice Test Connection
 *  press — the detailed endpoint probe (GET {base}/models on
 *  the CURRENT form values, unsaved), reported in full: whether
 *  the endpoint answered, the round-trip time, the models it
 *  lists, and whether the configured model is among them (null
 *  when the endpoint answered without a readable list — stated
 *  as unverifiable, never rounded up). `detail` is the same
 *  answer in one plain sentence for the pane to show. */
export interface PanelVoiceEndpointTestData {
  ok: boolean;
  reachable: boolean;
  latencyMs: number;
  models: string[];
  modelPresent: boolean | null;
  detail: string;
}

/** v0.9.9: the endpoint half of Test mic and speaker — one short
 *  test sentence synthesized by the CURRENT form's TTS endpoint
 *  values (unsaved), returned as playable audio. On failure ok
 *  is false and the detail names the service and the reason. */
export interface PanelVoiceTestSpeechData {
  ok: boolean;
  detail: string;
  audioBase64?: string;
  audioContentType?: string;
}

/** v0.9: one push-to-talk exchange. Audio crosses as base64 inside
 *  the JSON result (a spoken reply is ~100 KB — the frame route's
 *  raw bytes exist because frames are polled; a call is a single
 *  request/response, so JSON keeps one content type per route).
 *  On a TTS failure ok is false, the detail says why, AND the
 *  reply text still rides along — loud, never silently text-only. */
export interface PanelVoiceCallData {
  ok: boolean;
  /** reply | pending | stopped | approval-resolved |
   *  awaiting-confirmation | unavailable */
  kind: string;
  detail: string;
  transcript?: string;
  replyText?: string;
  audioBase64?: string;
  audioContentType?: string;
}

/** v0.9.1: one turn's stage timings in a live call — utterance
 *  end → transcript (sttMs) → reply (jobMs) → first spoken
 *  sentence (ttsFirstMs). The local-vs-cloud speech data; it
 *  lives in the session state and nowhere else.
 *  v0.9.8: jobMs is split further — queueMs (the turn chain's
 *  wait) plus the job's own shieldMs / modelMs / hops, measured
 *  in the control plane and delivered back with the reply. */
export interface PanelVoiceTurnLatencyData {
  utteranceEndAt: number;
  sttMs: number;
  queueMs?: number;
  jobMs: number;
  shieldMs?: number;
  /** v0.9.9: the ingress Shield scan was skipped for this turn
   *  at the operator's switch (scan-skipped-by-operator);
   *  shieldMs is 0 and this flag is what says why. */
  shieldSkipped?: boolean;
  modelMs?: number;
  hops?: number;
  ttsFirstMs?: number;
  totalMs: number;
}

/** v0.9.1: one settled turn of a live call, as the transcript
 *  record carries it. */
export interface PanelVoiceSessionTurnData {
  index: number;
  startedAt: number;
  transcript?: string;
  kind: string;
  detail: string;
  replyText?: string;
  /** Barge-in cut this reply's speech; the job was NOT stopped. */
  interrupted: boolean;
  latency?: PanelVoiceTurnLatencyData;
}

/** v0.9.2: the live call's hearing ledger — what the session's
 *  ears are receiving, in the VAD's own energy numbers: chunks
 *  in, last/peak level, the open utterance's age in ms (0 when
 *  none is open), and utterances completed. The diagnosis
 *  surface for a call that never takes a turn. */
export interface PanelVoiceSessionHearingData {
  chunksReceived: number;
  lastRms: number;
  maxRms: number;
  inUtteranceMs: number;
  utterancesCompleted: number;
}

/** v0.9.1: the live call's state — what the app polls while a
 *  call runs. Phase is listening | thinking | speaking | ended;
 *  an inactive state carries endedReason (operator |
 *  idle-timeout | max-length | kill-phrase | disabled) when the
 *  call ended on its own or was ended. */
export interface PanelVoiceSessionData {
  ok: boolean;
  detail: string;
  active: boolean;
  sessionId?: string;
  phase?: string;
  startedAt?: number;
  elapsedMs?: number;
  endedReason?: string;
  bargeIn?: boolean;
  /** v0.9.6: the call's resolved speech modes ("local" |
   *  "endpoint") after the call-start probe — the app runs its
   *  recognizer when sttMode is "local" and its synthesizer for
   *  text segments when ttsMode is "local". speechNotice carries
   *  the fallback notice when a mode fell back. */
  sttMode?: string;
  ttsMode?: string;
  speechNotice?: string;
  turns: PanelVoiceSessionTurnData[];
  lastLatency?: PanelVoiceTurnLatencyData;
  hearing?: PanelVoiceSessionHearingData;
  /** v0.9.4: the most recently finished call's snapshot, when
   *  this state isn't about it (see the voice session service). */
  lastSession?: PanelVoiceSessionData;
}

/** v0.9.1: one spoken segment of a live call's reply — a single
 *  sentence's audio, fetched in seq order by the app's playback
 *  queue. ok with no seq means nothing is ready yet. */
export interface PanelVoiceAudioSegmentData {
  ok: boolean;
  detail: string;
  seq?: number;
  turnIndex?: number;
  sentenceIndex?: number;
  audioBase64?: string;
  audioContentType?: string;
  /** v0.9.6: a speak-text segment (built-in TTS) — present
   *  instead of audioBase64; the app speaks it itself. */
  text?: string;
}

export interface PanelOnboardingStep {
  done: boolean;
  detail?: string;
}

export interface PanelOnboardingData {
  steps: {
    shield: PanelOnboardingStep;
    telegram: PanelOnboardingStep;
    provider: PanelOnboardingStep;
    caps: PanelOnboardingStep;
    firstJob: PanelOnboardingStep;
  };
  /** Pre-filled, editable starting points (plain numbers, USD). */
  suggestedCaps: { maxUsdPerTask: number; maxUsdPerDay: number; maxUsdPerMonth: number };
  currentProvider?: { provider: string; model: string; baseUrl?: string };
}

export interface PanelSkillData {
  name: string;
  verdict: string;
  installedAt: number;
}

/** v0.10 (Memory Slice A): the context pack's status — the files
 *  under context/ in the control plane's state dir, the pending
 *  memory-candidate count, and any warnings (a malformed
 *  context.json, a missing section file, a section quarantined by
 *  the secret-guard). Hashes and sizes only — file CONTENT crosses
 *  this contract solely through the preview below, which is the
 *  operator looking at their own files. */
export interface PanelMemoryFileData {
  name: string;
  exists: boolean;
  bytes: number;
  sha256?: string;
}

export interface PanelMemoryStatusData {
  enabled: boolean;
  files: PanelMemoryFileData[];
  pendingCandidates: number;
  quarantinedSections: { section: string; patternClasses: string[] }[];
  warnings: string[];
  lastEventTs?: number;
  config: { maxPackChars: number; maxDigestChars: number };
}

/** v0.10: one section's manifest entry (hash + size, never
 *  content) — mirrors ContextManifestSection in @gus/shared. */
export interface PanelMemoryManifestSectionData {
  name: string;
  sha256: string;
  chars: number;
  included: boolean;
  quarantined?: boolean;
  truncated?: boolean;
}

export interface PanelMemoryManifestData {
  profile: string;
  digest: boolean;
  sections: PanelMemoryManifestSectionData[];
  estTokens: number;
  scanReceiptIds: string[];
  assembledAt: number;
}

/** v0.10: the answer to a Memory Preview press — the exact pack
 *  text a job with the chosen profile would receive (post-screen,
 *  post-scan, post-budget), its manifest, or the block that would
 *  fail the job instead. */
export interface PanelMemoryPreviewData {
  ok: boolean;
  detail: string;
  text?: string;
  manifest?: PanelMemoryManifestData;
}

export interface PanelActionResult {
  ok: boolean;
  detail: string;
}

/** v0.12.0 (pivot Phase 1 / iPhone Step 1): one paired device,
 *  as the operator's registry shows it. Records only — a device
 *  credential never crosses this contract in either direction
 *  after the one exchange that mints it, and its stored digest
 *  never crosses at all. */
export interface PanelDeviceData {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number;
  revoked: boolean;
  /** v0.13.0: the identity this device is a credential OF (the
   *  redo's re-homing — devices belong to the one GUS identity,
   *  not to a pairing session). Absent on records enrolled before
   *  the identity existed. */
  identityId?: string;
}

/** v0.13.0 (redo R1, spec §2.1): the one GUS identity, as the
 *  operator's panel shows it. The record itself plus every
 *  provider's configured state — never a credential: the local
 *  password's hash stays in the control plane's credentials file,
 *  and the hosted providers (Google/Apple/SSO) are seam stubs in
 *  this build, configured nowhere. */
export interface PanelIdentityData {
  id: string;
  createdAt: number;
  displayName?: string;
  /** The active provider kind: "local" | "local-password" |
   *  "google" | "apple" | "sso". */
  provider: string;
  providers: { kind: string; configured: boolean }[];
}

/** v0.14.5: the launch gate's readout — whether the first-run
 *  login screen is still owed (welcomedAt absent), the active
 *  provider, and whether a live session lets this launch skip
 *  the gate. The session readout carries provider + creation
 *  time only; the token never leaves the control plane's
 *  state dir. */
export interface PanelIdentitySessionData {
  welcomedAt?: number;
  provider: string;
  signedIn: boolean;
  session?: { provider: string; createdAt: number };
  /** v0.14.6: the auto-login posture — false = the operator
   *  turned the launch gate off (Protection home). */
  launchGateEnabled: boolean;
}

/** v0.13.0 (Memory Slice B): one memory candidate, as the Memory
 *  inbox shows it. Mirrors @gus/shared's MemoryCandidate — the
 *  panel package carries no dependencies, so the shape is
 *  restated here, as with PanelDeviceData. */
export interface PanelMemoryCandidateData {
  id: string;
  ts: number;
  jobId?: string;
  origin: string;
  category: string;
  text: string;
  source: string;
  status: string;
  decidedBy?: string;
  decidedAt?: number;
  promotedTo?: string;
  shieldReceiptId?: string;
}

/** v0.13.0 (Memory Slice B): one /forget search match — a line in
 *  a curated file (or daily note), or a pending candidate. */
export interface PanelMemoryForgetMatchData {
  where: "file" | "candidate";
  file?: string;
  candidateId?: string;
  text: string;
}

/** v0.12.0: the entitlement skeleton's readout (pivot §2.1) —
 *  the resolved claims' public shape. Today every install
 *  resolves to edition "self-hosted" with the full feature
 *  vocabulary; nothing gates on it yet. */
export interface PanelEntitlementData {
  edition: string;
  features: string[];
  expiresAt: number | null;
  keyId: string;
}

/** v0.6: one side of the panel-chat transcript. "in" is the
 *  operator's submitted text; "out" is what the host delivered to
 *  the chat conversation (results and notices, egress-screened
 *  before they were recorded). The durable source is chat.jsonl in
 *  control-plane state — this shape is only its read model. */
export interface PanelChatMessageData {
  ts: number;
  direction: "in" | "out";
  text: string;
  /** v0.24.0: photos sent with this (inbound) entry — the count
   *  only; image data is never part of the transcript. */
  photos?: number;
  /** v0.26.0: the entry's sync identity (chat-history sync) —
   *  the creating device's ID, its per-device sequence, and the
   *  causal pointer to the previous message. */
  id?: string;
  deviceId?: string;
  seq?: number;
  prevId?: string | null;
}

/** v0.26.0: the sync identity a chat submission may carry,
 *  minted by the creating device (the iOS chat). The core
 *  records the submission under this identity rather than
 *  minting its own. */
export interface PanelChatSubmitIdentityData {
  id: string;
  deviceId: string;
  seq: number;
  prevId: string | null;
  ts: number;
}

/** v0.26.0: one synced chat record — mirrors @gus/shared's
 *  SyncedChatMessage. The wire shape of chat-history sync. */
export interface PanelChatSyncMessageData {
  id: string;
  deviceId: string;
  seq: number;
  prevId: string | null;
  ts: number;
  direction: "in" | "out";
  text: string;
  photos?: number;
}

/** v0.26.0: one chat-sync exchange. The caller names the
 *  record IDs it holds and may push records the core lacks;
 *  the answer carries the records the caller lacks and the
 *  caller's IDs the core still wants. */
export interface PanelChatSyncRequestData {
  deviceId: string;
  haveIds: string[];
  messages?: PanelChatSyncMessageData[];
  /** v0.34.0: tombstones the caller pushes — deletions it
   *  made or carries, applied by the core before any pushed
   *  message is filed. */
  tombstones?: PanelChatSyncTombstoneData[];
}

export interface PanelChatSyncResultData {
  deviceId: string;
  missing: PanelChatSyncMessageData[];
  /** v0.34.0: tombstones the caller lacks. Optional in this
   *  shape only because test backends stub the result; the
   *  real backend always sends it. */
  missingTombstones?: PanelChatSyncTombstoneData[];
  wantIds: string[];
  conflicts: number;
}

/** v0.34.0: one tombstone — mirrors @gus/shared's
 *  SyncedChatTombstone. The wire shape of a deletion: it
 *  names the message it kills and carries no content. */
export interface PanelChatSyncTombstoneData {
  kind: "tombstone";
  id: string;
  deviceId: string;
  seq: number;
  prevId: string | null;
  ts: number;
  targetId: string;
}

/** v0.24.0: one photo attached to a chat submission — mirrors
 *  @gus/shared's MessageImage. The bytes ride the submission to
 *  the model as image input; they are never stored. */
export interface PanelChatImageData {
  mediaType: string;
  /** Base64-encoded image bytes (no "data:" prefix). */
  data: string;
}

/** v0.6: the Chat view's full read model — the transcript plus the
 *  chat conversation's jobs (oldest first), so the view can render
 *  status transitions and inline approval cards from durable state
 *  alone. Approvals themselves still come from approvals() — the
 *  same pending records every surface resolves. */
export interface PanelChatData {
  conversationId: string;
  messages: PanelChatMessageData[];
  jobs: PanelJobData[];
}

/** v0.6: one Watch-timeline line, merged from events.jsonl (source
 *  "events": channel/host events — approvals, parks, permissive
 *  let-throughs) and gate.jsonl (source "gate": every Shield gate
 *  decision). receiptId is carried whenever the underlying record
 *  has one, so a line can be traced to its verifiable receipt.
 *
 *  v0.11.0 (the secure log): three derived fields ride along,
 *  computed by the timeline reader from the SAME records — never
 *  a second event system. `category` buckets the line for the
 *  log's filter chips ("scan" | "approval" | "action").
 *  `narration` is the plain-language line the chat secure log
 *  renders: what happened, in one short sentence, with the real
 *  timestamp on the entry itself. `flagged` marks a permissive
 *  let-through — an action or scan that proceeded under a
 *  Permissive Governor despite a flag that would have bound in
 *  Enforcing; flagged lines' narration is the discreet one-liner
 *  ("Allowed under Permissive — … · flagged as potentially
 *  insecure · logged"), and `detail` keeps the full recorded
 *  text, one tap away beside the receipt. Enforcement is
 *  untouched: these fields describe records, they never make
 *  them. */
export interface PanelTimelineEntryData {
  ts: number;
  source: "events" | "gate";
  kind: string;
  detail: string;
  jobId?: string;
  receiptId?: string;
  category?: "scan" | "approval" | "action";
  narration?: string;
  flagged?: boolean;
}

/** v0.6: the Watch frame. Bytes cross the contract (never a path,
 *  never a data URL) so the server can stream them as-is. The
 *  bridge captures PNG, so PNG is what is served — no transcoding
 *  step exists anywhere in the frame path. */
export type PanelWatchFrameResult =
  | { ok: true; contentType: string; bytes: Uint8Array }
  | { ok: false; detail: string };

/** v0.17.8 (Gmail cleanup chunk 4): one cleanup batch's full
 *  record — the tap-through behind the morning report's batch +
 *  receipt line. Mirrors CleanupBatchRecord in the control plane
 *  (the manifest store is the source; this is the wire shape the
 *  panel/iPhone renders from). Read-only by construction: the
 *  record enumerates what a settled run did — exact message IDs,
 *  the rule per ID, the prior label set each archive captured —
 *  and offers no operation on any of it. The receipt named here
 *  is the gate's local-stub HMAC receipt, hash-bound to the
 *  manifest — tamper-evident, not an Agent-Shield Protocol
 *  receipt. */
export interface PanelGmailCleanupEntryData {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  priorLabelIds: string[];
  rule: string;
  state: "pending" | "done" | "skipped-stale" | "failed";
  detail?: string;
  undone?: boolean;
}

export interface PanelGmailCleanupBatchData {
  batchId: string;
  jobId: string;
  receiptId?: string;
  undoJobId?: string;
  undoReceiptId?: string;
  status: "running" | "verified-done" | "failed-loudly" | "undone";
  startedAt: number;
  finishedAt?: number;
  undoneAt?: number;
  ruleFileHash: string;
  cap: number;
  counts: { total: number; done: number; failed: number; skippedStale: number; undone: number };
  /** The dry-run selection context, when that manifest is still
   *  on disk; null when it isn't (the run record stands alone). */
  plan: {
    createdAt: number;
    scanned: number;
    noRule: number;
    excluded: Record<string, number>;
    withheld: number;
    overCap: number;
    byRule: Record<string, number>;
    shieldUnscanned: boolean;
  } | null;
  entries: PanelGmailCleanupEntryData[];
}

export interface PanelBackend {
  status(): PanelStatusData;
  ledger(): PanelLedgerData;
  jobs(): PanelJobData[];
  approvals(): PanelApprovalData[];
  /** v0.7: resolved approvals, newest first — the history beneath
   *  the pending queue in the desktop app's Approvals sidebar. */
  approvalsHistory(): PanelApprovalHistoryData[];
  /** Resolve over the SAME approval engine + execution path the
   *  channel uses — the panel cannot widen, rebind, or forge. */
  resolveApproval(id: string, approve: boolean): Promise<PanelActionResult>;
  setKilled(on: boolean): Promise<PanelActionResult>;
  /** v0.4: flip the Governor mode (governor-mode.ts in the control
   *  plane). Live on the next decision; no restart. */
  setGovernorMode(mode: string): Promise<PanelActionResult>;
  /** v0.14.6: set the budget profile (budget-profile.ts in the
   *  control plane). Operator-only by route construction —
   *  the route is not on the paired-device surface, and no job
   *  path reaches the panel, so the agent cannot raise its
   *  own budget. Live on the next authorization. Optional in
   *  the interface like the identity methods: a backend that
   *  doesn't wire it gets the route's honest 501. */
  setBudgetProfile?(profile: string): Promise<PanelActionResult>;
  /** v0.5: save the approval-delegation policy (approver-policy.ts
   *  in the control plane). Live on the next park; applies only
   *  while the Governor is permissive. */
  setApproverPolicy(policy: PanelApproverPolicyData): Promise<PanelActionResult>;
  /** v0.8: save the Shield gate's operator policy (required +
   *  fail mode) into the policy file, via PolicyStore.writeShield.
   *  Policy only — provisioning the key stays the onboarding
   *  shield step's job. Live on the next gate decision. */
  setShieldPolicy(policy: PanelShieldPolicyData): Promise<PanelActionResult>;
  /** v0.8: the settings detail (Mac jail contents + delegates) —
   *  read-only; see PanelSettingsDetailData. */
  settingsDetail(): PanelSettingsDetailData;
  /** Names only — there is no read path for values, here either. */
  vaultNames(): string[];
  storeSecret(name: string, value: string): PanelActionResult;
  onboarding(): PanelOnboardingData;
  onboardingShield(payload: { onUnavailable?: string }): Promise<PanelActionResult>;
  onboardingTelegram(payload: { token?: string }): Promise<PanelActionResult>;
  onboardingProvider(payload: Record<string, unknown>): Promise<PanelActionResult>;
  onboardingCaps(payload: Record<string, unknown>): Promise<PanelActionResult>;
  onboardingFirstJob(): Promise<PanelActionResult & { jobId?: string }>;
  skills(): PanelSkillData[];
  installSkill(payload: { path?: string }): Promise<
    PanelActionResult & { verdict?: string; findings?: Record<string, unknown>[] }
  >;
  /** v0.10 (Memory Slice A): the context pack's status and preview.
   *  Optional on the backend (the voiceTestConnection pattern): a
   *  backend that doesn't wire them gets the server's plain "not
   *  wired" answer, never a fake success. v0.13.0 (Slice B) adds
   *  the write-loop methods further below (memoryCandidates,
   *  promoteCandidate, rejectCandidate, memoryRemember,
   *  memoryForget). */
  memoryStatus?(): PanelMemoryStatusData;
  memoryPreview?(profile: string): Promise<PanelMemoryPreviewData>;
  /** v0.13.0 (redo R1): devices + identity. Optional on the
   *  backend (the memoryStatus pattern): a backend that doesn't
   *  wire them gets the server's plain "not wired" answer, never
   *  a fake success. All operator-token routes — a device
   *  credential asking for any of these was already refused at
   *  the tier gate. The v0.12.0 pairing-grant/exchange methods
   *  are GONE: the redo deletes the QR pairing flow (spec §7);
   *  devices are credentials of the identity, enrolled locally,
   *  listed and revoked here. */
  devices?(): PanelDeviceData[];
  revokeDevice?(id: string): PanelActionResult;
  identity?(): PanelIdentityData;
  setIdentityPassword?(username: string, password: string): PanelActionResult;
  setIdentityProvider?(kind: string): PanelActionResult;
  /** v0.14.5: the launch gate — session status, sign-in,
   *  sign-out, and the first-run welcome marker. */
  identitySession?(): PanelIdentitySessionData;
  identityLogin?(
    username: string,
    password: string,
  ): PanelActionResult & { session?: { provider: string; createdAt: number } };
  identityLogout?(): PanelActionResult;
  identityWelcome?(): PanelActionResult & { welcomedAt?: number };
  /** v0.14.6: flip the launch-gate posture (auto-login). */
  identityLaunchGate?(enabled: boolean): PanelActionResult;
  /** v0.13.0 (Memory Slice B): the Memory inbox and the panel
   *  twins of /remember and /forget — the same code path as the
   *  channel commands (memory-write.ts in the control plane).
   *  memoryForget with no confirmCount is the SEARCH (it changes
   *  nothing); with a confirmCount it applies, and only when the
   *  count still matches what the search found. */
  memoryCandidates?(): PanelMemoryCandidateData[];
  promoteCandidate?(
    id: string,
    text?: string,
    targetFile?: string,
  ): PanelActionResult & { identityCategory?: boolean };
  rejectCandidate?(id: string): PanelActionResult;
  memoryRemember?(text: string, target: string): PanelActionResult;
  memoryForget?(
    query: string,
    confirmCount?: number,
  ): PanelActionResult & { matches?: PanelMemoryForgetMatchData[] };
  /** v0.12.0: the resolved entitlement claims (read-only). */
  entitlements?(): PanelEntitlementData;
  /** v0.6: submit the Chat composer's text. It becomes a NORMAL
   *  job through the channel pipeline (ingress secret-guard,
   *  Shield scan, classifier, Governor caps, receipts) — the panel
   *  chat is a channel adapter, not a side door. v0.24.0: a
   *  submission may carry photos, which ride the same pipeline
   *  to the model as image input. */
  submitChat(
    text: string,
    images?: PanelChatImageData[],
    identity?: PanelChatSubmitIdentityData,
  ): Promise<PanelActionResult>;
  /** v0.6: the Chat view's read model, from durable state. */
  chatHistory(): PanelChatData;
  /** v0.26.0: one chat-history sync exchange with a device —
   *  ingest its pushed records (history only, never emitted
   *  as channel events) and answer with the records it lacks
   *  plus the IDs this store still wants from it. */
  chatSync(req: PanelChatSyncRequestData): PanelChatSyncResultData;
  /** v0.6: the latest Watch frame, fetched on demand from the Mac
   *  bridge's observation path (throttled by the backend to ~1 fps;
   *  nothing is captured while nobody asks). ok:false with an
   *  honest detail when the bridge is absent or Screen Recording
   *  is not granted — the timeline still works either way. */
  watchFrame(): Promise<PanelWatchFrameResult>;
  /** v0.6: the Watch timeline (events + gate decisions), newest
   *  first. */
  watchTimeline(): PanelTimelineEntryData[];
  /** v0.9: the voice channel's settings, read from the same file
   *  the call service reads per call. */
  voiceSettings(): PanelVoiceSettingsData;
  /** v0.9: save the voice channel's settings (voice.json via the
   *  voice package's defensive parse — a bad URL fails toward the
   *  default, and only a literal true enables the channel). Live
   *  on the next call; no restart. */
  setVoiceSettings(settings: PanelVoiceSettingsData): Promise<PanelActionResult>;
  /** v0.9.9: Test Connection (Settings → Voice) — probe an
   *  endpoint described by the CURRENT form values (base URL +
   *  model), unsaved and unstored: GET {base}/models, reported
   *  with latency + model presence. Optional on the backend
   *  (the stageUpdate pattern): a backend that doesn't wire it
   *  gets the server's plain "not wired" answer, never a fake
   *  success. */
  voiceTestConnection?(kind: "stt" | "tts", baseUrl: string, model: string): Promise<PanelVoiceEndpointTestData>;
  /** v0.9.9: the endpoint half of Test mic and speaker —
   *  synthesize ONE short test sentence with the current form's
   *  TTS values (unsaved) and return the audio for playback.
   *  Optional on the backend, same rule as above. */
  voiceTestSpeech?(baseUrl: string, model: string, voice: string): Promise<PanelVoiceTestSpeechData>;
  /** v0.9: one push-to-talk exchange. The audio becomes a
   *  transcript, the transcript becomes a NORMAL job through the
   *  channel pipeline (the voice channel adapter — secret-guard,
   *  Shield scan, classifier, caps, receipts), and the host's
   *  answer is synthesized for playback. The panel adds no path
   *  of its own: this delegates to the voice call service, which
   *  drives the same ChannelHost every surface drives. */
  voiceCall(audio: Uint8Array, contentType: string): Promise<PanelVoiceCallData>;
  /** v0.9.1: the live call. Start opens the one session (the
   *  0.9 call's guards apply: voice off refuses loudly); audio
   *  takes the streamed mic chunks (raw PCM16) the VAD segments
   *  into utterances; state is the poll the app renders its
   *  transcript + latency from; nextAudio feeds its playback
   *  queue one sentence-segment at a time; interrupt is
   *  barge-in (speech only — never a job, never an approval);
   *  end hangs up. All delegate to the voice session service —
   *  the backend adds no path of its own. */
  voiceSessionStart(): PanelVoiceSessionData | Promise<PanelVoiceSessionData>;
  voiceSessionAudio(sessionId: string, audio: Uint8Array): PanelActionResult;
  /** v0.9.6: a final transcript from the app's built-in
   *  recognizer, for a call whose resolved STT mode is local.
   *  The transcript takes the identical session turn a
   *  transcribed utterance takes — the panel adds no path. */
  voiceSessionTranscript(sessionId: string, text: string): PanelActionResult;
  voiceSessionState(sessionId: string): PanelVoiceSessionData;
  voiceSessionNextAudio(sessionId: string, afterSeq: number): PanelVoiceAudioSegmentData;
  voiceSessionInterrupt(sessionId: string): PanelActionResult;
  voiceSessionEnd(sessionId: string): PanelVoiceSessionData;
  /** v0.17.8 (Gmail cleanup chunk 4): a cleanup batch's full
   *  record (PanelGmailCleanupBatchData), read from the cleanup
   *  manifest store. Optional on the backend (the memoryStatus
   *  pattern): a backend that doesn't wire it gets the server's
   *  plain "not wired" answer, never a fake record. Returns null
   *  when no run manifest exists for the batch (the route answers
   *  404). Read-only — there is no write twin of this method. */
  gmailCleanupBatch?(batchId: string): PanelGmailCleanupBatchData | null;
}
