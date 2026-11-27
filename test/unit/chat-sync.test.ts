/**
 * v0.26.0: chat-history sync — the merge core (@gus/shared's
 * chat-sync). The design (2026-11-20): append-only immutable
 * messages with UUID + per-device sequence at birth, union
 * merge (never overwrite), ordering by causal pointer
 * (prevId), never by wall clock.
 *
 * These tests pin the rules both stores (the core's
 * panel-chat store and the phone's ChatHistoryStore, a Swift
 * mirror of the same functions) converge by: validation,
 * canonical causal order, deterministic interleaving of
 * concurrent offline branches, union dedup, and conflict
 * resolution that never silently drops a copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatIdsLacking,
  chatMessagesMissingFrom,
  mergeChatMessages,
  orderChatMessages,
  validateSyncedChatMessage,
  type SyncedChatMessage,
} from "../../packages/shared/src/index.js";

let n = 0;
function msg(partial: Partial<SyncedChatMessage> = {}): SyncedChatMessage {
  n += 1;
  return {
    id: `id-${n}`,
    deviceId: "dev-a",
    seq: n,
    prevId: null,
    ts: 1_000_000 + n,
    direction: "in",
    text: `message ${n}`,
    ...partial,
  };
}

/** A linear chain: each message's prevId is the one before. */
function chain(deviceId: string, count: number, startSeq = 1): SyncedChatMessage[] {
  const out: SyncedChatMessage[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i++) {
    const m = msg({ deviceId, seq: startSeq + i, prevId: prev });
    out.push(m);
    prev = m.id;
  }
  return out;
}

function shuffled<T>(arr: readonly T[], seed: number): T[] {
  const out = [...arr];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ------------------------------------------------------------ validation

test("validate: a well-formed record passes, photos carried only when positive", () => {
  const good = msg({ photos: 2 });
  assert.deepEqual(validateSyncedChatMessage(good), good);
  const noPhotos = msg();
  const validated = validateSyncedChatMessage({ ...noPhotos, photos: 0 });
  assert.equal(validated?.photos, undefined);
});

test("validate: malformed records are refused", () => {
  const good = msg();
  for (const bad of [
    null,
    "nope",
    { ...good, id: "" },
    { ...good, deviceId: 7 },
    { ...good, seq: -1 },
    { ...good, seq: 1.5 },
    { ...good, prevId: 42 },
    { ...good, ts: Number.NaN },
    { ...good, direction: "sideways" },
    { ...good, text: "x".repeat(8001) },
    { ...good, photos: -1 },
    { ...good, photos: 2.5 },
  ]) {
    assert.equal(validateSyncedChatMessage(bad), undefined, JSON.stringify(bad)?.slice(0, 60));
  }
});

// ------------------------------------------------------------ ordering

test("order: a shuffled chain sorts by prev links, ignoring timestamps", () => {
  const c = chain("dev-a", 6);
  // Reverse the timestamps: wall clock now disagrees with
  // causality on every hop — the order must not care.
  const stamped = c.map((m, i) => ({ ...m, ts: 9_000_000 - i * 1000 }));
  const ordered = orderChatMessages(shuffled(stamped, 7));
  assert.deepEqual(
    ordered.map((m) => m.id),
    c.map((m) => m.id),
  );
});

test("order: concurrent branches interleave deterministically, input order irrelevant", () => {
  const root = msg({ deviceId: "dev-a", seq: 1 });
  const a = chain("dev-a", 3, 2).map((m, i) => (i === 0 ? { ...m, prevId: root.id } : m));
  const b = chain("dev-b", 3, 1).map((m, i) => (i === 0 ? { ...m, prevId: root.id } : m));
  const all = [root, ...a, ...b];
  const first = orderChatMessages(shuffled(all, 3)).map((m) => m.id);
  const second = orderChatMessages(shuffled(all, 99)).map((m) => m.id);
  assert.deepEqual(first, second);
  // Causality holds: every message follows its predecessor.
  const position = new Map(first.map((id, i) => [id, i]));
  for (const m of all) {
    if (m.prevId) assert.ok(position.get(m.prevId)! < position.get(m.id)!);
  }
  // Sibling order is (deviceId, seq): dev-a's branch leads.
  assert.equal(first[0], root.id);
  assert.equal(first[1], a[0].id);
});

test("order: a prevId outside the set is a root; a cycle terminates with everything kept", () => {
  const orphan = msg({ prevId: "not-in-the-set" });
  const x = msg({ id: "cycle-x" });
  const y = msg({ id: "cycle-y", prevId: "cycle-x" });
  const xCyclic = { ...x, prevId: "cycle-y" };
  const ordered = orderChatMessages([y, orphan, xCyclic]);
  assert.equal(ordered.length, 3);
  assert.deepEqual(new Set(ordered.map((m) => m.id)), new Set(["cycle-x", "cycle-y", orphan.id]));
  // Deterministic across input order even in the corrupt case.
  assert.deepEqual(
    orderChatMessages([xCyclic, y, orphan]).map((m) => m.id),
    ordered.map((m) => m.id),
  );
});

// ------------------------------------------------------------ merge

test("merge: union dedupes identical copies and keeps both sides' messages", () => {
  const shared = chain("dev-a", 3);
  const phoneOnly = chain("dev-b", 2).map((m, i) =>
    i === 0 ? { ...m, prevId: shared[2].id } : m,
  );
  const { messages, conflicts } = mergeChatMessages(shared, [...shared, ...phoneOnly]);
  assert.equal(conflicts.length, 0);
  assert.deepEqual(
    messages.map((m) => m.id),
    [...shared, ...phoneOnly].map((m) => m.id),
  );
});

test("merge: a divergent copy resolves deterministically and is reported, never dropped silently", () => {
  const original = msg({ text: "the filed copy" });
  const divergent = { ...original, text: "a different copy" };
  const forward = mergeChatMessages([original], [divergent]);
  const backward = mergeChatMessages([divergent], [original]);
  assert.equal(forward.conflicts.length, 1);
  assert.equal(backward.conflicts.length, 1);
  // Same winner from both directions — the rule is a pure
  // function of the pair, so two devices converge.
  assert.equal(forward.conflicts[0].kept.id, backward.conflicts[0].kept.id);
  assert.equal(forward.messages[0].text, backward.messages[0].text);
  // Both copies are named in the conflict — the loser travels
  // back to the caller for archiving.
  assert.deepEqual(
    new Set([forward.conflicts[0].kept.text, forward.conflicts[0].dropped.text]),
    new Set(["the filed copy", "a different copy"]),
  );
});

// ------------------------------------------------------------ have / want

test("have/want: missing and lacking are exact complements over the ID sets", () => {
  const mine = chain("dev-a", 4);
  const theirs = [...mine.slice(0, 2), msg({ deviceId: "dev-b" }), msg({ deviceId: "dev-b" })];
  const theirIds = new Set(theirs.map((m) => m.id));
  assert.deepEqual(
    chatMessagesMissingFrom(mine, theirIds).map((m) => m.id),
    mine.slice(2).map((m) => m.id),
  );
  assert.deepEqual(
    chatIdsLacking(mine, [...theirIds]),
    theirs.slice(2).map((m) => m.id),
  );
});
