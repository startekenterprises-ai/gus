/**
 * The panel Chat adapter (v0.6) — the operator panel as a channel.
 *
 * The Chat view needed a way to speak to GUS that is NOT a bypass:
 * every other surface reaches the agent by emitting a ChannelEvent
 * into the ChannelHost, where secret screening, the sender gate,
 * the Shield ingress scan, the classifier, the Governor caps and
 * the receipt chain all apply. So the panel is wired as exactly
 * that — one more ChannelAdapter, named "panel", with a single
 * conversation ("panel-chat"). Submitting the composer emits the
 * same event a Telegram message would have produced; the sender is
 * the panel itself, which only the operator token can reach, and an
 * ungated conversation reads as the operator under delegates.ts —
 * the same trust the panel's other buttons already carry.
 *
 * What makes it a chat and not just a job form is the return path:
 * everything the host sends to this conversation — results, park
 * notices, block notices, cap notices — is appended to
 * <stateDir>/chat.jsonl by send(). That file is the durable
 * transcript: the panel's history endpoint reads it back, so a
 * reload (or a control-plane restart) loses nothing. Inbound
 * submissions are recorded by submit() itself (the host does not
 * echo the operator's own words back), so the file holds both
 * directions in order.
 *
 * The record holds TEXT ONLY, exactly as egress-screened by the
 * host before send() is called. Buttons are not recorded: the
 * panel renders live approval cards from the Approval Engine's
 * own durable state, never from transcript text.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type {
  ChannelAdapter,
  ChannelEvent,
  OutboundMessage,
} from "@gus/shared";

export const PANEL_CHAT_CONVERSATION = "panel-chat";
export const PANEL_CHAT_SENDER = "panel";

const MAX_TEXT_CHARS = 8_000;
const MAX_HISTORY = 200;

export interface PanelChatEntry {
  ts: number;
  direction: "in" | "out";
  text: string;
}

export class PanelChatAdapter implements ChannelAdapter {
  readonly name = "panel";
  private onEvent?: (ev: ChannelEvent) => void;
  private counter = 0;

  constructor(private stateDir: string) {}

  private logPath(): string {
    return `${this.stateDir}/chat.jsonl`;
  }

  async start(onEvent: (ev: ChannelEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  async stop(): Promise<void> {}

  /**
   * The composer's send button, via the panel backend. Records the
   * operator's words, then emits the ordinary message event — from
   * here on the pipeline cannot tell (and does not care) that the
   * words came from the panel rather than Telegram.
   */
  submit(text: string): { ok: boolean; detail: string } {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, detail: "The message is empty — nothing was sent." };
    if (trimmed.length > MAX_TEXT_CHARS) {
      return { ok: false, detail: `That message is over the ${MAX_TEXT_CHARS}-character limit for one job — nothing was sent.` };
    }
    if (!this.onEvent) {
      return { ok: false, detail: "The chat channel is not running yet — nothing was sent." };
    }
    this.record({ ts: Date.now(), direction: "in", text: trimmed });
    this.onEvent({
      type: "message",
      message: {
        conversationId: PANEL_CHAT_CONVERSATION,
        messageId: `panel-${Date.now().toString(36)}-${this.counter++}`,
        senderId: PANEL_CHAT_SENDER,
        text: trimmed,
        receivedAt: Date.now(),
      },
    });
    return { ok: true, detail: "Sent — it goes through the same scan, caps and receipts as any channel message." };
  }

  /** Outbound: the host has already egress-screened this text.
   *  Persist it as the transcript's "out" side. */
  async send(msg: OutboundMessage): Promise<void> {
    if (msg.conversationId !== PANEL_CHAT_CONVERSATION) return;
    this.record({ ts: Date.now(), direction: "out", text: msg.text });
  }

  async ackButton(): Promise<void> {
    /* Buttons never originate from the panel adapter — the panel
     * resolves approvals through the panel backend's POST route. */
  }

  private record(entry: PanelChatEntry): void {
    appendFileSync(this.logPath(), JSON.stringify({ conversationId: PANEL_CHAT_CONVERSATION, ...entry }) + "\n");
  }

  /** The durable transcript, oldest first, capped. A torn final
   *  line (a crash mid-append) is skipped, never fatal. */
  history(limit = MAX_HISTORY): PanelChatEntry[] {
    if (!existsSync(this.logPath())) return [];
    const out: PanelChatEntry[] = [];
    for (const line of readFileSync(this.logPath(), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as {
          conversationId?: string;
          ts?: number;
          direction?: string;
          text?: string;
        };
        if (r.conversationId !== PANEL_CHAT_CONVERSATION) continue;
        if (typeof r.ts !== "number" || typeof r.text !== "string") continue;
        out.push({ ts: r.ts, direction: r.direction === "in" ? "in" : "out", text: r.text });
      } catch { /* torn line — skip */ }
    }
    return out.slice(-limit);
  }
}
