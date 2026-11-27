/**
 * v0.34.0: the privacy pack — tombstone deletion and the
 * incognito boundary pins.
 *
 * Pinned here:
 *  - The merge core's tombstones: validation (a tombstone
 *    never names itself), union merge with deterministic
 *    order and never-dropped conflicts, and application —
 *    a tombstone wins over its target WHENEVER the target
 *    arrives, including after it (tombstone-first).
 *  - The core store (PanelChatAdapter): a pushed tombstone
 *    removes the message from the canonical view AND from
 *    the raw transcript file (content physically gone, not
 *    hidden), archives nothing of it, and the deletion is
 *    durable across re-syncs — a peer still holding the
 *    message can never resurrect it, and a fresh empty
 *    phone is offered the tombstones, not the messages.
 *  - A core-born deletion (deleteMessage) reaches a peer
 *    through the same have/want exchange.
 *  - The live door refuses a tombstoned identity: a deleted
 *    message cannot be submitted back into existence.
 *  - The iOS sources: the Swift store mirrors the tombstone
 *    model; the incognito send path never touches the
 *    store; ephemeral receipts never touch the log file;
 *    incognito state is memory-only; Settings carries the
 *    delete-all hammer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  applyChatTombstones,
  chatTombstoneTargets,
  chatTombstonesMissingFrom,
  mergeChatTombstones,
  validateSyncedChatTombstone,
  type SyncedChatMessage,
  type SyncedChatTombstone,
} from "../../packages/shared/src/index.js";
import { PanelChatAdapter, type ChatSubmitIdentity } from "../../packages/control-plane/src/panel-chat.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-chatprivacy-"));
}

async function startedAdapter(dir: string): Promise<PanelChatAdapter> {
  const adapter = new PanelChatAdapter(dir);
  await adapter.start(() => {});
  return adapter;
}

let n = 0;
function tomb(partial: Partial<SyncedChatTombstone> = {}): SyncedChatTombstone {
  n += 1;
  return {
    kind: "tombstone",
    id: `tomb-${n}`,
    deviceId: "dev-a",
    seq: n,
    prevId: null,
    ts: 2_000_000 + n,
    targetId: `target-${n}`,
    ...partial,
  };
}

function phoneMsg(partial: Partial<SyncedChatMessage> = {}): SyncedChatMessage {
  n += 1;
  return {
    id: randomUUID(),
    deviceId: "phone-device",
    seq: n,
    prevId: null,
    ts: 3_000_000 + n,
    direction: "in",
    text: `phone words ${n}`,
    ...partial,
  };
}

// ------------------------------------------------------------ merge core

test("tombstone validate: well-formed passes; self-target and malformed refused", () => {
  const good = tomb();
  assert.deepEqual(validateSyncedChatTombstone(good), good);
  for (const bad of [
    null,
    "nope",
    { ...good, kind: "message" },
    { ...good, id: "" },
    { ...good, targetId: "" },
    { ...good, targetId: good.id }, // a tombstone never names itself
    { ...good, seq: -1 },
    { ...good, seq: 1.5 },
    { ...good, prevId: 42 },
    { ...good, ts: Number.NaN },
  ]) {
    assert.equal(
      validateSyncedChatTombstone(bad),
      undefined,
      JSON.stringify(bad)?.slice(0, 60),
    );
  }
});

test("tombstone merge: union, deterministic order, conflicts never dropped", () => {
  const a = tomb({ id: "t-1", deviceId: "dev-a", seq: 3 });
  const b = tomb({ id: "t-2", deviceId: "dev-b", seq: 1 });
  const c = tomb({ id: "t-3", deviceId: "dev-a", seq: 5 });
  const merged = mergeChatTombstones([c, a], [b, a]);
  assert.deepEqual(
    merged.tombstones.map((t) => t.id),
    ["t-1", "t-3", "t-2"], // deviceId first (dev-a before dev-b), then seq
  );
  assert.equal(merged.conflicts.length, 0);

  // A divergent copy of the same tombstone ID: the pair is
  // reported, the deterministic winner is kept, and the
  // result does not depend on argument order.
  const divergent = { ...a, targetId: "someone-else" };
  const forward = mergeChatTombstones([a], [divergent]);
  const backward = mergeChatTombstones([divergent], [a]);
  assert.equal(forward.conflicts.length, 1);
  assert.deepEqual(forward.tombstones, backward.tombstones);
  assert.equal(forward.tombstones.length, 1);
});

test("apply: a tombstone suppresses its target whenever the target arrives", () => {
  const target = phoneMsg();
  const stone = tomb({ targetId: target.id });
  // Message first, tombstone second.
  assert.deepEqual(applyChatTombstones([target], [stone]), []);
  // Tombstone first, message second — the ordering the
  // whole design exists for.
  assert.deepEqual(applyChatTombstones([], [stone]).length, 0);
  const later = applyChatTombstones([target], [stone]);
  assert.deepEqual(later, []);
  // Unrelated messages pass through untouched.
  const other = phoneMsg();
  assert.deepEqual(applyChatTombstones([target, other], [stone]).map((m) => m.id), [other.id]);
  assert.deepEqual([...chatTombstoneTargets([stone])], [target.id]);
});

test("missing-from: have/want arithmetic runs over tombstones too", () => {
  const a = tomb({ id: "t-a" });
  const b = tomb({ id: "t-b" });
  assert.deepEqual(
    chatTombstonesMissingFrom([a, b], new Set(["t-a"])).map((t) => t.id),
    ["t-b"],
  );
  assert.deepEqual(chatTombstonesMissingFrom([a, b], new Set(["t-a", "t-b"])), []);
});

// ------------------------------------------------------------ core store

test("adapter: a pushed tombstone removes the message from the view AND the file, archiving nothing", async () => {
  const dir = freshDir();
  const adapter = await startedAdapter(dir);
  const secret = phoneMsg({ text: "words that must go" });
  const keeper = phoneMsg({ text: "words that stay", prevId: secret.id });
  adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: [secret.id, keeper.id],
    messages: [secret, keeper],
  });
  assert.equal(adapter.syncMessages().length, 2);

  const stone = tomb({ id: randomUUID(), deviceId: "phone-device", targetId: secret.id });
  const result = adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: [secret.id, keeper.id, stone.id],
    tombstones: [stone],
  });
  assert.equal(result.conflicts, 0);
  assert.deepEqual(adapter.syncMessages().map((m) => m.id), [keeper.id]);
  assert.deepEqual(adapter.syncTombstones().map((t) => t.id), [stone.id]);

  // The content is physically gone from the transcript
  // file — not filtered at read time.
  const raw = readFileSync(join(dir, "chat.jsonl"), "utf8");
  assert.ok(!raw.includes("words that must go"), "tombstoned text must leave the file");
  assert.ok(raw.includes("words that stay"));
  assert.ok(raw.includes(stone.id), "the tombstone itself is filed (it carries no content)");

  // A tombstoned message is not a conflict: nothing of it
  // is archived anywhere.
  const conflictsPath = join(dir, "chat-sync-conflicts.jsonl");
  if (existsSync(conflictsPath)) {
    assert.ok(!readFileSync(conflictsPath, "utf8").includes("words that must go"));
  }
});

test("adapter: tombstone-first — a message pushed after its tombstone is refused, never wanted", async () => {
  const dir = freshDir();
  const adapter = await startedAdapter(dir);
  const ghost = phoneMsg({ text: "deleted before it ever arrived" });
  const stone = tomb({ id: randomUUID(), deviceId: "phone-device", targetId: ghost.id });

  // The tombstone lands first.
  adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: [stone.id],
    tombstones: [stone],
  });
  // The message itself is pushed later (a peer that was
  // offline when the delete happened): refused, not filed.
  const refused = adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: [stone.id, ghost.id],
    messages: [ghost],
  });
  assert.deepEqual(adapter.syncMessages(), []);
  assert.ok(!readFileSync(join(dir, "chat.jsonl"), "utf8").includes("deleted before it ever arrived"));

  // And the core never ASKS for the deleted ID: a peer
  // naming only the tombstone is told it lacks nothing and
  // the core wants nothing.
  assert.deepEqual(refused.wantIds, []);
  assert.deepEqual(refused.missing, []);
  assert.deepEqual(refused.missingTombstones, []);
});

test("adapter: delete-all durability — a fresh phone gets tombstones, not messages, and nothing resurrects", async () => {
  const dir = freshDir();
  const adapter = await startedAdapter(dir);
  const one = phoneMsg({ text: "first secret" });
  const two = phoneMsg({ text: "second secret", prevId: one.id });
  adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: [one.id, two.id],
    messages: [one, two],
  });
  const stones = [one, two].map((m, i) =>
    tomb({
      id: randomUUID(),
      deviceId: "phone-device",
      seq: 100 + i,
      targetId: m.id,
    }),
  );
  adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: [one.id, two.id, ...stones.map((s) => s.id)],
    tombstones: stones,
  });
  assert.deepEqual(adapter.syncMessages(), []);

  // A FRESH phone (empty store) syncing against the
  // tombstoned core is offered the tombstones — the
  // messages are not on offer at all.
  const fresh = adapter.syncExchange({ deviceId: "fresh-phone", haveIds: [] });
  assert.deepEqual(fresh.missing, []);
  assert.deepEqual(
    new Set(fresh.missingTombstones.map((t) => t.id)),
    new Set(stones.map((s) => s.id)),
  );

  // The old phone re-syncs still holding its copies: the
  // core refuses them again — no resurrection across any
  // number of further exchanges.
  adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: [one.id, two.id, ...stones.map((s) => s.id)],
    messages: [one, two],
  });
  assert.deepEqual(adapter.syncMessages(), []);
  const raw = readFileSync(join(dir, "chat.jsonl"), "utf8");
  assert.ok(!raw.includes("first secret") && !raw.includes("second secret"));
});

test("adapter: a core-born deleteMessage reaches the peer through missingTombstones", async () => {
  const dir = freshDir();
  const adapter = await startedAdapter(dir);
  adapter.submit("desk words to delete");
  const filed = adapter.syncMessages()[0];
  const stone = adapter.deleteMessage(filed.id);
  assert.equal(stone.targetId, filed.id);
  assert.equal(stone.deviceId, adapter.syncDeviceId());
  assert.deepEqual(adapter.syncMessages(), []);
  assert.ok(
    !readFileSync(join(dir, "chat.jsonl"), "utf8").includes("desk words to delete"),
  );

  // A phone that still holds the message learns of the
  // deletion in the exchange — and the core does not ask
  // for the deleted message back.
  const answer = adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: [filed.id],
  });
  assert.deepEqual(answer.missingTombstones.map((t) => t.id), [stone.id]);
  assert.deepEqual(answer.wantIds, []);
});

test("adapter: the live door refuses a tombstoned identity", async () => {
  const dir = freshDir();
  const adapter = await startedAdapter(dir);
  const doomed = phoneMsg({ text: "held words, deleted before approval" });
  adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: [doomed.id],
    messages: [doomed],
  });
  const stone = tomb({ id: randomUUID(), deviceId: "phone-device", targetId: doomed.id });
  adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: [doomed.id, stone.id],
    tombstones: [stone],
  });
  assert.deepEqual(adapter.syncMessages(), []);

  // The operator's late "send it anyway" arrives at the
  // live door under the deleted identity: refused in plain
  // words, nothing emitted, nothing recorded.
  const identity: ChatSubmitIdentity = {
    id: doomed.id,
    deviceId: doomed.deviceId,
    seq: doomed.seq,
    prevId: doomed.prevId,
    ts: doomed.ts,
  };
  const result = adapter.submit("held words, deleted before approval", undefined, identity);
  assert.equal(result.ok, false);
  assert.ok(result.detail?.includes("deleted"), result.detail);
  assert.deepEqual(adapter.syncMessages(), []);
});

// ------------------------------------------------------------ iOS source pins

const iosRoot = join(process.cwd(), "apps/ios");
const chatStore = readFileSync(join(iosRoot, "App/ChatHistoryStore.swift"), "utf8");
const chatView = readFileSync(join(iosRoot, "App/ChatView.swift"), "utf8");
const settingsView = readFileSync(join(iosRoot, "App/SettingsView.swift"), "utf8");
const callSession = readFileSync(join(iosRoot, "Shared/CallSession.swift"), "utf8");
const incognitoMode = readFileSync(join(iosRoot, "Shared/IncognitoMode.swift"), "utf8");
const shieldReceipts = readFileSync(
  join(iosRoot, "Packages/ShieldKit/Sources/ShieldKit/ShieldReceipts.swift"),
  "utf8",
);

/** The body of one Swift function: from its declaration to
 * the next declaration at the same level (or a marker). */
function swiftBody(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

test("ios pin: the Swift store mirrors the tombstone model", () => {
  assert.ok(chatStore.includes("struct SyncedChatTombstone"));
  assert.ok(chatStore.includes('encode("tombstone", forKey: .kind)'));
  assert.ok(chatStore.includes("func deleteLocal(targetId:"));
  assert.ok(chatStore.includes("func deleteAllLocal()"));
  assert.ok(chatStore.includes("tombstonedTargets"));
  // The suppression runs at ingest, before the message fold.
  const ingest = swiftBody(chatStore, "func ingest(", "// MARK: Storage");
  assert.ok(ingest.indexOf("incomingTombstones") < ingest.indexOf("for raw in incoming {"));
});

test("ios pin: incognito messages are never born into the store", () => {
  const send = swiftBody(chatView, "private func sendIncognito(", "private func dispatchIncognito(");
  assert.ok(!send.includes("appendLocal"), "incognito must bypass store-birth");
  assert.ok(!send.includes("store."), "incognito must not touch the store at all");
  assert.ok(send.includes("ShieldScanner.scan"), "the Shield gate still scans in incognito");
  // The fork sits in send() ahead of the store-born path.
  const fork = chatView.indexOf("if incognito {");
  const birth = chatView.indexOf("store.appendLocal(\n            direction: \"in\"");
  assert.ok(fork > 0 && (birth < 0 || fork < birth), "the incognito fork precedes store-birth");
  // And the on-device reply path skips the store for
  // incognito exchanges too.
  assert.ok(chatView.includes("incognitoExchangeIDs.contains(exchangeID)"));
});

test("ios pin: ephemeral receipts never touch the persistent log", () => {
  const body = swiftBody(
    shieldReceipts,
    "public func recordEphemeral(",
    "private func buildReceipt(",
  );
  assert.ok(!body.includes("appendLine"), "ephemeral receipts are never written to the file");
  assert.ok(!body.includes("receipts.append"), "ephemeral receipts never join the chain");
  assert.ok(!body.includes("lastHash ="), "ephemeral receipts never move the chain head");
  // Chat and calls both route through the ephemeral seam.
  assert.ok(chatView.includes("recordEphemeral"));
  assert.ok(callSession.includes("recordEphemeral"));
  assert.ok(callSession.includes("IncognitoMode.shared.isOn"));
});

test("ios pin: incognito state is memory-only and the delete UI is wired", () => {
  assert.ok(!incognitoMode.includes("UserDefaults.standard"), "incognito state is never persisted");
  assert.ok(incognitoMode.includes("@Published var isOn = false"));
  assert.ok(chatView.includes("eye.slash"), "the ghost toggle is in the chat header");
  assert.ok(chatView.includes("never saved and disappears when you leave incognito"));
  assert.ok(settingsView.includes("Delete chat history"));
  assert.ok(settingsView.includes("deleteAllLocal()"));
  assert.ok(settingsView.includes("Shield security receipts are not chat content"));
});
