/**
 * v0.26.0: chat-history sync — the core's store (PanelChatAdapter)
 * and one full phone↔core convergence.
 *
 * Pinned here:
 *  - Legacy migration: pre-sync transcript entries gain IDs in
 *    file order, chained by prevId, under the core's persisted
 *    device ID — once, stably, with non-transcript lines and a
 *    torn tail preserved byte-for-byte.
 *  - The two doors: submit-with-identity is LIVE (records under
 *    the creating device's identity and emits exactly once;
 *    a retry emits nothing), while sync ingest is HISTORY
 *    (records verbatim, emits never).
 *  - Conflicts: a divergent copy is archived whole to
 *    chat-sync-conflicts.jsonl and the canonical view holds
 *    the deterministic winner.
 *  - Convergence: a phone-side store (a plain array folded by
 *    the shared merge core, standing in for the Swift mirror)
 *    and the core's store reach the same canonical set after
 *    the two-step exchange, with offline branches on both
 *    sides preserved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChannelEvent, SyncedChatMessage } from "../../packages/shared/src/index.js";
import { mergeChatMessages } from "../../packages/shared/src/index.js";
import {
  PANEL_CHAT_CONVERSATION,
  PanelChatAdapter,
  type ChatSubmitIdentity,
} from "../../packages/control-plane/src/panel-chat.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-chatsync-"));
}

function readChatLines(dir: string): Record<string, unknown>[] {
  const raw = readFileSync(join(dir, "chat.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function startedAdapter(dir: string): Promise<{
  adapter: PanelChatAdapter;
  events: ChannelEvent[];
}> {
  const adapter = new PanelChatAdapter(dir);
  const events: ChannelEvent[] = [];
  await adapter.start((ev) => events.push(ev));
  return { adapter, events };
}

// ------------------------------------------------------------ migration

test("migration: legacy entries gain chained identities once, stably", async () => {
  const dir = freshDir();
  const legacy = [
    { conversationId: PANEL_CHAT_CONVERSATION, ts: 1000, direction: "in", text: "hello" },
    { conversationId: "some-other-conversation", ts: 1001, direction: "in", text: "not ours" },
    { conversationId: PANEL_CHAT_CONVERSATION, ts: 1002, direction: "out", text: "hi there" },
    { conversationId: PANEL_CHAT_CONVERSATION, ts: 1003, direction: "in", text: "a photo", photos: 1 },
  ];
  writeFileSync(
    join(dir, "chat.jsonl"),
    legacy.map((l) => JSON.stringify(l)).join("\n") + "\n" + '{"torn tail',
  );

  const { adapter } = await startedAdapter(dir);
  const history = adapter.history();
  assert.equal(history.length, 3);
  const deviceId = adapter.syncDeviceId();
  assert.ok(deviceId.length > 0);
  // Chained in file order under the core's device ID.
  assert.equal(history[0].deviceId, deviceId);
  assert.equal(history[0].prevId, null);
  assert.equal(history[1].prevId, history[0].id);
  assert.equal(history[2].prevId, history[1].id);
  assert.deepEqual(history.map((h) => h.seq), [1, 2, 3]);
  assert.equal(history[2].photos, 1);
  // The device ID persisted.
  const identityFile = JSON.parse(readFileSync(join(dir, "chat-sync.json"), "utf8")) as {
    deviceId: string;
  };
  assert.equal(identityFile.deviceId, deviceId);
  // Non-transcript line + torn tail preserved byte-for-byte.
  const rawAfter = readFileSync(join(dir, "chat.jsonl"), "utf8");
  assert.ok(rawAfter.includes('"some-other-conversation"'));
  assert.ok(rawAfter.endsWith('{"torn tail'));

  // A second adapter over the same state sees the SAME ids —
  // migration does not churn.
  const fileBefore = readFileSync(join(dir, "chat.jsonl"), "utf8");
  const { adapter: second } = await startedAdapter(dir);
  assert.deepEqual(
    second.syncMessages().map((m) => m.id),
    adapter.syncMessages().map((m) => m.id),
  );
  assert.equal(readFileSync(join(dir, "chat.jsonl"), "utf8"), fileBefore);
});

// ------------------------------------------------------------ the live door

test("live door: submit without identity mints core-born records, chained to the head", async () => {
  const dir = freshDir();
  const { adapter, events } = await startedAdapter(dir);
  const result = adapter.submit("first words");
  assert.equal(result.ok, true);
  assert.equal(events.length, 1);
  await adapter.send({
    conversationId: PANEL_CHAT_CONVERSATION,
    text: "first answer",
  } as never);
  const messages = adapter.syncMessages();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].direction, "in");
  assert.equal(messages[1].direction, "out");
  assert.equal(messages[1].prevId, messages[0].id);
  assert.equal(messages[0].deviceId, adapter.syncDeviceId());
  assert.deepEqual(messages.map((m) => m.seq), [1, 2]);
});

test("live door: a phone-born identity is recorded verbatim and emitted exactly once", async () => {
  const dir = freshDir();
  const { adapter, events } = await startedAdapter(dir);
  const identity: ChatSubmitIdentity = {
    id: randomUUID(),
    deviceId: "phone-device",
    seq: 7,
    prevId: null,
    ts: 4242,
  };
  const first = adapter.submit("from the phone", undefined, identity);
  assert.equal(first.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "message");
  if (events[0].type === "message") assert.equal(events[0].message.messageId, identity.id);
  const stored = adapter.syncMessages();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].deviceId, "phone-device");
  assert.equal(stored[0].seq, 7);
  assert.equal(stored[0].ts, 4242);

  // The retry (the first response was lost): ok, but no second
  // record and no second emission.
  const retry = adapter.submit("from the phone", undefined, identity);
  assert.equal(retry.ok, true);
  assert.equal(events.length, 1);
  assert.equal(adapter.syncMessages().length, 1);
  assert.equal(readChatLines(dir).length, 1);
});

// ------------------------------------------------------------ the history door

test("history door: ingest records verbatim and NEVER emits", async () => {
  const dir = freshDir();
  const { adapter, events } = await startedAdapter(dir);
  const phoneMsg: SyncedChatMessage = {
    id: randomUUID(),
    deviceId: "phone-device",
    seq: 1,
    prevId: null,
    ts: 5000,
    direction: "in",
    text: "asked while offline",
  };
  const phoneReply: SyncedChatMessage = {
    id: randomUUID(),
    deviceId: "phone-device",
    seq: 2,
    prevId: phoneMsg.id,
    ts: 5001,
    direction: "out",
    text: "answered on-device",
  };
  const result = adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: [phoneMsg.id, phoneReply.id],
    messages: [phoneReply, phoneMsg], // pushed out of order on purpose
  });
  assert.equal(events.length, 0);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(result.wantIds, []);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(
    adapter.syncMessages().map((m) => m.id),
    [phoneMsg.id, phoneReply.id],
  );

  // The peer's have/want arithmetic from the other side: a
  // caller holding only the first record is offered the
  // second, and the core wants nothing it already holds.
  const partial = adapter.syncExchange({ deviceId: "phone-device", haveIds: [phoneMsg.id] });
  assert.deepEqual(partial.missing.map((m) => m.id), [phoneReply.id]);
  assert.deepEqual(partial.wantIds, []);
  const empty = adapter.syncExchange({ deviceId: "other", haveIds: [randomUUID()] });
  assert.equal(empty.missing.length, 2);
  assert.equal(empty.wantIds.length, 1);
});

test("the doors meet: a history-ingested message submits live exactly once, and never after an answer", async () => {
  const dir = freshDir();
  const { adapter, events } = await startedAdapter(dir);
  // A message the phone held (Shield quarantine), synced as
  // history before the operator's OK arrived.
  const held: SyncedChatMessage = {
    id: randomUUID(),
    deviceId: "phone-device",
    seq: 3,
    prevId: null,
    ts: 7000,
    direction: "in",
    text: "held, then approved",
  };
  adapter.syncExchange({ deviceId: "phone-device", haveIds: [held.id], messages: [held] });
  assert.equal(events.length, 0);

  // The OK: the phone submits it live under the same identity.
  // The core emits — this is its first dispatch — without
  // recording a second copy.
  const identity: ChatSubmitIdentity = {
    id: held.id,
    deviceId: held.deviceId,
    seq: held.seq,
    prevId: held.prevId,
    ts: held.ts,
  };
  const sent = adapter.submit("held, then approved", undefined, identity);
  assert.equal(sent.ok, true);
  assert.equal(events.length, 1);
  assert.equal(adapter.syncMessages().length, 1);

  // A retry after that is the plain idempotent case again.
  const retry = adapter.submit("held, then approved", undefined, identity);
  assert.equal(retry.ok, true);
  assert.equal(events.length, 1);

  // And once an answer exists, even a fresh process (the
  // in-memory provenance is rebuilt from the file's via marks,
  // and the answer check is structural) never re-dispatches.
  await adapter.send({ conversationId: PANEL_CHAT_CONVERSATION, text: "the answer" } as never);
  const { adapter: restarted, events: restartedEvents } = await startedAdapter(dir);
  const afterRestart = restarted.submit("held, then approved", undefined, identity);
  assert.equal(afterRestart.ok, true);
  assert.equal(restartedEvents.length, 0);
});

test("history door: a divergent copy is archived and the view holds the deterministic winner", async () => {
  const dir = freshDir();
  const { adapter } = await startedAdapter(dir);
  adapter.submit("the filed words");
  const filed = adapter.syncMessages()[0];
  const divergent: SyncedChatMessage = { ...filed, text: "tampered words" };
  const result = adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: [filed.id],
    messages: [divergent],
  });
  assert.equal(result.conflicts, 1);
  assert.ok(existsSync(join(dir, "chat-sync-conflicts.jsonl")));
  const archive = readFileSync(join(dir, "chat-sync-conflicts.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { kept: SyncedChatMessage; dropped: SyncedChatMessage });
  assert.equal(archive.length, 1);
  assert.deepEqual(
    new Set([archive[0].kept.text, archive[0].dropped.text]),
    new Set(["the filed words", "tampered words"]),
  );
  // The canonical view holds exactly the merge core's winner.
  const expected = mergeChatMessages([filed], [divergent]).messages[0];
  assert.equal(adapter.syncMessages()[0].text, expected.text);
});

// ------------------------------------------------------------ convergence

test("convergence: offline branches on both sides merge to one canonical set", async () => {
  const dir = freshDir();
  const { adapter } = await startedAdapter(dir);

  // A shared root both sides hold (an old core-born message).
  adapter.submit("shared root");
  const root = adapter.syncMessages()[0];

  // The phone goes offline and chats on-device: two records
  // chained from the root, in a plain array folded by the
  // shared merge core (the Swift store's stand-in).
  let phone: SyncedChatMessage[] = [root];
  const phoneAsk: SyncedChatMessage = {
    id: randomUUID(),
    deviceId: "phone-device",
    seq: 1,
    prevId: root.id,
    ts: 6000,
    direction: "in",
    text: "offline question",
  };
  const phoneAnswer: SyncedChatMessage = {
    id: randomUUID(),
    deviceId: "phone-device",
    seq: 2,
    prevId: phoneAsk.id,
    ts: 6001,
    direction: "out",
    text: "offline answer",
  };
  phone = mergeChatMessages(phone, [phoneAsk, phoneAnswer]).messages;

  // Meanwhile the desk chats too: a core-born record from the
  // same root.
  adapter.submit("desk question");
  const core = adapter.syncMessages();
  const deskMsg = core.find((m) => m.text === "desk question")!;
  assert.equal(deskMsg.prevId, root.id);

  // The exchange, as the client runs it: (1) name your IDs,
  // fold what you're missing, learn what the core wants;
  // (2) push the wanted records.
  const step1 = adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: phone.map((m) => m.id),
  });
  phone = mergeChatMessages(phone, step1.missing).messages;
  const wanted = phone.filter((m) => step1.wantIds.includes(m.id));
  assert.deepEqual(new Set(wanted.map((m) => m.id)), new Set([phoneAsk.id, phoneAnswer.id]));
  const step2 = adapter.syncExchange({
    deviceId: "phone-device",
    haveIds: phone.map((m) => m.id),
    messages: wanted,
  });
  assert.deepEqual(step2.missing, []);
  assert.deepEqual(step2.wantIds, []);

  // Both sides hold the same canonical history: same IDs,
  // same order, nothing lost from either offline branch.
  const coreFinal = adapter.syncMessages();
  assert.deepEqual(
    phone.map((m) => m.id),
    coreFinal.map((m) => m.id),
  );
  assert.deepEqual(
    new Set(coreFinal.map((m) => m.text)),
    new Set(["shared root", "offline question", "offline answer", "desk question"]),
  );
});
