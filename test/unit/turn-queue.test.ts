/**
 * TurnQueue (v0.3.4) — the runtime's turn serializer.
 *
 * Pins the invariant the 2026-11-05 field failure violated: turns
 * run one at a time, in arrival order, and one bad turn never jams
 * the queue behind it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnQueue } from "../../packages/runtime/src/turn-queue.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("turns run one at a time, in arrival order", async () => {
  const q = new TurnQueue();
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const task = (name: string, ms: number) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, ms));
    order.push(name);
    active -= 1;
  };
  q.enqueue(task("first", 25));
  q.enqueue(task("second", 1));
  q.enqueue(task("third", 1));
  await q.idle();
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.equal(maxActive, 1, "never two turns in flight");
});

test("a throwing turn does not jam the queue", async () => {
  const q = new TurnQueue();
  const order: string[] = [];
  q.enqueue(async () => {
    order.push("boom");
    throw new Error("turn failed");
  });
  q.enqueue(async () => {
    order.push("after");
  });
  await q.idle();
  await tick();
  assert.deepEqual(order, ["boom", "after"]);
});

test("turns enqueued while one runs still wait their turn", async () => {
  const q = new TurnQueue();
  const order: string[] = [];
  q.enqueue(async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 20));
    q.enqueue(async () => {
      order.push("c");
    });
    order.push("a-end");
  });
  q.enqueue(async () => {
    order.push("b");
  });
  await q.idle();
  await q.idle(); // idle() snapshots the chain; c extended it during a
  // c was enqueued during a, but behind b, which was already queued.
  assert.deepEqual(order, ["a-start", "a-end", "b", "c"]);
});
