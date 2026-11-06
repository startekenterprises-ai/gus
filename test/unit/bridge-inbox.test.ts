/**
 * Bridge Inbox (Phase 10) — file-based delegate ingress.
 *
 * Telegram never delivers bot messages to other bots, so the
 * delegate's requests arrive as files. What is pinned here:
 *  - A request file becomes exactly one channel message event,
 *    carrying the bridge binding's conversation and sender (the
 *    delegate identity — the host's sender gate does the rest).
 *  - The file is archived to processed/ either way; malformed or
 *    textless requests are parked as .bad and never emitted.
 *  - Without a bridge binding in delegates.json the adapter is
 *    inert: files wait untouched.
 *  - Files emit in name order; a repeated request id never emits
 *    twice.
 *  - send() forwards through the configured outbound route; with
 *    none, it throws (the host logs the loss — never silent).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelEvent, OutboundMessage } from "../../packages/shared/src/index.js";
import { BridgeInboxAdapter } from "../../packages/control-plane/src/bridge-inbox.js";

const GROUP = "-100999";
const NOVA = "222";

interface Rig {
  dir: string;
  events: ChannelEvent[];
  sent: OutboundMessage[];
  adapter: BridgeInboxAdapter;
  onEvent: (ev: ChannelEvent) => void;
}

function rig(withBridge: boolean, withSend = true): Rig {
  const dir = mkdtempSync(join(tmpdir(), "gus-bridge-"));
  writeFileSync(
    join(dir, "delegates.json"),
    JSON.stringify({
      conversations: {
        [GROUP]: { operatorId: "111", delegates: [{ senderId: NOVA, name: "Nova" }] },
      },
      ...(withBridge ? { bridge: { conversationId: GROUP, senderId: NOVA } } : {}),
    }),
  );
  mkdirSync(join(dir, "bridge-inbox", "processed"), { recursive: true });
  const events: ChannelEvent[] = [];
  const sent: OutboundMessage[] = [];
  const adapter = new BridgeInboxAdapter(
    dir,
    withSend ? { sendVia: async (m) => void sent.push(m) } : {},
  );
  return { dir, events, sent, adapter, onEvent: (ev) => events.push(ev) };
}

function drop(r: Rig, name: string, body: unknown): void {
  writeFileSync(
    join(r.dir, "bridge-inbox", name),
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

function inboxHas(r: Rig, name: string): boolean {
  return existsSync(join(r.dir, "bridge-inbox", name));
}
function processedHas(r: Rig, name: string): boolean {
  return existsSync(join(r.dir, "bridge-inbox", "processed", name));
}

test("a request file becomes one delegate message event and is archived", () => {
  const r = rig(true);
  drop(r, "1700000000000-a.json", { id: "req-1", text: "open the calculator", ts: 1 });
  r.adapter.pollOnce(r.onEvent);
  assert.equal(r.events.length, 1);
  const ev = r.events[0];
  assert.equal(ev.type, "message");
  if (ev.type === "message") {
    assert.equal(ev.message.conversationId, GROUP);
    assert.equal(ev.message.senderId, NOVA, "arrives AS the delegate, never the operator");
    assert.equal(ev.message.text, "open the calculator");
    assert.equal(ev.message.messageId, "req-1");
  }
  assert.equal(inboxHas(r, "1700000000000-a.json"), false);
  assert.equal(processedHas(r, "1700000000000-a.json"), true);
});

test("without a bridge binding the adapter is inert and files wait", () => {
  const r = rig(false);
  drop(r, "1700000000000-a.json", { id: "req-1", text: "open the calculator" });
  r.adapter.pollOnce(r.onEvent);
  assert.equal(r.events.length, 0);
  assert.equal(inboxHas(r, "1700000000000-a.json"), true, "untouched until a binding exists");
});

test("malformed and textless requests are parked as .bad, never emitted", () => {
  const r = rig(true);
  drop(r, "1700000000000-a.json", "{not json");
  drop(r, "1700000000001-b.json", { id: "req-2", text: "" });
  r.adapter.pollOnce(r.onEvent);
  assert.equal(r.events.length, 0);
  assert.equal(processedHas(r, "1700000000000-a.json.bad"), true);
  assert.equal(processedHas(r, "1700000000001-b.json.bad"), true);
});

test("files emit in name order and a repeated id never emits twice", () => {
  const r = rig(true);
  drop(r, "1700000000002-c.json", { id: "req-3", text: "third" });
  drop(r, "1700000000000-a.json", { id: "req-1", text: "first" });
  drop(r, "1700000000001-b.json", { id: "req-1", text: "first again, same id" });
  r.adapter.pollOnce(r.onEvent);
  const texts = r.events.map((e) => (e.type === "message" ? e.message.text : ""));
  assert.deepEqual(texts, ["first", "third"]);
});

test("send forwards through the outbound route; without one it throws", async () => {
  const r = rig(true);
  await r.adapter.send({ conversationId: GROUP, text: "operator-only refusal" });
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].text, "operator-only refusal");
  const bare = rig(true, false);
  await assert.rejects(() => bare.adapter.send({ conversationId: GROUP, text: "x" }), /no outbound route/);
});
