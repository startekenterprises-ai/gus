/**
 * The voice fast lane + latency staging at the pipeline seams
 * (v0.9.8), end to end through the real ChannelHost and
 * CommServer:
 *
 *  - A voice adapter submit for plain chat stamps the job
 *    `voiceFastLane`, the runtime push carries the flag, and the
 *    job's prompt carries the host's brevity note — appended
 *    AFTER the Shield ingress scan, which scans the operator's
 *    words exactly as spoken (the scan is timed, never altered:
 *    shieldMs in the stats is measured around it).
 *  - A typed chat message gets none of it; a voice message the
 *    classifier makes a fetch gets none of it (the lane is for
 *    spoken chat only).
 *  - The job's outcome delivery carries its measured stage
 *    stats (shieldMs / modelMs / hops) — including a Shield
 *    block's notice, which reports the scan time and zero hops.
 *  - At the CommServer, a fast-lane job's model call is made
 *    with the spoken-reply token budget (and reserved against
 *    it); a plain job's call uses the provider's full budget.
 *    The hooks receive the measured per-call model time either
 *    way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import type {
  ChannelAdapter,
  ChannelEvent,
  ControlMessage,
  OutboundMessage,
} from "../../packages/shared/src/index.js";
import { LocalReceiptIssuer, type ShieldGate } from "../../packages/gate/src/index.js";
import { Governor } from "../../packages/control-plane/src/governor.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { PolicyStore, DEFAULT_POLICY } from "../../packages/control-plane/src/policy.js";
import { ApprovalEngine } from "../../packages/control-plane/src/approvals.js";
import {
  CommServer,
  VOICE_REPLY_TOKEN_BUDGET,
  type HostHooks,
} from "../../packages/control-plane/src/comm-server.js";
import { ChannelHost, VOICE_BREVITY_NOTE } from "../../packages/control-plane/src/channel-host.js";
import type { Provider } from "../../packages/control-plane/src/providers.js";
import { loadGovernorMode } from "../../packages/control-plane/src/governor-mode.js";
import { loadApproverPolicy } from "../../packages/control-plane/src/approver-policy.js";
import {
  VoiceAdapter,
  VoiceCallService,
} from "../../packages/channels/voice/src/index.js";

const tick = () => new Promise((r) => setTimeout(r, 10));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  assert.ok(cond(), `timed out waiting for ${what}`);
}

// ------------------------------------------------------------ host rig

class CapturingAdapter implements ChannelAdapter {
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

interface PushedMessage {
  jobId: string;
  kind: string;
  text: string;
  voiceFastLane?: boolean;
}

interface HostRig {
  dir: string;
  jobs: JobRunner;
  telegram: CapturingAdapter;
  voice: VoiceAdapter;
  host: ChannelHost;
  pushed: PushedMessage[];
  calls: VoiceCallService;
}

/** A ShieldGate-shaped fake: sleeps ~15 ms (so the host's scan
 *  timing is measurably real), then allows or blocks. The host
 *  only ever calls scanSurface — the cast is the same one the
 *  session rigs use. */
function fakeGate(action: "allow" | "block"): ShieldGate {
  return {
    scanSurface: async () => {
      await new Promise((r) => setTimeout(r, 15));
      return {
        action,
        scanned: true,
        verdict: action === "block" ? "block" : "clean",
        receipt: null,
        detail: action === "block" ? "fake gate block" : "fake gate allow",
      };
    },
  } as unknown as ShieldGate;
}

async function hostRig(gateAction: "allow" | "block" = "allow"): Promise<HostRig> {
  const dir = mkdtempSync(join(tmpdir(), "gus-fastlane-host-"));
  const governor = new Governor(dir, { maxTokensPerJob: 100_000, maxTokensPerDay: 10_000_000 });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const approvals = new ApprovalEngine(dir, () => 120_000);
  const telegram = new CapturingAdapter();
  const voice = new VoiceAdapter();
  const host = new ChannelHost(dir, governor, jobs, [telegram, voice], approvals, fakeGate(gateAction));
  const pushed: PushedMessage[] = [];
  host.attachComm({
    pushUserMessage: (m: PushedMessage) => pushed.push(m),
    broadcast: () => {},
    executeApproval: () => {},
  } as never);
  await host.start();
  const calls = new VoiceCallService(dir, voice, {
    pendingFor: (conversationId) =>
      approvals.pending().find((r) => r.conversationId === conversationId),
  }, { replyTimeoutMs: 5_000 });
  return { dir, jobs, telegram, voice, host, pushed, calls };
}

test("fast lane (host): a voice chat job is stamped, brevity-noted, and its delivery carries measured stats", async () => {
  const r = await hostRig();
  const resultPromise = r.calls.processTranscript("hello gus");
  await until(() => r.pushed.length === 1, "the voice turn to become a job");
  const pushed = r.pushed[0];
  assert.equal(pushed.kind, "chat");
  assert.equal(pushed.voiceFastLane, true, "the runtime push carries the lane flag");
  assert.equal(pushed.text, "hello gus" + VOICE_BREVITY_NOTE, "the prompt carries the brevity note");
  const job = r.jobs.get(pushed.jobId);
  assert.equal(job?.voiceFastLane, true, "the job record carries the stamp");
  assert.equal(job?.inputHash !== undefined, true);

  // Two model calls (a primary + a continuation), 1200 + 300 ms
  // as the CommServer measured them, then the final.
  r.host.onModelIssued(pushed.jobId, "working on it", 1_200);
  r.host.onModelIssued(pushed.jobId, "Hi! All good here.", 300);
  await r.host.onJobFinal(pushed.jobId, "Hi! All good here.");
  const result = await resultPromise;
  assert.equal(result.kind, "reply");
  assert.equal(result.replyText, "Hi! All good here.");
  assert.ok(result.stats, "the delivery carried the job's stage stats");
  assert.ok(result.stats!.shieldMs >= 10, `shieldMs is the measured scan (got ${result.stats!.shieldMs})`);
  assert.equal(result.stats!.modelMs, 1_500, "modelMs sums the measured calls");
  assert.equal(result.stats!.hops, 2, "hops counts the model calls");
});

test("fast lane (host): a typed chat job gets no stamp and no note — stats still ride its delivery", async () => {
  const r = await hostRig();
  r.telegram.handler?.({
    type: "message",
    message: {
      conversationId: "4242",
      messageId: "t-1",
      senderId: "operator",
      text: "hello there",
      receivedAt: Date.now(),
    },
  });
  await until(() => r.pushed.length === 1, "the typed message to become a job");
  const pushed = r.pushed[0];
  assert.equal(pushed.text, "hello there", "a typed prompt is byte-identical — no brevity note");
  assert.ok(!pushed.voiceFastLane, "no lane flag on the push");
  assert.equal(r.jobs.get(pushed.jobId)?.voiceFastLane, undefined, "no stamp on the record");

  r.host.onModelIssued(pushed.jobId, "typed reply", 42);
  await r.host.onJobFinal(pushed.jobId, "typed reply");
  const delivered = r.telegram.sent.at(-1);
  assert.equal(delivered?.text, "typed reply");
  assert.deepEqual(delivered?.jobStats, { shieldMs: delivered!.jobStats!.shieldMs, modelMs: 42, hops: 1 });
  assert.ok(delivered!.jobStats!.shieldMs >= 10, "the typed job's scan was timed too");
});

test("fast lane (host): a voice turn the classifier makes a fetch stays out of the lane", async () => {
  const r = await hostRig();
  const resultPromise = r.calls.processTranscript("fetch https://example.com and summarize it");
  await until(() => r.pushed.length === 1, "the voice fetch to become a job");
  const pushed = r.pushed[0];
  assert.equal(pushed.kind, "fetch-summarize");
  assert.ok(!pushed.voiceFastLane, "no lane flag for a fetch job");
  assert.ok(!pushed.text.includes("Voice call:"), "no brevity note on a fetch prompt");
  assert.equal(r.jobs.get(pushed.jobId)?.voiceFastLane, undefined);
  r.host.onModelIssued(pushed.jobId, "the summary", 10);
  await r.host.onJobFinal(pushed.jobId, "the summary");
  const result = await resultPromise;
  assert.equal(result.kind, "reply");
});

test("latency staging (host): a Shield block's delivery carries the scan time and zero model stages", async () => {
  const r = await hostRig("block");
  const result = await r.calls.processTranscript("a spoken injection");
  assert.equal(result.kind, "reply", "the block notice is the turn's delivery, as before");
  assert.match(result.replyText ?? "", /blocked by the Agent-Shield gate/);
  assert.ok(result.stats, "even a blocked turn's delivery carries stats");
  assert.ok(result.stats!.shieldMs >= 10, `the scan time is measured (got ${result.stats!.shieldMs})`);
  assert.equal(result.stats!.modelMs, 0, "no model call ever ran");
  assert.equal(result.stats!.hops, 0);
});

// ------------------------------------------------------------ comm rig

interface CommRig {
  jobs: JobRunner;
  sock: Socket;
  received: ControlMessage[];
  providerCalls: { prompt: string; maxTokensOut?: number }[];
  issued: { jobId: string; modelMs?: number }[];
  close(): Promise<void>;
  modelRequest(jobId: string, prompt: string): Promise<Extract<ControlMessage, { t: "model_response" }>>;
}

async function commRig(): Promise<CommRig> {
  const dir = mkdtempSync(join(tmpdir(), "gus-fastlane-comm-"));
  writeFileSync(
    join(dir, "policy.json"),
    JSON.stringify({ ...DEFAULT_POLICY, mac: { workDirs: ["/work"], shellAllowlist: [] } }),
  );
  const governor = new Governor(dir, {
    maxTokensPerJob: 1_000_000,
    maxTokensPerDay: 10_000_000,
    defaultPriceUsdPer1k: 0.01,
  });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const approvals = new ApprovalEngine(dir, () => 10 * 60 * 1000);
  const policy = new PolicyStore(join(dir, "policy.json"));
  const providerCalls: CommRig["providerCalls"] = [];
  const issued: CommRig["issued"] = [];
  const provider: Provider = {
    id: "openai",
    model: "budget-fake",
    modelKey: "fake/budget",
    maxTokensOut: 1024,
    kind: "remote",
    complete: async (prompt: string, opts?: { maxTokensOut?: number }) => {
      providerCalls.push({ prompt, maxTokensOut: opts?.maxTokensOut });
      return { reply: { text: "a reply" }, tokensIn: 50, tokensOut: 10 };
    },
  };
  const hooks: HostHooks = {
    onRuntimeHello: () => {},
    onModelIssued: (jobId, _text, modelMs) => issued.push({ jobId, modelMs }),
    onModelRefused: () => {},
    noteAuthorizedWrite: () => {},
    onApprovalRequested: () => {},
    noteApprovedExecution: () => {},
    onDenied: () => {},
    onCapExceeded: () => {},
    onJobUpdate: () => {},
    onJobFinal: async () => {},
    logRuntime: () => {},
  };
  const socketPath = join(dir, "gus.sock");
  const comm = new CommServer(
    socketPath,
    governor,
    jobs,
    hooks,
    policy,
    approvals,
    undefined,
    undefined,
    () => provider,
    undefined,
    undefined,
    () => loadGovernorMode(dir),
    () => loadApproverPolicy(dir),
  );
  await comm.start();
  const sock = createConnection(socketPath);
  await new Promise<void>((resolve) => sock.once("connect", resolve));
  const received: ControlMessage[] = [];
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) received.push(JSON.parse(line) as ControlMessage);
    }
  });
  sock.write(JSON.stringify({ t: "hello", runtimeVersion: "test" }) + "\n");
  let seq = 0;
  return {
    jobs,
    sock,
    received,
    providerCalls,
    issued,
    async close() {
      sock.destroy();
      await comm.close();
      approvals.stop();
    },
    async modelRequest(jobId, prompt) {
      const reqId = `mr_${++seq}`;
      const before = received.length;
      sock.write(
        JSON.stringify({ t: "model_request", reqId, jobId, workClass: "primary", prompt }) + "\n",
      );
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const hit = received
          .slice(before)
          .find((m) => m.t === "model_response" && (m as { reqId?: string }).reqId === reqId);
        if (hit) return hit as Extract<ControlMessage, { t: "model_response" }>;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no model_response for ${reqId}`);
    },
  };
}

test("fast lane (comm): a voice job's model call is clamped to the spoken-reply budget; a plain job's is not", async () => {
  const r = await commRig();
  try {
    const voiceJob = r.jobs.create("chat", "voice", "hello", { voiceFastLane: true });
    r.jobs.transition(voiceJob.id, "running");
    const plainJob = r.jobs.create("chat", "4242", "hello");
    r.jobs.transition(plainJob.id, "running");

    const voiceRes = await r.modelRequest(voiceJob.id, "hello gus");
    assert.equal(voiceRes.ok, true);
    assert.equal(
      r.providerCalls.at(-1)?.maxTokensOut,
      VOICE_REPLY_TOKEN_BUDGET,
      "the voice call's provider budget is the spoken-reply clamp",
    );
    assert.ok(VOICE_REPLY_TOKEN_BUDGET < 1024, "the clamp is below the provider's configured budget");

    const plainRes = await r.modelRequest(plainJob.id, "hello there");
    assert.equal(plainRes.ok, true);
    assert.equal(
      r.providerCalls.at(-1)?.maxTokensOut,
      1024,
      "a typed job's call uses the provider's full configured budget",
    );

    // The hooks received a measured model time for both calls.
    assert.equal(r.issued.length, 2);
    for (const call of r.issued) {
      assert.equal(typeof call.modelMs, "number");
      assert.ok(call.modelMs! >= 0);
    }
  } finally {
    await r.close();
  }
});
