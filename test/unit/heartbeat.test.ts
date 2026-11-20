/**
 * Phase 5: the install heartbeat (spec §5 instrumentation).
 * The privacy properties ARE the tests: off by default, and when the
 * operator opts in, the payload is exactly { version, mode } — no id,
 * no counts, no content — and a dead counter can never break the
 * control plane.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GUS_VERSION } from "../../packages/shared/src/index.js";
import {
  heartbeatConfigFromEnv,
  sendHeartbeat,
} from "../../packages/control-plane/src/heartbeat.js";

test("heartbeat: off by default — no env, no ping, fetch never called", async () => {
  let calls = 0;
  const cfg = heartbeatConfigFromEnv({});
  assert.equal(cfg.enabled, false);
  const sent = await sendHeartbeat(cfg, (async () => {
    calls++;
    return { ok: true };
  }) as unknown as typeof fetch);
  assert.equal(sent, false);
  assert.equal(calls, 0);
});

test("heartbeat: opt-in flag without a URL is still off", () => {
  assert.equal(heartbeatConfigFromEnv({ GUS_HEARTBEAT: "1" }).enabled, false);
  assert.equal(
    heartbeatConfigFromEnv({ GUS_HEARTBEAT: "1", GUS_HEARTBEAT_URL: "https://counter.example/hb" }).enabled,
    true,
  );
  assert.equal(
    heartbeatConfigFromEnv({ GUS_HEARTBEAT: "0", GUS_HEARTBEAT_URL: "https://counter.example/hb" }).enabled,
    false,
  );
});

test("heartbeat: the payload is exactly { version, mode } — nothing else exists to send", async () => {
  let seenBody = "";
  let seenUrl = "";
  const cfg = heartbeatConfigFromEnv({
    GUS_HEARTBEAT: "1",
    GUS_HEARTBEAT_URL: "https://counter.example/hb",
  });
  const sent = await sendHeartbeat(cfg, (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenBody = String(init.body);
    return { ok: true };
  }) as unknown as typeof fetch);
  assert.equal(sent, true);
  assert.equal(seenUrl, "https://counter.example/hb");
  assert.deepEqual(JSON.parse(seenBody), { version: GUS_VERSION, mode: "self-host" });
  assert.deepEqual(Object.keys(JSON.parse(seenBody)).sort(), ["mode", "version"]);
});

test("heartbeat: a dead counter is swallowed — false, never a throw", async () => {
  const cfg = heartbeatConfigFromEnv({
    GUS_HEARTBEAT: "1",
    GUS_HEARTBEAT_URL: "https://counter.example/hb",
  });
  const sent = await sendHeartbeat(cfg, (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch);
  assert.equal(sent, false);
});
