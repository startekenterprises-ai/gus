import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChannelEvent } from "../../packages/shared/src/index.js";
import {
  FakeFileTransport,
  TelegramAdapter,
  fakeMessageUpdate,
} from "../../packages/channels/telegram/src/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("adapter poll loop never starves the event loop (regression: sync-resolving transport)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-adapter-"));
  const inbound = join(dir, "inbound.ndjson");
  const outbound = join(dir, "outbound.ndjson");
  writeFileSync(inbound, "");
  writeFileSync(outbound, "");

  const adapter = new TelegramAdapter(new FakeFileTransport(inbound, outbound));
  const events: ChannelEvent[] = [];
  await adapter.start((ev) => events.push(ev));

  // While the adapter polls an empty file, timers must still fire —
  // before the yield fix, the loop spun the microtask queue forever and
  // froze the whole control plane (including its comm socket).
  let timerFired = false;
  setTimeout(() => {
    timerFired = true;
  }, 120);
  await sleep(300);
  assert.equal(timerFired, true, "event loop starved by the poll loop");

  appendFileSync(inbound, JSON.stringify(fakeMessageUpdate(1, 4242, 777, "hello")) + "\n");
  await sleep(300);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "message");
  await adapter.stop();
});
