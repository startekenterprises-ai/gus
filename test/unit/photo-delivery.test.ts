/**
 * v0.24.0: photo delivery — the iOS chat's photos reach the
 * core's brain.
 *
 * Before this build a photo attached in the iOS chat stayed on
 * the phone, marked "not sent": the core's chat channel took
 * text only. The delivery chain now is:
 *
 *   POST /api/chat {text, images} → PanelChatAdapter.submit
 *   (shape-checks and caps the photos; the transcript records
 *   only the COUNT) → ChannelEvent → ChannelHost (re-validates,
 *   logs the count on the job's event record, frames the prompt)
 *   → CommServer.pushUserMessage → runtime (first model request
 *   only) → CommServer → provider, which presents the images as
 *   image input in the API's own shape (OpenAI-compatible parts
 *   / Anthropic blocks, on both the text and native channels).
 *
 * These tests pin each hop that can be exercised offline: the
 * adapter's validation and count-only transcript, the host's
 * delivery of the images to the runtime boundary, and the
 * providers' request shapes with and without photos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelAdapter, ChannelEvent, MessageImage, OutboundMessage } from "../../packages/shared/src/index.js";
import { VaultBroker } from "../../packages/vault/src/index.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";
import { PanelChatAdapter, PANEL_CHAT_CONVERSATION } from "../../packages/control-plane/src/panel-chat.js";
import { ChannelHost } from "../../packages/control-plane/src/channel-host.js";
import { Governor } from "../../packages/control-plane/src/governor.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { ApprovalEngine } from "../../packages/control-plane/src/approvals.js";
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAiCompatibleProvider,
  type ProviderTransport,
} from "../../packages/control-plane/src/providers.js";

const PHOTO: MessageImage = {
  mediaType: "image/jpeg",
  data: Buffer.from("fake-jpeg-bytes-for-tests").toString("base64"),
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-photo-"));
}

function tempVault(dir: string, ...names: string[]): VaultBroker {
  const vault = new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key"));
  for (const name of names) vault.add(name, `unit-test-${name}-key`);
  return vault;
}

const tick = () => new Promise((r) => setTimeout(r, 25));

// ------------------------------------------------------------- adapter

test("photos: the panel adapter emits the images and records only the count", async () => {
  const dir = freshDir();
  const adapter = new PanelChatAdapter(dir);
  const events: ChannelEvent[] = [];
  await adapter.start((ev) => events.push(ev));

  const res = adapter.submit("what is in this picture?", [PHOTO]);
  assert.equal(res.ok, true);
  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.equal(ev.type, "message");
  if (ev.type === "message") {
    assert.deepEqual(ev.message.images, [PHOTO], "the image rides the channel event");
    assert.equal(ev.message.text, "what is in this picture?");
  }
  const history = adapter.history();
  assert.equal(history.length, 1);
  assert.equal(history[0]?.photos, 1, "the transcript records the photo count");
  const raw = readFileSync(join(dir, "chat.jsonl"), "utf8");
  assert.ok(!raw.includes(PHOTO.data), "the image data itself is never recorded");
});

test("photos: a photo-only submission is a real message; an empty one is not", async () => {
  const dir = freshDir();
  const adapter = new PanelChatAdapter(dir);
  const events: ChannelEvent[] = [];
  await adapter.start((ev) => events.push(ev));

  const photoOnly = adapter.submit("", [PHOTO]);
  assert.equal(photoOnly.ok, true, "no caption + a photo still sends");
  assert.equal(events.length, 1);

  const empty = adapter.submit("   ");
  assert.equal(empty.ok, false, "no words and no photo is still refused");
  assert.equal(events.length, 1, "the refused submission emitted nothing");
});

test("photos: unusable attachments refuse the whole submission — nothing is silently dropped", async () => {
  const dir = freshDir();
  const adapter = new PanelChatAdapter(dir);
  const events: ChannelEvent[] = [];
  await adapter.start((ev) => events.push(ev));

  const notAnImage = adapter.submit("look", [{ mediaType: "text/plain", data: PHOTO.data }]);
  assert.equal(notAnImage.ok, false);
  assert.match(notAnImage.detail, /isn't a usable image/);

  const tooMany = adapter.submit("look", [PHOTO, PHOTO, PHOTO, PHOTO, PHOTO]);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.detail, /Too many photos/);

  const badBase64 = adapter.submit("look", [{ mediaType: "image/png", data: "!!! not base64 !!!" }]);
  assert.equal(badBase64.ok, false);

  assert.equal(events.length, 0, "no refused submission emitted an event");
  assert.equal(adapter.history().length, 0, "and nothing was recorded");
});

// ---------------------------------------------------------------- host

class StubAdapter implements ChannelAdapter {
  readonly name = "telegram";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(_msg: OutboundMessage): Promise<void> {}
}

test("photos: the host delivers the images to the runtime boundary and logs the count", async () => {
  const dir = freshDir();
  const governor = new Governor(dir, { maxTokensPerJob: 100_000, maxTokensPerDay: 10_000_000 });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const approvals = new ApprovalEngine(dir, () => 120_000);
  const panelChat = new PanelChatAdapter(dir);
  const host = new ChannelHost(dir, governor, jobs, [new StubAdapter(), panelChat], approvals, undefined);
  const pushed: { jobId: string; kind: string; text: string; images?: MessageImage[] }[] = [];
  host.attachComm({
    pushUserMessage: (m: { jobId: string; kind: string; text: string; images?: MessageImage[] }) =>
      pushed.push(m),
    broadcast: () => {},
    executeApproval: () => {},
  } as never);
  await host.start();

  const res = panelChat.submit("what is in this picture?", [PHOTO]);
  assert.equal(res.ok, true);
  await tick();

  assert.equal(pushed.length, 1, "one job was pushed to the runtime");
  assert.deepEqual(pushed[0]?.images, [PHOTO], "the images crossed the comm boundary with the job");
  assert.match(pushed[0]?.text ?? "", /attached 1 photo/, "the runtime prompt frames the photo");

  const events = readFileSync(join(dir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind?: string; photoCount?: number; jobId?: string });
  const photoEvent = events.find((e) => e.kind === "message_photos");
  assert.ok(photoEvent, "the job's event record carries the photo count");
  assert.equal(photoEvent?.photoCount, 1);
  assert.equal(photoEvent?.jobId, pushed[0]?.jobId);
  assert.ok(!JSON.stringify(events).includes(PHOTO.data), "no image data in the event log");
});

// ------------------------------------------------------------ providers

function openAiTransport(seen: { body?: string }[]): ProviderTransport {
  return async (_url, init) => {
    seen.push({ body: init.body });
    return {
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "I see a cat." } }],
        usage: { prompt_tokens: 21, completion_tokens: 5 },
      }),
    };
  };
}

function anthropicTransport(seen: { body?: string }[]): ProviderTransport {
  return async (_url, init) => {
    seen.push({ body: init.body });
    return {
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "I see a cat." }],
        usage: { input_tokens: 21, output_tokens: 5 },
      }),
    };
  };
}

test("photos: the OpenAI-compatible text channel sends the image as a data-URL part", async () => {
  const dir = freshDir();
  const seen: { body?: string }[] = [];
  const gemini = new GeminiProvider(tempVault(dir, "gemini"), "gemini-3.5-flash", {
    transport: openAiTransport(seen),
  });
  const out = await gemini.complete("what is in this picture?", { images: [PHOTO] });
  assert.equal(out.reply.text, "I see a cat.");
  const body = JSON.parse(seen[0]?.body ?? "{}") as {
    messages: { content: unknown }[];
  };
  const content = body.messages[0]?.content as { type: string; text?: string; image_url?: { url: string } }[];
  assert.ok(Array.isArray(content), "content became a parts array");
  assert.equal(content[0]?.type, "text");
  assert.match(content[0]?.text ?? "", /what is in this picture\?/);
  assert.equal(content[1]?.type, "image_url");
  assert.equal(content[1]?.image_url?.url, `data:image/jpeg;base64,${PHOTO.data}`);
});

test("photos: without images the OpenAI-compatible content stays the plain string", async () => {
  const dir = freshDir();
  const seen: { body?: string }[] = [];
  const gemini = new GeminiProvider(tempVault(dir, "gemini"), "gemini-3.5-flash", {
    transport: openAiTransport(seen),
  });
  await gemini.complete("hello");
  const body = JSON.parse(seen[0]?.body ?? "{}") as { messages: { content: unknown }[] };
  assert.equal(typeof body.messages[0]?.content, "string", "byte-for-byte the pre-photo shape");
});

test("photos: the Anthropic text channel sends the image as a base64 image block", async () => {
  const dir = freshDir();
  const seen: { body?: string }[] = [];
  const anthropic = new AnthropicProvider(tempVault(dir, "anthropic"), "claude-sonnet-5", {
    transport: anthropicTransport(seen),
  });
  const out = await anthropic.complete("what is in this picture?", { images: [PHOTO] });
  assert.equal(out.reply.text, "I see a cat.");
  const body = JSON.parse(seen[0]?.body ?? "{}") as {
    messages: { content: unknown }[];
  };
  const content = body.messages[0]?.content as {
    type: string;
    text?: string;
    source?: { type: string; media_type: string; data: string };
  }[];
  assert.ok(Array.isArray(content), "content became a block array");
  assert.equal(content[0]?.type, "image");
  assert.deepEqual(content[0]?.source, { type: "base64", media_type: "image/jpeg", data: PHOTO.data });
  assert.equal(content[1]?.type, "text");
  assert.match(content[1]?.text ?? "", /what is in this picture\?/);
});

test("photos: the native channel carries the image inside the opening user message", async () => {
  const dir = freshDir();
  const seen: { body?: string }[] = [];
  const openai = new OpenAiCompatibleProvider(tempVault(dir, "openai"), {
    id: "openai",
    model: "gpt-test",
    baseUrl: "https://api.openai.com/v1",
    keyName: "openai",
    keyRequired: true,
    who: "OpenAI",
    transport: openAiTransport(seen),
    nativeTools: true,
  });
  const out = await openai.complete("unused on the native channel", {
    messages: [{ role: "user", text: "what is in this picture?", images: [PHOTO] }],
  });
  assert.equal(out.reply.text, "I see a cat.");
  const body = JSON.parse(seen[0]?.body ?? "{}") as {
    messages: { content: unknown }[];
    tools?: unknown[];
  };
  assert.ok(Array.isArray(body.tools), "the native request still carries the tool definitions");
  const content = body.messages[0]?.content as { type: string; image_url?: { url: string } }[];
  assert.ok(Array.isArray(content), "the opening user message became parts");
  assert.equal(content[1]?.type, "image_url");
  assert.equal(content[1]?.image_url?.url, `data:image/jpeg;base64,${PHOTO.data}`);
});

test("photos: the Anthropic native channel carries the image as an image block", async () => {
  const dir = freshDir();
  const seen: { body?: string }[] = [];
  const anthropic = new AnthropicProvider(tempVault(dir, "anthropic"), "claude-sonnet-5", {
    transport: anthropicTransport(seen),
  });
  const out = await anthropic.complete("unused on the native channel", {
    messages: [{ role: "user", text: "what is in this picture?", images: [PHOTO] }],
  });
  assert.equal(out.reply.text, "I see a cat.");
  const body = JSON.parse(seen[0]?.body ?? "{}") as {
    messages: { content: unknown }[];
  };
  const content = body.messages[0]?.content as {
    type: string;
    source?: { type: string; media_type: string; data: string };
  }[];
  assert.ok(Array.isArray(content), "the opening user message became blocks");
  assert.equal(content[0]?.type, "image");
  assert.deepEqual(content[0]?.source, { type: "base64", media_type: "image/jpeg", data: PHOTO.data });
});
