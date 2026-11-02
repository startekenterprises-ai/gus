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
}

export interface OutboundMessage {
  conversationId: string;
  text: string;
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
