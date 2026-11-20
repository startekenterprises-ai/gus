/**
 * Artifact post-conditions (v0.5.1) — the deliverables fix.
 *
 * The field failure this answers (2026-11-06): a bridge job asked
 * for an edited repo, a test run, and a deliverable file — and
 * settled verified-done in 16 seconds off a single text reply,
 * because the only post-condition was the delivered text's hash.
 * What is pinned here:
 *  - A bridge request file may declare `deliverables` (absolute
 *    paths); they ride the emitted message untouched.
 *  - An unusable declaration (not an array, or no valid absolute
 *    path in it) parks the file as .bad — a declared post-condition
 *    is never silently dropped.
 *  - The paths land on the job record.
 *  - At completion: deliverable present + the usual verification →
 *    verified-done; deliverable MISSING → failed-loudly with the
 *    path named in the outcome note, however good the text was.
 *  - A job with no deliverables verifies exactly as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChannelAdapter,
  ChannelEvent,
  OutboundMessage,
} from "../../packages/shared/src/index.js";
import {
  BridgeInboxAdapter,
  parseDeliverables,
} from "../../packages/control-plane/src/bridge-inbox.js";
import { ChannelHost } from "../../packages/control-plane/src/channel-host.js";
import { Governor } from "../../packages/control-plane/src/governor.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";

const GROUP = "-100999";
const OPERATOR = "111";
const NOVA = "222";

// ------------------------------------------------------------ parsing

test("parseDeliverables: absent and empty declare nothing; valid paths pass through deduped", () => {
  assert.deepEqual(parseDeliverables(undefined), { ok: true });
  assert.deepEqual(parseDeliverables([]), { ok: true });
  assert.deepEqual(parseDeliverables(["/a/b.md", "/a/b.md", "/c.md"]), {
    ok: true,
    deliverables: ["/a/b.md", "/c.md"],
  });
});

test("parseDeliverables: unusable declarations are refused, never dropped", () => {
  assert.deepEqual(parseDeliverables("/a/b.md"), { ok: false }, "a bare string is not an array");
  assert.deepEqual(parseDeliverables(42), { ok: false });
  assert.deepEqual(parseDeliverables(["relative/path.md"]), { ok: false }, "relative paths check nothing");
  assert.deepEqual(parseDeliverables([null, 7]), { ok: false });
  // Mixed: the valid entry survives, the junk is ignored.
  assert.deepEqual(parseDeliverables(["relative.md", "/abs/ok.md"]), {
    ok: true,
    deliverables: ["/abs/ok.md"],
  });
});

// ------------------------------------------------------- bridge level

interface BridgeRig {
  dir: string;
  events: ChannelEvent[];
  adapter: BridgeInboxAdapter;
  onEvent: (ev: ChannelEvent) => void;
}

function bridgeRig(): BridgeRig {
  const dir = mkdtempSync(join(tmpdir(), "gus-deliv-bridge-"));
  writeFileSync(
    join(dir, "delegates.json"),
    JSON.stringify({
      conversations: {
        [GROUP]: { operatorId: OPERATOR, delegates: [{ senderId: NOVA, name: "Nova" }] },
      },
      bridge: { conversationId: GROUP, senderId: NOVA },
    }),
  );
  mkdirSync(join(dir, "bridge-inbox", "processed"), { recursive: true });
  const events: ChannelEvent[] = [];
  const adapter = new BridgeInboxAdapter(dir, { sendVia: async () => {} });
  return { dir, events, adapter, onEvent: (ev) => events.push(ev) };
}

function drop(r: BridgeRig, name: string, body: unknown): void {
  writeFileSync(join(r.dir, "bridge-inbox", name), JSON.stringify(body));
}

test("bridge: declared deliverables ride the emitted message", () => {
  const r = bridgeRig();
  drop(r, "1700000000000-a.json", {
    id: "req-d1",
    text: "write the summary",
    deliverables: ["/Users/x/Documents/summary.md"],
  });
  r.adapter.pollOnce(r.onEvent);
  assert.equal(r.events.length, 1);
  const ev = r.events[0];
  assert.equal(ev.type, "message");
  if (ev.type === "message") {
    assert.deepEqual(ev.message.deliverables, ["/Users/x/Documents/summary.md"]);
  }
});

test("bridge: an unusable deliverables declaration parks the file as .bad", () => {
  const r = bridgeRig();
  drop(r, "1700000000000-a.json", { id: "req-d2", text: "write it", deliverables: "summary.md" });
  drop(r, "1700000000001-b.json", { id: "req-d3", text: "write it", deliverables: ["rel.md"] });
  r.adapter.pollOnce(r.onEvent);
  assert.equal(r.events.length, 0, "neither request may emit without its post-condition");
  assert.equal(existsSync(join(r.dir, "bridge-inbox", "processed", "1700000000000-a.json.bad")), true);
  assert.equal(existsSync(join(r.dir, "bridge-inbox", "processed", "1700000000001-b.json.bad")), true);
});

test("bridge: a request without deliverables emits exactly as before", () => {
  const r = bridgeRig();
  drop(r, "1700000000000-a.json", { id: "req-d4", text: "open the calculator" });
  r.adapter.pollOnce(r.onEvent);
  assert.equal(r.events.length, 1);
  const ev = r.events[0];
  if (ev.type === "message") assert.equal(ev.message.deliverables, undefined);
});

// --------------------------------------------------------- host level

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
}

interface HostRig {
  host: ChannelHost;
  jobs: JobRunner;
  adapter: RecordingAdapter;
  pushed: { jobId: string; text: string }[];
  dir: string;
}

async function hostRig(): Promise<HostRig> {
  const dir = mkdtempSync(join(tmpdir(), "gus-deliv-host-"));
  writeFileSync(
    join(dir, "delegates.json"),
    JSON.stringify({
      conversations: {
        [GROUP]: { operatorId: OPERATOR, delegates: [{ senderId: NOVA, name: "Nova" }] },
      },
    }),
  );
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
  return { host, jobs, adapter, pushed, dir };
}

const tick = () => new Promise((r) => setTimeout(r, 25));

async function delegateJob(
  r: HostRig,
  text: string,
  deliverables?: string[],
): Promise<string> {
  r.adapter.handler?.({
    type: "message",
    message: {
      conversationId: GROUP,
      messageId: `m-${Math.random()}`,
      senderId: NOVA,
      text,
      receivedAt: Date.now(),
      ...(deliverables ? { deliverables } : {}),
    },
  });
  await tick();
  assert.equal(r.pushed.length, 1, "the delegate message should have created one job");
  return r.pushed[0].jobId;
}

const REPLY = "All done — summary written and tests green.";

test("completion: deliverable on disk + verified output settles verified-done", async () => {
  const r = await hostRig();
  const deliverable = join(r.dir, "summary.md");
  const jobId = await delegateJob(r, "write the summary file", [deliverable]);
  assert.deepEqual(r.jobs.get(jobId)?.deliverables, [deliverable], "the record carries the post-condition");
  writeFileSync(deliverable, "# summary\n");
  r.host.onModelIssued(jobId, REPLY);
  await r.host.onJobFinal(jobId, REPLY);
  const job = r.jobs.get(jobId);
  assert.equal(job?.state, "verified-done");
  assert.match(job?.outcomeNote ?? "", /deliverables verified/);
});

test("completion: text-only reply with the deliverable missing settles failed-loudly, path named", async () => {
  const r = await hostRig();
  const deliverable = join(r.dir, "never-written.md");
  const jobId = await delegateJob(r, "write the summary file", [deliverable]);
  // The model produces a perfectly convincing reply — and no file.
  r.host.onModelIssued(jobId, REPLY);
  await r.host.onJobFinal(jobId, REPLY);
  const job = r.jobs.get(jobId);
  assert.equal(job?.state, "failed-loudly", "a text-only completion must not settle a file job as done");
  assert.equal(
    job?.outcomeNote,
    `post-condition failed: deliverable ${deliverable} was not created`,
  );
});

test("completion: several missing deliverables are all named", async () => {
  const r = await hostRig();
  const a = join(r.dir, "a.md");
  const b = join(r.dir, "b.md");
  const jobId = await delegateJob(r, "write both files", [a, b]);
  writeFileSync(a, "a\n"); // one of two — still a failure
  r.host.onModelIssued(jobId, REPLY);
  await r.host.onJobFinal(jobId, REPLY);
  const job = r.jobs.get(jobId);
  assert.equal(job?.state, "failed-loudly");
  assert.match(job?.outcomeNote ?? "", /post-condition failed/);
  assert.ok((job?.outcomeNote ?? "").includes(b), "the missing path is named");
  assert.ok(!(job?.outcomeNote ?? "").includes("a.md was not created"), "the present file is not blamed");
});

test("completion: a job with no deliverables verifies exactly as before", async () => {
  const r = await hostRig();
  const jobId = await delegateJob(r, "just answer in chat");
  assert.equal(r.jobs.get(jobId)?.deliverables, undefined);
  r.host.onModelIssued(jobId, REPLY);
  await r.host.onJobFinal(jobId, REPLY);
  const job = r.jobs.get(jobId);
  assert.equal(job?.state, "verified-done");
  assert.equal(
    job?.outcomeNote,
    "post-condition ok: delivered output matches Governor-issued model output",
  );
});
