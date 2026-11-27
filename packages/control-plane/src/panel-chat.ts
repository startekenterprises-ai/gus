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
 *
 * v0.24.0: photos. A submission may carry images (the iOS chat's
 * photo attach). The images ride the emitted event to the model
 * as image input, but they are NEVER recorded: the transcript
 * entry carries only the photo COUNT (`photos`), so the durable
 * record shows a photo was sent without holding the photo.
 */
import { appendFileSync } from "node:fs";
import type {
  ChannelAdapter,
  ChannelEvent,
  MessageImage,
  OutboundMessage,
} from "@gus/shared";
import { JsonlLogCache } from "./log-cache.js";

export const PANEL_CHAT_CONVERSATION = "panel-chat";
export const PANEL_CHAT_SENDER = "panel";

const MAX_TEXT_CHARS = 8_000;
const MAX_HISTORY = 200;
/** v0.24.0: photo caps for one submission — the iOS app sends a
 *  single downscaled JPEG (hundreds of KB); these are headroom,
 *  not targets. The ChannelHost re-validates before the runtime. */
export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BASE64_CHARS = 8_000_000;

export interface PanelChatEntry {
  ts: number;
  direction: "in" | "out";
  text: string;
  /** v0.24.0: how many photos the operator sent with this entry
   *  (inbound only). The image data itself is never recorded. */
  photos?: number;
}

/** v0.24.0: shape-check one submitted image. Returns the image
 *  when it is a plausible photo payload, undefined otherwise. */
export function sanitizeChatImage(raw: unknown): MessageImage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { mediaType?: unknown; data?: unknown };
  if (typeof r.mediaType !== "string" || !r.mediaType.startsWith("image/")) return undefined;
  if (typeof r.data !== "string" || r.data.length === 0) return undefined;
  if (r.data.length > MAX_CHAT_IMAGE_BASE64_CHARS) return undefined;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(r.data)) return undefined;
  return { mediaType: r.mediaType, data: r.data };
}

/** The history mapping, applied by the log cache once per line
 *  at append time (v0.14.0): the panel conversation's records
 *  only, shape-checked exactly as the old per-call parse checked
 *  them — anything else on the file is not transcript. */
function mapChatLine(raw: unknown): PanelChatEntry | undefined {
  const r = raw as {
    conversationId?: string;
    ts?: number;
    direction?: string;
    text?: string;
    photos?: number;
  };
  if (!r || typeof r !== "object") return undefined;
  if (r.conversationId !== PANEL_CHAT_CONVERSATION) return undefined;
  if (typeof r.ts !== "number" || typeof r.text !== "string") return undefined;
  return {
    ts: r.ts,
    direction: r.direction === "in" ? "in" : "out",
    text: r.text,
    ...(typeof r.photos === "number" && r.photos > 0 ? { photos: r.photos } : {}),
  };
}

export class PanelChatAdapter implements ChannelAdapter {
  readonly name = "panel";
  private onEvent?: (ev: ChannelEvent) => void;
  private counter = 0;
  /** v0.14.0 (R2): history reads through the incremental log
   *  cache — record()'s own appends are appendFileSync, whose
   *  size growth the cache's stat-delta picks up on the next
   *  history() call, so the transcript stays exactly as durable
   *  and exactly as current as the old full re-read. */
  private historyCache = new JsonlLogCache<PanelChatEntry>();

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
   *
   * v0.24.0: `images` carries the submission's photos. Each is
   * shape-checked and capped here (and again in the ChannelHost);
   * a submission naming photos that are not usable image payloads
   * is refused outright — a photo is never silently dropped. A
   * photo-only submission (no words) is a real message: the event
   * text is empty and the ChannelHost frames it for the model.
   * The transcript records the photo count, never the data.
   */
  submit(text: string, images?: MessageImage[]): { ok: boolean; detail: string } {
    const trimmed = text.trim();
    let photos: MessageImage[] | undefined;
    if (images !== undefined) {
      if (!Array.isArray(images) || images.length > MAX_CHAT_IMAGES) {
        return { ok: false, detail: `Too many photos — at most ${MAX_CHAT_IMAGES} per message. Nothing was sent.` };
      }
      photos = [];
      for (const raw of images) {
        const img = sanitizeChatImage(raw);
        if (!img) {
          return { ok: false, detail: "One of the attached photos isn't a usable image — nothing was sent." };
        }
        photos.push(img);
      }
      if (photos.length === 0) photos = undefined;
    }
    if (!trimmed && !photos) return { ok: false, detail: "The message is empty — nothing was sent." };
    if (trimmed.length > MAX_TEXT_CHARS) {
      return { ok: false, detail: `That message is over the ${MAX_TEXT_CHARS}-character limit for one job — nothing was sent.` };
    }
    if (!this.onEvent) {
      return { ok: false, detail: "The chat channel is not running yet — nothing was sent." };
    }
    this.record({
      ts: Date.now(),
      direction: "in",
      text: trimmed,
      ...(photos ? { photos: photos.length } : {}),
    });
    this.onEvent({
      type: "message",
      message: {
        conversationId: PANEL_CHAT_CONVERSATION,
        messageId: `panel-${Date.now().toString(36)}-${this.counter++}`,
        senderId: PANEL_CHAT_SENDER,
        text: trimmed,
        receivedAt: Date.now(),
        ...(photos ? { images: photos } : {}),
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
   *  line (a crash mid-append) is skipped, never fatal — the
   *  cache holds it unparsed until its newline lands. slice()
   *  copies, so the cache's array is never handed out mutably. */
  history(limit = MAX_HISTORY): PanelChatEntry[] {
    return this.historyCache.read(this.logPath(), mapChatLine).slice(-limit);
  }
}
