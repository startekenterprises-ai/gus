/**
 * File-backed fake Telegram transport — the Phase 0 harness.
 *
 * Implements the exact TelegramTransport interface the real Bot API
 * transport implements, backed by two NDJSON files on a shared directory:
 *   inbound.ndjson  — appended by the test harness ("the user typing")
 *   outbound.ndjson — appended by the adapter ("what the user would see")
 *
 * Because the adapter code above it is identical, the drill exercises the
 * real channel path (adapter → control plane → sandbox → reply) with no
 * live bot, no token, and a complete on-disk transcript as evidence.
 * Inbound lines mimic Bot API update objects so the adapter's parsing is
 * the production parsing.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { ApprovalButton } from "@gus/shared";
import type { TelegramTransport } from "./telegram.js";

export class FakeFileTransport implements TelegramTransport {
  private consumed = 0;
  private initialized = false;

  constructor(
    private inboundPath: string,
    private outboundPath: string,
  ) {}

  async getUpdates(offset: number, _timeoutSec: number): Promise<unknown[]> {
    if (!existsSync(this.inboundPath)) return [];
    const lines = readFileSync(this.inboundPath, "utf8").split("\n").filter(Boolean);
    if (!this.initialized) {
      // Restart semantics: the inbound file is a transcript of
      // everything ever typed, but a freshly started control plane
      // must only consume what arrives AFTER it starts — otherwise a
      // restart (routine since Phase 3, whose updater restarts the
      // control plane to promote a release) would replay the entire
      // history as new jobs. So the first poll starts at end-of-file:
      // history is evidence, not a queue. (The real Bot API transport
      // gets the equivalent from Telegram's server-side offsets.)
      this.consumed = lines.length;
      this.initialized = true;
      return [];
    }
    const fresh = lines.slice(this.consumed);
    this.consumed = lines.length;
    return fresh.map((l) => JSON.parse(l));
  }

  async sendMessage(chatId: string, text: string, buttons?: ApprovalButton[]): Promise<void> {
    appendFileSync(
      this.outboundPath,
      JSON.stringify({ chat_id: chatId, text, buttons: buttons ?? [] }) + "\n",
    );
  }

  async answerCallbackQuery(callbackId: string, note?: string): Promise<void> {
    appendFileSync(
      this.outboundPath,
      JSON.stringify({ callback_query_id: callbackId, note: note ?? null }) + "\n",
    );
  }
}

/** Build a Bot API-shaped message update, for harness/test use. */
export function fakeMessageUpdate(
  updateId: number,
  chatId: number,
  fromId: number,
  text: string,
): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      text,
      chat: { id: chatId },
      from: { id: fromId },
    },
  };
}
