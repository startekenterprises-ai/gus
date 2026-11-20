/**
 * Channel send-failure containment.
 *
 * Field bug (2026-11-05, first real Mac install): a panel-started job
 * finished and ChannelHost.onJobFinal tried to send its result to
 * Telegram. The operator had never opened a chat with the bot (bots
 * cannot initiate chats), Telegram answered "chat not found", the
 * throw escaped sendTo → onJobFinal → the comm server, and the
 * control plane died. launchd restarted it and the job had already
 * settled with its receipt, so no work was lost — but a failed
 * NOTIFICATION must never be able to kill the process.
 *
 * What is pinned here:
 *  - sendTo contains adapter send failures: the caller resolves, the
 *    loss is logged (events.jsonl kind "send_failed", naming the
 *    adapter and the error) — never silent, never fatal.
 *  - onJobFinal still settles the job when its result send fails.
 *  - Button acks are contained the same way: a throwing ackButton
 *    neither crashes the host nor blocks the press's handling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelAdapter, ChannelEvent } from "../../packages/shared/src/index.js";
import { ChannelHost } from "../../packages/control-plane/src/channel-host.js";
import { Governor } from "../../packages/control-plane/src/governor.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-sendfail-"));
}

/** An adapter whose every outbound call fails, the way the Telegram
 *  Bot API does when it rejects a send. */
class ThrowingAdapter implements ChannelAdapter {
  readonly name = "telegram";
  handler?: (ev: ChannelEvent) => void;
  async start(onEvent: (ev: ChannelEvent) => void): Promise<void> {
    this.handler = onEvent;
  }
  async stop(): Promise<void> {}
  async send(): Promise<void> {
    throw new Error("telegram sendMessage: Bad Request: chat not found");
  }
  async ackButton(): Promise<void> {
    throw new Error("telegram answerCallbackQuery: Bad Request: query is too old");
  }
}

function hostWith(dir: string, adapter: ThrowingAdapter): { host: ChannelHost; jobs: JobRunner } {
  const governor = new Governor(dir, { maxTokensPerJob: 100, maxTokensPerDay: 10_000 });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const host = new ChannelHost(dir, governor, jobs, [adapter]);
  return { host, jobs };
}

function events(dir: string): string {
  const p = join(dir, "events.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

test("send failure: notifyOperator resolves and the loss is logged, not fatal", async () => {
  const dir = freshDir();
  const { host } = hostWith(dir, new ThrowingAdapter());
  await host.notifyOperator("424242", "hello operator");
  const log = events(dir);
  assert.ok(log.includes('"kind":"send_failed"'), "send_failed event logged");
  assert.ok(log.includes("chat not found"), "the adapter's error is named in the log");
});

test("send failure: onJobFinal still settles the job when the result send throws", async () => {
  const dir = freshDir();
  const { host, jobs } = hostWith(dir, new ThrowingAdapter());
  const job = jobs.create("digest", "424242", "the daily digest");
  jobs.transition(job.id, "running");
  await host.onJobFinal(job.id, "digest output");
  const settled = jobs.get(job.id);
  assert.equal(settled?.state, "failed-loudly", "job settled (post-condition unverifiable without a model hash)");
  assert.ok(settled?.receiptId, "settlement issued a receipt");
  assert.ok(events(dir).includes('"kind":"send_failed"'), "the failed result send was logged");
});

test("ack failure: a throwing ackButton neither crashes the host nor blocks press handling", async () => {
  const dir = freshDir();
  const adapter = new ThrowingAdapter();
  const { host } = hostWith(dir, adapter);
  await host.start();
  assert.ok(adapter.handler, "adapter captured the host's event handler");
  adapter.handler!({
    type: "button",
    press: { conversationId: "424242", senderId: "1", buttonId: "bogus", callbackId: "cb-1" },
  });
  // onEvent runs behind a void promise in start()'s wiring; give its
  // awaited chain a chance to complete before reading the log.
  await new Promise((r) => setTimeout(r, 100));
  const log = events(dir);
  assert.ok(log.includes('"kind":"ack_failed"'), "ack failure logged");
  assert.ok(log.includes('"kind":"button_unknown"'), "press handling continued past the failed ack");
});
