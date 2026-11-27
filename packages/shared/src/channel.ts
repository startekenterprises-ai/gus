/**
 * Channel adapter interface (foundation spec, Amendment A1).
 *
 * Channels are ADAPTERS, not architecture. The control plane talks to every
 * channel — Telegram first, Microsoft Teams second (chat + DMs + adaptive
 * cards; no media bot) — through this interface only. The agent sandbox
 * never sees a channel: adapters live in the control plane, and everything
 * they emit passes secret-guard ingress screening before it becomes a job.
 */

export interface ApprovalButton {
  /** Stable id the control plane maps back to an approval request. */
  id: string;
  label: string;
}

/** v0.24.0: one image attached to an inbound message, carried as
 *  data (never a path or URL — channels terminate in the control
 *  plane, and the image must cross the same screened pipeline as
 *  the text). Adapters that accept attachments validate the shape
 *  and cap the count/size before emitting; the ChannelHost
 *  re-validates before anything rides to the runtime. Only the
 *  panel adapter produces these today (the iOS chat's photos);
 *  adapters without attachments never set the field. */
export interface MessageImage {
  /** IANA media type, e.g. "image/jpeg". */
  mediaType: string;
  /** Base64-encoded image bytes (no "data:" prefix). */
  data: string;
}

/** v0.40.0: the transport cap for a message's persona context
 *  (see InboundMessage.personaContext) — 16 KiB of UTF-8. The
 *  composed prompt is bounded by construction (a persona prompt
 *  + the house style + a ≤1,500-character memory block), so the
 *  cap has headroom; it exists so a broken or hostile client
 *  cannot ride an unbounded private blob into every job. Both
 *  ends enforce it — the phone refuses in words before sending,
 *  the core refuses in words at the door — and nothing is ever
 *  silently truncated to fit. */
export const MAX_PERSONA_CONTEXT_BYTES = 16_384;

/** UTF-8 byte length — the measure MAX_PERSONA_CONTEXT_BYTES is
 *  stated in, identical on both ends of the transport (Swift
 *  measures `string.utf8.count`). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface InboundMessage {
  /** Adapter-native conversation id (Telegram chat id, Teams chat id, …). */
  conversationId: string;
  /** Adapter-native message id, for dedupe. */
  messageId: string;
  /** Operator identity as asserted by the channel (never trusted for authz
   *  beyond "this is the paired operator" in v1's single-operator model). */
  senderId: string;
  text: string;
  /** v0.24.0: images attached to this message (see MessageImage).
   *  The text is scanned and receipted exactly as before; the
   *  images ride the job to the model's first call as image input
   *  on providers that support it. The durable transcript records
   *  only the COUNT, never the image data. */
  images?: MessageImage[];
  /** Unix ms. */
  receivedAt: number;
  /** v0.5.1: artifact post-conditions declared by the requester —
   *  absolute file paths this job is expected to CREATE. Only the
   *  Bridge Inbox sets this (from the request file's `deliverables`
   *  field); chat messages never carry it. The control plane records
   *  them on the job and, at completion, verified-done additionally
   *  requires every path to exist — a text-only "done" no longer
   *  settles a job that promised files. */
  deliverables?: string[];
  /** v0.14.1: the requester-declared job kind. Only the Bridge
   *  Inbox sets this (from the request file's `kind` field), and
   *  the only value it may carry is "task" — an execution task the
   *  agent loop carries out with tools instead of a chat message
   *  it answers in prose. It is a ROUTING LABEL, never an
   *  authority grant: the sender gate has already decided who the
   *  sender is before this is read, and the classifier, the
   *  Governor's caps and the approval engine treat a task job
   *  exactly like the same sender's chat job. The kind only buys
   *  the execution framing on the runtime prompt (channel-host).
   *  Chat messages never carry it. */
  jobKind?: "task";
  /** v0.9.8: this message is a live voice call's spoken turn (only
   *  the voice adapter's session/call submits set it). The
   *  ChannelHost stamps it onto the job record, where it puts a
   *  plain-chat job in the voice fast lane (brevity note, a reply
   *  token budget, a steered two-call shape — see
   *  control-plane/runtime). Command submits (/stop, /approve)
   *  never become jobs, so the flag on them is inert. */
  voiceTurn?: boolean;
  /** v0.37.0: this message's images are (or include) the live
   *  view from a voice call's camera — Watch mode's current
   *  frame(s), attached by the voice session to the operator's
   *  turn so the answer is grounded in what the camera sees.
   *  Only the voice adapter's session submits set it, and only
   *  alongside images. The ChannelHost frames them with the
   *  live-view note instead of the photo note: the operator
   *  didn't SEND a picture, the call is showing the model its
   *  eyes. The frames themselves are never recorded — the
   *  durable transcript keeps the count, as for photos. */
  liveView?: boolean;
  /** v0.40.0: the persona context the operator's phone composed
   *  for this conversation — the picked persona's prompt, the
   *  house style, and that persona's remembered lines, exactly
   *  as the phone's own brain would load them (LocalBrain's
   *  composed prompt). Only the panel chat adapter (per job) and
   *  the voice adapter (per turn, from the session's held copy)
   *  set it; the ChannelHost frames it into the job's runtime
   *  prompt as the persona layer, under the core's own framing
   *  (the providers prepend that themselves). It is the
   *  operator's PRIVATE data — it can carry memory lines — so it
   *  is transport and in-memory prompt state ONLY: never
   *  persisted, never written to a log, receipt, or sync record
   *  (logs may record its presence, character count, and a short
   *  hash). Capped at MAX_PERSONA_CONTEXT_BYTES; the adapters
   *  refuse an over-cap context in words rather than truncating
   *  it. Absent (every other adapter, older phones) the pipeline
   *  behaves exactly as it did before the field existed. */
  personaContext?: string;
}

/** v0.9.8: a job's measured pipeline stages, attached by the
 *  ChannelHost to the outbound message that delivers the job's
 *  outcome (final reply, park notice, block notice, denial…). All
 *  three are MEASURED in the control plane — shieldMs around the
 *  ingress scan, modelMs summed over the job's completed model
 *  calls, hops their count — never estimated. The voice channel
 *  folds them into the turn's latency record (voice-turns.jsonl);
 *  other adapters ignore the field. */
export interface JobDeliveryStats {
  shieldMs: number;
  modelMs: number;
  hops: number;
  /** v0.9.9: the job was a voice turn and the operator's
   *  Settings → Voice Shield-scan switch was OFF, so the
   *  ChannelHost skipped the ingress Shield scan for this job
   *  (scan-skipped-by-operator). shieldMs is 0 in that case —
   *  but 0 alone would be indistinguishable from a fast scan,
   *  so the skip is named here and lands on the turn record.
   *  Absent for every scanned job and every non-voice job. */
  shieldSkipped?: boolean;
  /** v0.9.10: the job was a voice turn and its ingress scan ran
   *  in the Shield's fast mode — deterministic patterns only,
   *  the semantic LLM stage skipped (the verdict and the signed
   *  receipt are unchanged; the scan took ~1–2s instead of
   *  ~7–12s). Set only when a scan actually ran fast. Absent
   *  for every full-review scan and every non-voice job. */
  shieldFastMode?: boolean;
}

export interface OutboundMessage {
  conversationId: string;
  text: string;
  /** v0.9.8: the delivering job's stage stats, when the send is a
   *  job outcome (see JobDeliveryStats). */
  jobStats?: JobDeliveryStats;
  /** Optional inline approval buttons (Telegram inline keyboard, Teams
   *  adaptive card actions). Adapters that cannot render buttons must
   *  degrade to numbered text choices — never drop the approval. */
  buttons?: ApprovalButton[];
}

export type ButtonPress = {
  conversationId: string;
  senderId: string;
  buttonId: string;
  /** Adapter-native callback id to acknowledge the press. */
  callbackId: string;
};

export type ChannelEvent =
  | { type: "message"; message: InboundMessage }
  | { type: "button"; press: ButtonPress };

export interface ChannelAdapter {
  /** Stable adapter name: "telegram", "teams", "fake-file", … */
  readonly name: string;
  /** Begin emitting events. Resolves once the adapter is live. */
  start(onEvent: (ev: ChannelEvent) => void): Promise<void>;
  stop(): Promise<void>;
  /** Send a message. Egress secret-guard screening happens in the control
   *  plane BEFORE this is called; adapters must not bypass it. */
  send(msg: OutboundMessage): Promise<void>;
  /** Acknowledge a button press (removes the spinner on Telegram, etc.). */
  ackButton?(callbackId: string, note?: string): Promise<void>;
}
