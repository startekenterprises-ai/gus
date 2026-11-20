/**
 * Governor modes (v0.4) — SELinux-style enforcing / permissive.
 *
 * What is pinned here:
 *  - The mode file: missing or malformed means ENFORCING; a written
 *    mode reads back; the file is the only state.
 *  - The Shield gate in permissive mode: a malicious verdict still
 *    scans and receipts, but the decision is allow + permissive +
 *    wouldBe "block", and the gate log carries mode + wouldBe so
 *    the permissive report can surface it. Enforcing still blocks.
 *  - The permissive report merges the gate log (shield kind) and
 *    permissive.jsonl (policy kind), time-ordered, window-filtered.
 *  - /mode on the channel: the operator reads and flips it (live,
 *    written to the same file); a delegate is refused operator-only;
 *    the flip changes what loadGovernorMode returns for the very
 *    next decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChannelAdapter,
  ChannelEvent,
  OutboundMessage,
} from "../../packages/shared/src/index.js";
import { ShieldGate, ShieldClient, type ShieldTransport } from "../../packages/gate/src/index.js";
import { VaultBroker } from "../../packages/vault/src/index.js";
import { ChannelHost } from "../../packages/control-plane/src/channel-host.js";
import { Governor } from "../../packages/control-plane/src/governor.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";
import {
  appendPermissiveAction,
  loadGovernorMode,
  readPermissiveActions,
  writeGovernorMode,
} from "../../packages/control-plane/src/governor-mode.js";

const FAKE_KEY = "as_test_governor_mode_key";
const RECEIPT = {
  receipt_id: "rcpt_0123456789abcdef01",
  verdict: "malicious",
  verify_url: "https://shield.example/v/rcpt_0123456789abcdef01",
};

function fakeTransport(): ShieldTransport {
  return async (url, init) => {
    if (url.endsWith("/v1/signup")) {
      return { status: 200, json: async () => ({ api_key: FAKE_KEY, tier: "free" }) };
    }
    if (url.endsWith("/v2/scan")) {
      const body = JSON.parse(init.body ?? "{}") as { content: string };
      if (body.content.includes("MARK_MALICIOUS")) {
        return { status: 200, json: async () => ({ verdict: "malicious", action: "block", findings: [], receipt: RECEIPT }) };
      }
      return {
        status: 200,
        json: async () => ({
          verdict: "no_signals",
          action: "allow",
          findings: [],
          receipt: { ...RECEIPT, receipt_id: "rcpt_0123456789abcdef03", verdict: "no_signals" },
        }),
      };
    }
    return { status: 404, json: async () => ({}) };
  };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("mode file: missing or malformed is enforcing; written mode reads back", () => {
  const dir = tempDir("gus-mode-");
  assert.equal(loadGovernorMode(dir), "enforcing");
  writeFileSync(join(dir, "governor-mode.json"), "{not json");
  assert.equal(loadGovernorMode(dir), "enforcing");
  writeGovernorMode(dir, "permissive", "test");
  assert.equal(loadGovernorMode(dir), "permissive");
  writeGovernorMode(dir, "enforcing", "test");
  assert.equal(loadGovernorMode(dir), "enforcing");
});

test("gate: permissive turns a malicious block into a stamped allow; enforcing still blocks", async () => {
  const dir = tempDir("gus-mode-gate-");
  const vault = new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key"));
  const client = new ShieldClient({ vault, baseUrl: "https://shield.example", transport: fakeTransport() });
  let mode: "enforcing" | "permissive" = "enforcing";
  const gate = new ShieldGate({
    client,
    policy: () => ({ required: true, onUnavailable: "closed" as const }),
    logPath: join(dir, "gate.jsonl"),
    mode: () => mode,
  });
  await gate.provision();

  const blocked = await gate.scanSurface("inbound-message", "job-1", "MARK_MALICIOUS payload");
  assert.equal(blocked.action, "block");
  assert.equal(blocked.permissive, undefined);

  mode = "permissive";
  const relaxed = await gate.scanSurface("inbound-message", "job-2", "MARK_MALICIOUS payload");
  assert.equal(relaxed.action, "allow", "permissive lets it proceed");
  assert.equal(relaxed.permissive, true);
  assert.equal(relaxed.wouldBe, "block");
  assert.equal(relaxed.verdict, "malicious", "the verdict is still the truth");
  assert.ok(relaxed.receipt, "and it is still receipted");
  assert.ok(relaxed.detail.includes("PERMISSIVE"));

  const clean = await gate.scanSurface("tool-call", "job-3", "ordinary args");
  assert.equal(clean.action, "allow");
  assert.equal(clean.permissive, undefined, "clean scans are not stamped");

  const lines = readFileSync(join(dir, "gate.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const relaxedEntry = lines.find((e) => e.jobId === "job-2");
  assert.equal(relaxedEntry.mode, "permissive");
  assert.equal(relaxedEntry.wouldBe, "block");
  assert.equal(relaxedEntry.action, "allow");

  const report = readPermissiveActions(dir, 0);
  assert.equal(report.length, 1);
  assert.equal(report[0].kind, "shield");
  assert.equal(report[0].jobId, "job-2");
});

test("permissive report merges policy + shield entries in time order, windowed", () => {
  const dir = tempDir("gus-mode-report-");
  appendPermissiveAction(dir, { ts: 300, jobId: "j3", kind: "policy", detail: "park proceeded" });
  appendPermissiveAction(dir, { ts: 100, jobId: "j1", kind: "policy", detail: "deny proceeded" });
  writeFileSync(
    join(dir, "gate.jsonl"),
    JSON.stringify({ ts: 200, jobId: "j2", surface: "tool-call", action: "allow", wouldBe: "block", mode: "permissive", detail: "shield would-be" }) + "\n" +
      JSON.stringify({ ts: 400, jobId: "j4", surface: "tool-call", action: "block", detail: "an enforcing block — not a let-through" }) + "\n",
  );
  const all = readPermissiveActions(dir, 0);
  assert.deepEqual(all.map((a) => a.jobId), ["j1", "j2", "j3"]);
  assert.deepEqual(all.map((a) => a.kind), ["policy", "shield", "policy"]);
  assert.deepEqual(readPermissiveActions(dir, 250).map((a) => a.jobId), ["j3"]);
});

// ---------------------------------------------------------------- /mode

const GROUP = "-100999";
const OPERATOR = "111";
const NOVA = "222";

class RecordingAdapter implements ChannelAdapter {
  readonly name = "telegram";
  handler?: (ev: ChannelEvent) => void;
  sent: OutboundMessage[] = [];
  async start(onEvent: (ev: ChannelEvent) => void): Promise<void> {
    this.handler = onEvent;
  }
  async stop(): Promise<void> {}
  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }
  async ackButton(): Promise<void> {}
}

const tick = () => new Promise((r) => setTimeout(r, 25));

test("/mode: operator flips it, delegate is refused, status reports the count", async () => {
  const dir = tempDir("gus-mode-cmd-");
  writeFileSync(
    join(dir, "delegates.json"),
    JSON.stringify({
      conversations: { [GROUP]: { operatorId: OPERATOR, delegates: [{ senderId: NOVA, name: "Nova" }] } },
    }),
  );
  const governor = new Governor(dir, { maxTokensPerJob: 100, maxTokensPerDay: 10_000 });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const adapter = new RecordingAdapter();
  const host = new ChannelHost(dir, governor, jobs, [adapter]);
  host.attachComm({ pushUserMessage: () => {}, broadcast: () => {} } as never);
  await host.start();
  const say = (senderId: string, text: string) =>
    adapter.handler?.({
      type: "message",
      message: { conversationId: GROUP, messageId: "m", senderId, text, receivedAt: Date.now() },
    });

  say(NOVA, "/mode permissive");
  await tick();
  assert.equal(loadGovernorMode(dir), "enforcing", "a delegate flip changes nothing");
  assert.ok(adapter.sent.some((m) => m.text.includes("operator-only")), "delegate gets the refusal");

  say(OPERATOR, "/mode permissive");
  await tick();
  assert.equal(loadGovernorMode(dir), "permissive");
  assert.ok(adapter.sent.some((m) => m.text.includes("PERMISSIVE")), "operator gets the loud confirmation");

  say(OPERATOR, "/mode");
  await tick();
  const status = adapter.sent[adapter.sent.length - 1];
  assert.ok(status.text.includes("PERMISSIVE"), "status names the mode");
  assert.ok(status.text.includes("let-throughs today: 0"));

  say(OPERATOR, "/mode enforcing");
  await tick();
  assert.equal(loadGovernorMode(dir), "enforcing");
  assert.ok(existsSync(join(dir, "governor-mode.json")));
});
