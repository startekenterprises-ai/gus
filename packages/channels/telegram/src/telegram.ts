/**
 * Telegram channel adapter (foundation spec §2.1 + Amendments A1/A3).
 *
 * The adapter is a thin transport: it converts Bot API updates into
 * ChannelEvents and ChannelAdapter.send() calls into Bot API requests.
 * Policy — secret-guard screening, approvals, job creation — lives in the
 * control plane, never here.
 *
 * A3, operationalized: Telegram bot chats are NOT end-to-end encrypted.
 * This adapter therefore never receives or transmits secrets by design:
 * ingress is screened before jobs exist, and the vault never routes a
 * secret through a channel. The token in this file is the BOT token (a
 * channel credential held by the control plane), never user data.
 *
 * The Bot API sits behind a Transport so the Phase 0 gate drill can run
 * the exact same adapter code against a local fake (no live bot, no
 * token). The real transport uses long-polling getUpdates.
 */
import type {
  ApprovalButton,
  ButtonPress,
  ChannelAdapter,
  ChannelEvent,
  InboundMessage,
  OutboundMessage,
} from "@gus/shared";

export interface TelegramTransport {
  getUpdates(offset: number, timeoutSec: number): Promise<unknown[]>;
  sendMessage(chatId: string, text: string, buttons?: ApprovalButton[]): Promise<void>;
  answerCallbackQuery(callbackId: string, note?: string): Promise<void>;
}

/** Real Bot API transport. Token is read by the control plane from its own
 *  environment and injected here; it never enters the sandbox. */
export class BotApiTransport implements TelegramTransport {
  constructor(
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result: unknown; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }

  async getUpdates(offset: number, timeoutSec: number): Promise<unknown[]> {
    const r = await this.call("getUpdates", {
      offset,
      timeout: timeoutSec,
      allowed_updates: ["message", "callback_query"],
    });
    return Array.isArray(r) ? r : [];
  }

  async sendMessage(chatId: string, text: string, buttons?: ApprovalButton[]): Promise<void> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (buttons && buttons.length > 0) {
      body.reply_markup = {
        inline_keyboard: [buttons.map((b) => ({ text: b.label, callback_data: b.id }))],
      };
    }
    await this.call("sendMessage", body);
  }

  async answerCallbackQuery(callbackId: string, note?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, text: note });
  }
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number };
    from?: { id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { chat: { id: number } };
  };
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram";
  private offset = 0;
  private running = false;
  private lastErrorLogAt = 0;

  constructor(private transport: TelegramTransport) {}

  async start(onEvent: (ev: ChannelEvent) => void): Promise<void> {
    this.running = true;
    void this.loop(onEvent);
  }

  private async loop(onEvent: (ev: ChannelEvent) => void): Promise<void> {
    while (this.running) {
      let updates: unknown[];
      try {
        updates = await this.transport.getUpdates(this.offset, 2);
      } catch (err) {
        // Never fail silently: a transport that cannot read its source
        // (bad token, unreadable file) must be diagnosable from logs.
        const now = Date.now();
        if (now - this.lastErrorLogAt > 30_000) {
          this.lastErrorLogAt = now;
          console.error(
            `gus telegram adapter: getUpdates failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      // Always yield to the event loop between polls. A transport that
      // resolves synchronously (the file fake) would otherwise spin the
      // microtask queue forever and starve the process's socket I/O.
      if (updates.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      for (const raw of updates) {
        const u = raw as TgUpdate;
        this.offset = Math.max(this.offset, u.update_id + 1);
        if (u.message?.text) {
          const m: InboundMessage = {
            conversationId: String(u.message.chat.id),
            messageId: String(u.message.message_id),
            senderId: String(u.message.from?.id ?? ""),
            text: u.message.text,
            receivedAt: u.message.date * 1000,
          };
          onEvent({ type: "message", message: m });
        } else if (u.callback_query?.data && u.callback_query.message) {
          const p: ButtonPress = {
            conversationId: String(u.callback_query.message.chat.id),
            senderId: String(u.callback_query.from.id),
            buttonId: u.callback_query.data,
            callbackId: u.callback_query.id,
          };
          onEvent({ type: "button", press: p });
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this.transport.sendMessage(msg.conversationId, msg.text, msg.buttons);
  }

  async ackButton(callbackId: string, note?: string): Promise<void> {
    await this.transport.answerCallbackQuery(callbackId, note);
  }
}
