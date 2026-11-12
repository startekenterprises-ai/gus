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

export interface InboundMessage {
  /** Adapter-native conversation id (Telegram chat id, Teams chat id, …). */
  conversationId: string;
  /** Adapter-native message id, for dedupe. */
  messageId: string;
  /** Operator identity as asserted by the channel (never trusted for authz
   *  beyond "this is the paired operator" in v1's single-operator model). */
  senderId: string;
  text: string;
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
  /** v0.9.8: this message is a live voice call's spoken turn (only
   *  the voice adapter's session/call submits set it). The
   *  ChannelHost stamps it onto the job record, where it puts a
   *  plain-chat job in the voice fast lane (brevity note, a reply
   *  token budget, a steered two-call shape — see
   *  control-plane/runtime). Command submits (/stop, /approve)
   *  never become jobs, so the flag on them is inert. */
  voiceTurn?: boolean;
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
