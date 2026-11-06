/**
 * Delegate principals (Phase 9) — the Nova bridge's identity rules.
 *
 * The bridge puts GUS in a group conversation with a second agent.
 * What is pinned here:
 *  - roleFor: operator / delegate / stranger in a gated conversation;
 *    legacy (ungated) everywhere else; a malformed entry never gates.
 *  - A delegate's message becomes a job whose runtime text carries
 *    its origin ("[from Nova] …").
 *  - A delegate's privileged commands (/stop, /approve) are refused;
 *    the kill switch does not move.
 *  - A delegate's approval BUTTON press resolves nothing: the ack
 *    says operator-only and the refusal is logged with the sender.
 *  - The operator's press passes the gate (ack "Approved.").
 *  - A stranger's message creates no job, gets no reply, and is
 *    logged.
 *  - Legacy conversations behave exactly as before the bridge.
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
import { ChannelHost } from "../../packages/control-plane/src/channel-host.js";
import { Governor } from "../../packages/control-plane/src/governor.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";
import { roleFor, type DelegatesConfig } from "../../packages/control-plane/src/delegates.js";

const GROUP = "-100999";
const OPERATOR = "111";
const NOVA = "222";
const STRANGER = "333";

class RecordingAdapter implements ChannelAdapter {
  readonly name = "telegram";
  handler?: (ev: ChannelEvent) => void;
  sent: OutboundMessage[] = [];
  acks: string[] = [];
  async start(onEvent: (ev: ChannelEvent) => void): Promise<void> {
    this.handler = onEvent;
  }
  async stop(): Promise<void> {}
  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }
  async ackButton(_callbackId: string, note?: string): Promise<void> {
    this.acks.push(note ?? "");
  }
}

interface Rig {
  host: ChannelHost;
  jobs: JobRunner;
  governor: Governor;
  adapter: RecordingAdapter;
  pushed: { jobId: string; text: string }[];
  dir: string;
}

async function rig(gated: boolean): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "gus-delegates-"));
  if (gated) {
    writeFileSync(
      join(dir, "delegates.json"),
      JSON.stringify({
        conversations: {
          [GROUP]: { operatorId: OPERATOR, delegates: [{ senderId: NOVA, name: "Nova" }] },
        },
      }),
    );
  }
  const governor = new Governor(dir, { maxTokensPerJob: 100, maxTokensPerDay: 10_000 });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const adapter = new RecordingAdapter();
  const host = new ChannelHost(dir, governor, jobs, [adapter]);
  const pushed: { jobId: string; text: string }[] = [];
  host.attachComm({
    pushUserMessage: (m: { jobId: string; text: string }) => pushed.push(m),
    broadcast: () => {},
  } as never);
  await host.start();
  return { host, jobs, governor, adapter, pushed, dir };
}

const tick = () => new Promise((r) => setTimeout(r, 25));

function say(r: Rig, conversationId: string, senderId: string, text: string): void {
  r.adapter.handler?.({
    type: "message",
    message: { conversationId, messageId: "m1", senderId, text, receivedAt: Date.now() },
  });
}

function press(r: Rig, conversationId: string, senderId: string, buttonId: string): void {
  r.adapter.handler?.({
    type: "button",
    press: { conversationId, senderId, buttonId, callbackId: "cb1" },
  });
}

function eventsLog(r: Rig): string {
  const p = join(r.dir, "events.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

// ------------------------------------------------------------------ roles

test("roles: gated conversation resolves operator, delegate, stranger", () => {
  const cfg: DelegatesConfig = {
    conversations: { [GROUP]: { operatorId: OPERATOR, delegates: [{ senderId: NOVA, name: "Nova" }] } },
  };
  assert.equal(roleFor(cfg, GROUP, OPERATOR).role, "operator");
  const d = roleFor(cfg, GROUP, NOVA);
  assert.equal(d.role, "delegate");
  assert.equal(d.role === "delegate" ? d.name : "", "Nova");
  assert.equal(roleFor(cfg, GROUP, STRANGER).role, "stranger");
  assert.equal(roleFor(cfg, "some-other-chat", OPERATOR).role, "legacy");
  const malformed: DelegatesConfig = { conversations: { [GROUP]: { operatorId: "", delegates: [] } } };
  assert.equal(roleFor(malformed, GROUP, OPERATOR).role, "legacy", "empty operatorId never gates");
});

// ------------------------------------------------------------------- jobs

test("delegate message becomes a job carrying its origin", async () => {
  const r = await rig(true);
  say(r, GROUP, NOVA, "open the calculator please");
  await tick();
  assert.equal(r.pushed.length, 1);
  assert.ok(r.pushed[0].text.startsWith("[from Nova] "), `origin prefix present: ${r.pushed[0].text}`);
  assert.ok(r.jobs.activeFor(GROUP), "a job is running for the group conversation");
});

test("operator message in the group carries no prefix", async () => {
  const r = await rig(true);
  say(r, GROUP, OPERATOR, "open the calculator please");
  await tick();
  assert.equal(r.pushed.length, 1);
  assert.equal(r.pushed[0].text, "open the calculator please");
});

// --------------------------------------------------------------- commands

test("delegate /stop is refused and the kill switch does not move", async () => {
  const r = await rig(true);
  say(r, GROUP, NOVA, "/stop");
  await tick();
  assert.equal(r.governor.isKilled(), false);
  assert.ok(
    r.adapter.sent.some((m) => m.text.includes("operator-only")),
    "the refusal is explained in the conversation",
  );
});

test("delegate /approve command is refused before it can resolve anything", async () => {
  const r = await rig(true);
  say(r, GROUP, NOVA, "/approve apx_whatever");
  await tick();
  assert.ok(r.adapter.sent.some((m) => m.text.includes("operator-only")));
  assert.equal(r.pushed.length, 0, "the command never became a job either");
});

test("operator /stop in the group still works", async () => {
  const r = await rig(true);
  say(r, GROUP, OPERATOR, "/stop");
  await tick();
  assert.equal(r.governor.isKilled(), true);
});

// ---------------------------------------------------------------- buttons

test("delegate approval press resolves nothing and is logged with its sender", async () => {
  const r = await rig(true);
  press(r, GROUP, NOVA, "approve:apx_123");
  await tick();
  assert.ok(r.adapter.acks.some((a) => a.includes("Only the operator")), `acks: ${r.adapter.acks}`);
  const log = eventsLog(r);
  assert.ok(log.includes('"kind":"approval_resolve_rejected"'), "rejection logged");
  assert.ok(log.includes('"reason":"not-operator"'), "reason logged");
  assert.ok(log.includes(`"senderId":"${NOVA}"`), "sender logged");
});

test("operator approval press passes the sender gate", async () => {
  const r = await rig(true);
  press(r, GROUP, OPERATOR, "approve:apx_123");
  await tick();
  assert.ok(r.adapter.acks.some((a) => a === "Approved."), `acks: ${r.adapter.acks}`);
});

// --------------------------------------------------------------- stranger

test("stranger message is ignored: no job, no reply, logged", async () => {
  const r = await rig(true);
  say(r, GROUP, STRANGER, "open the calculator please");
  await tick();
  assert.equal(r.pushed.length, 0);
  assert.equal(r.adapter.sent.length, 0);
  assert.equal(r.jobs.activeFor(GROUP), undefined);
  assert.ok(eventsLog(r).includes('"kind":"message_ignored_stranger"'));
});

// ----------------------------------------------------------------- legacy

test("legacy conversation: no delegates file, everything behaves as before", async () => {
  const r = await rig(false);
  say(r, "555", "999", "open the calculator please");
  await tick();
  assert.equal(r.pushed.length, 1);
  assert.equal(r.pushed[0].text, "open the calculator please", "no origin prefix in legacy chats");
  say(r, "555", "999", "/stop");
  await tick();
  assert.equal(r.governor.isKilled(), true, "the paired sender keeps full control");
});
