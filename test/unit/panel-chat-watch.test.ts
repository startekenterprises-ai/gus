/**
 * Panel Chat + Watch (v0.6) — the scope's acceptance, pinned.
 *
 * Chat:
 *  - Submitting the composer creates a NORMAL job through the
 *    ChannelHost pipeline (a job record in the panel-chat
 *    conversation, pushed to the runtime), and the Shield gate can
 *    block a chat message exactly like a Telegram one.
 *  - Deliveries route back to the chat (never to Telegram with a
 *    "panel-chat" address), and the transcript is durable:
 *    chat.jsonl + jobs.jsonl re-read by fresh instances lose
 *    nothing.
 *  - A parked chat job is approved/denied through the panel
 *    backend path (main.ts's resolveApproval composition — the
 *    same host method, the same hash-bound engine).
 *
 * Watch:
 *  - The frame endpoint requires the operator token, serves the
 *    bridge's PNG bytes, throttles repeat asks to the cached
 *    frame, and answers 503 with an honest detail when Screen
 *    Recording is missing or the bridge is absent.
 *  - The timeline merges events.jsonl + gate.jsonl newest-first,
 *    carrying receipt ids, skipping torn lines.
 *  - The page carries the Chat and Watch sections with help
 *    markers, and the registry has both entries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync } from "node:fs";
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
import { ApprovalEngine } from "../../packages/control-plane/src/approvals.js";
import {
  PanelChatAdapter,
  PANEL_CHAT_CONVERSATION,
} from "../../packages/control-plane/src/panel-chat.js";
import {
  FakeMacHostAdapter,
  UnavailableMacHostAdapter,
  type MacHostAdapter,
} from "../../packages/control-plane/src/mac.js";
import {
  WatchFrameSource,
  readWatchTimeline,
} from "../../packages/control-plane/src/watch.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";
import {
  PanelServer,
  type PanelBackend,
  type PanelJobData,
} from "../../packages/panel/src/index.js";
import { PANEL_HTML } from "../../packages/panel/src/page.js";
import { HELP_BY_ID } from "../../packages/panel/src/help.js";

// ---------------------------------------------------------------- rig

class RecordingAdapter implements ChannelAdapter {
  readonly name = "telegram";
  sent: OutboundMessage[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }
}

interface Rig {
  dir: string;
  jobs: JobRunner;
  approvals: ApprovalEngine;
  telegram: RecordingAdapter;
  panelChat: PanelChatAdapter;
  host: ChannelHost;
  pushed: { jobId: string; text: string }[];
  executed: string[];
  backend: PanelBackend;
}

function toJobData(j: {
  id: string; kind: string; state: string; createdAt: number; updatedAt: number;
  costUsd: number; tokensIn: number; tokensOut: number; outcomeNote?: string; receiptId?: string;
}): PanelJobData {
  return { ...j, shieldReceipts: [] };
}

async function rig(opts?: { shieldGate?: unknown; macHost?: MacHostAdapter }): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "gus-chatwatch-"));
  const governor = new Governor(dir, { maxTokensPerJob: 100_000, maxTokensPerDay: 10_000_000 });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const approvals = new ApprovalEngine(dir, () => 120_000);
  const telegram = new RecordingAdapter();
  const panelChat = new PanelChatAdapter(dir);
  const host = new ChannelHost(
    dir,
    governor,
    jobs,
    [telegram, panelChat],
    approvals,
    opts?.shieldGate as never,
  );
  const pushed: { jobId: string; text: string }[] = [];
  const executed: string[] = [];
  host.attachComm({
    pushUserMessage: (m: { jobId: string; text: string }) => pushed.push(m),
    broadcast: () => {},
    executeApproval: (req: { id: string }) => {
      executed.push(req.id);
    },
  } as never);
  await host.start();

  const frames = new WatchFrameSource(opts?.macHost ?? new FakeMacHostAdapter());
  const action = async () => ({ ok: true, detail: "ok" });
  const backend: PanelBackend = {
    status: () => ({
      version: "0.6.0",
      killed: false,
      shield: { provisioned: false, required: false, onUnavailable: "closed", baseUrl: "" },
      provider: { id: "stub", model: "stub-v0" },
      pendingApprovals: approvals.pending().length,
      spendTodayUsd: 0,
      spendMonthUsd: 0,
      governorMode: "enforcing",
      permissiveToday: { count: 0, recent: [] },
      settings: {
        providerKey: "not-required",
        telegramConfigured: false,
        caps: {},
        delegates: 0,
        macWorkDirs: 0,
        approverPolicy: {
          gusApprovesDelegates: false,
          gusApprovesOwn: false,
          delegatesMayApprove: false,
          scope: "bounded",
          maxApprovalsPerHour: 30,
        },
      },
    }),
    ledger: () => ({
      entries: [],
      audit: { reserves: 0, settles: 0, refunds: 0, openReservations: 0, settledUsd: 0, reconciles: true },
      summary: { todayUsd: 0, monthUsd: 0, totalUsd: 0, caps: {} },
    }),
    jobs: () => jobs.list(50).map(toJobData),
    approvals: () =>
      approvals.pending().map((r) => ({
        id: r.id,
        jobId: r.jobId,
        summary: r.summary,
        reason: r.reason,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      })),
    // Mirrors main.ts (v0.7): resolved records, newest first.
    approvalsHistory: () =>
      approvals.recentResolved(25).map((r) => ({
        id: r.id,
        jobId: r.jobId,
        summary: r.summary,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
        resolvedBy: r.resolvedBy,
      })),
    // Mirrors main.ts: the panel delegates to ChannelHost — the
    // one channel resolution path — never to the engine directly.
    resolveApproval: async (id, approve) => {
      const req = approvals.get(id);
      if (!req || req.status !== "pending") {
        return { ok: false, detail: `Approval ${id} is not pending. Nothing was executed.` };
      }
      await host.resolveApproval("telegram", req.conversationId, id, approve, "panel");
      const after = approvals.get(id);
      return after && after.status !== "pending"
        ? { ok: true, detail: approve ? "Approved — executing exactly that." : "Denied. Nothing ran." }
        : { ok: false, detail: "The approval could not be resolved. Nothing was executed." };
    },
    setKilled: action,
    setGovernorMode: action,
    setApproverPolicy: action,
    setShieldPolicy: action,
    settingsDetail: () => ({ macWorkDirs: [], macShellAllowlist: [], delegates: [] }),
    vaultNames: () => [],
    storeSecret: () => ({ ok: true, detail: "ok" }),
    onboarding: () => ({
      steps: {
        shield: { done: false }, telegram: { done: false }, provider: { done: false },
        caps: { done: false }, firstJob: { done: false },
      },
      suggestedCaps: { maxUsdPerTask: 2, maxUsdPerDay: 10, maxUsdPerMonth: 100 },
    }),
    onboardingShield: action,
    onboardingTelegram: action,
    onboardingProvider: action,
    onboardingCaps: action,
    onboardingFirstJob: async () => ({ ok: true, detail: "ok" }),
    skills: () => [],
    installSkill: action,
    submitChat: async (text) => panelChat.submit(text),
    chatHistory: () => ({
      conversationId: PANEL_CHAT_CONVERSATION,
      messages: panelChat.history(),
      jobs: jobs
        .list(200)
        .filter((j) => j.conversationId === PANEL_CHAT_CONVERSATION)
        .reverse()
        .map(toJobData),
    }),
    watchFrame: () => frames.frame(),
    watchTimeline: () => readWatchTimeline(dir, 60),
  };
  return { dir, jobs, approvals, telegram, panelChat, host, pushed, executed, backend };
}

const tick = () => new Promise((r) => setTimeout(r, 25));

// ---------------------------------------------------------------- chat

test("chat: submitting creates a normal job; the reply lands in the chat, not Telegram", async () => {
  const r = await rig();
  const res = r.panelChat.submit("hello gus");
  assert.equal(res.ok, true);
  await tick();
  assert.equal(r.pushed.length, 1, "the message was pushed to the runtime as a job");
  const jobId = r.pushed[0].jobId;
  const job = r.jobs.get(jobId);
  assert.equal(job?.conversationId, PANEL_CHAT_CONVERSATION);
  assert.equal(job?.state, "running");

  const REPLY = "Hello — panel chat works.";
  r.host.onModelIssued(jobId, REPLY);
  await r.host.onJobFinal(jobId, REPLY);
  assert.equal(r.jobs.get(jobId)?.state, "verified-done");

  const history = r.backend.chatHistory();
  assert.deepEqual(
    history.messages.map((m) => [m.direction, m.text]),
    [
      ["in", "hello gus"],
      ["out", REPLY],
    ],
  );
  assert.equal(history.jobs.length, 1);
  assert.equal(history.jobs[0].state, "verified-done");
  assert.ok(
    r.telegram.sent.every((m) => m.conversationId !== PANEL_CHAT_CONVERSATION),
    "nothing for the panel conversation may leak onto Telegram",
  );
});

test("chat: the Shield gate blocks a chat message like any other channel's", async () => {
  const blockingGate = {
    scanSurface: async () => ({
      action: "block",
      scanned: true,
      detail: "test verdict: malicious",
      receipt: { receiptId: "rcpt_test_block" },
    }),
  };
  const r = await rig({ shieldGate: blockingGate });
  r.panelChat.submit("a very bad message");
  await tick();
  assert.equal(r.pushed.length, 0, "a blocked message never reaches the runtime");
  const chatJobs = r.jobs.list(10).filter((j) => j.conversationId === PANEL_CHAT_CONVERSATION);
  assert.equal(chatJobs.length, 1);
  assert.equal(chatJobs[0].state, "failed-loudly");
  assert.equal(chatJobs[0].receiptId, "rcpt_test_block", "settled WITH the Shield receipt");
  const out = r.backend.chatHistory().messages.filter((m) => m.direction === "out");
  assert.equal(out.length, 1);
  assert.match(out[0].text, /blocked by the Agent-Shield gate/);
});

test("chat: a parked job's approval resolves through the panel path (approve and deny)", async () => {
  const r = await rig();

  // Approve path.
  r.panelChat.submit("write the file");
  await tick();
  const jobId = r.pushed[0].jobId;
  r.jobs.transition(jobId, "needs-approval");
  const req = r.approvals.create({
    jobId,
    conversationId: PANEL_CHAT_CONVERSATION,
    tool: "workspace_write",
    args: { path: "notes.txt", content: "hi" },
    reason: "writes outside the sandbox need a human",
  });
  r.host.onApprovalRequested(req);
  await tick();
  const parkNotice = r.backend.chatHistory().messages.at(-1);
  assert.equal(parkNotice?.direction, "out");
  assert.match(parkNotice?.text ?? "", /Job parked/);
  assert.ok(
    r.telegram.sent.every((m) => m.conversationId !== PANEL_CHAT_CONVERSATION),
    "the park notice belongs to the chat, not Telegram",
  );

  const resolved = await r.backend.resolveApproval(req.id, true);
  assert.equal(resolved.ok, true);
  assert.equal(r.approvals.get(req.id)?.status, "approved");
  assert.deepEqual(r.executed, [req.id], "the approved action was handed to execution exactly once");
  assert.match(r.backend.chatHistory().messages.at(-1)?.text ?? "", /✅ Approved/);

  // Deny path.
  r.panelChat.submit("write another file");
  await tick();
  const job2 = r.pushed[1].jobId;
  r.jobs.transition(job2, "needs-approval");
  const req2 = r.approvals.create({
    jobId: job2,
    conversationId: PANEL_CHAT_CONVERSATION,
    tool: "workspace_write",
    args: { path: "notes2.txt", content: "hi" },
    reason: "same park",
  });
  const denied = await r.backend.resolveApproval(req2.id, false);
  assert.equal(denied.ok, true);
  assert.equal(r.jobs.get(job2)?.state, "failed-loudly", "a denied job settles failed-loudly");
  assert.match(r.backend.chatHistory().messages.at(-1)?.text ?? "", /🚫 Denied/);
  assert.deepEqual(r.executed, [req.id], "a denial executes nothing");
});

test("chat: history survives — fresh instances re-read the durable state", async () => {
  const r = await rig();
  r.panelChat.submit("remember me");
  await tick();
  const jobId = r.pushed[0].jobId;
  r.host.onModelIssued(jobId, "I will.");
  await r.host.onJobFinal(jobId, "I will.");

  const freshChat = new PanelChatAdapter(r.dir);
  assert.deepEqual(
    freshChat.history().map((m) => [m.direction, m.text]),
    [
      ["in", "remember me"],
      ["out", "I will."],
    ],
  );
  const freshJobs = new JobRunner(r.dir, new LocalReceiptIssuer(join(r.dir, "receipt-stub.key")));
  const settled = freshJobs.list(10).filter((j) => j.conversationId === PANEL_CHAT_CONVERSATION);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].state, "verified-done");
});

test("chat: POST /api/chat through the real panel server creates the job", async () => {
  const r = await rig();
  const panel = new PanelServer(r.backend, { token: "test-token-123", port: 0 });
  await panel.start();
  try {
    const base = `http://127.0.0.1:${panel.port}`;
    const noAuth = await fetch(`${base}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(noAuth.status, 401);
    const ok = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { authorization: "Bearer test-token-123", "content-type": "application/json" },
      body: JSON.stringify({ text: "hello from the panel" }),
    });
    assert.equal(ok.status, 200);
    await tick();
    assert.equal(r.pushed.length, 1, "the HTTP submission became a runtime job");
    const hist = await (await fetch(`${base}/api/chat/history`, {
      headers: { authorization: "Bearer test-token-123" },
    })).json() as { messages: { direction: string; text: string }[] };
    assert.deepEqual(hist.messages.map((m) => m.text), ["hello from the panel"]);
  } finally {
    await panel.stop();
  }
});

// ------------------------------------------------- approvals history (v0.7)

test("approvals history: resolved records newest-first; pending stays out", async () => {
  const r = await rig();

  // One approved, one denied, one left pending.
  r.panelChat.submit("write the first file");
  await tick();
  const job1 = r.pushed[0].jobId;
  r.jobs.transition(job1, "needs-approval");
  const req1 = r.approvals.create({
    jobId: job1,
    conversationId: PANEL_CHAT_CONVERSATION,
    tool: "workspace_write",
    args: { path: "one.txt", content: "1" },
    reason: "first park",
  });
  assert.equal((await r.backend.resolveApproval(req1.id, true)).ok, true);

  r.panelChat.submit("write the second file");
  await tick();
  const job2 = r.pushed[1].jobId;
  r.jobs.transition(job2, "needs-approval");
  const req2 = r.approvals.create({
    jobId: job2,
    conversationId: PANEL_CHAT_CONVERSATION,
    tool: "workspace_write",
    args: { path: "two.txt", content: "2" },
    reason: "second park",
  });
  assert.equal((await r.backend.resolveApproval(req2.id, false)).ok, true);

  const req3 = r.approvals.create({
    jobId: job2,
    conversationId: PANEL_CHAT_CONVERSATION,
    tool: "workspace_write",
    args: { path: "three.txt", content: "3" },
    reason: "still waiting",
  });

  const history = r.backend.approvalsHistory();
  assert.deepEqual(
    history.map((h) => h.id),
    [req2.id, req1.id],
    "newest resolution first; the pending record is not history",
  );
  assert.equal(history[0].status, "denied");
  assert.equal(history[1].status, "approved");
  for (const h of history) {
    assert.equal(typeof h.resolvedAt, "number");
    assert.equal(typeof h.resolvedBy, "string", "the resolver is stamped, unedited");
    assert.equal(h.summary.length > 0, true);
  }
  assert.equal(r.approvals.recentResolved(1).length, 1, "the engine caps the list");
  assert.equal(r.approvals.get(req3.id)?.status, "pending");
});

test("approvals history: GET /api/approvals/history is token-gated and serves the records", async () => {
  const r = await rig();
  r.panelChat.submit("write the file");
  await tick();
  const jobId = r.pushed[0].jobId;
  r.jobs.transition(jobId, "needs-approval");
  const req = r.approvals.create({
    jobId,
    conversationId: PANEL_CHAT_CONVERSATION,
    tool: "workspace_write",
    args: { path: "notes.txt", content: "hi" },
    reason: "history route park",
  });
  assert.equal((await r.backend.resolveApproval(req.id, true)).ok, true);

  const panel = new PanelServer(r.backend, { token: "test-token-123", port: 0 });
  await panel.start();
  try {
    const base = `http://127.0.0.1:${panel.port}`;
    const noAuth = await fetch(`${base}/api/approvals/history`);
    assert.equal(noAuth.status, 401);
    const res = await fetch(`${base}/api/approvals/history`, {
      headers: { authorization: "Bearer test-token-123" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; status: string; jobId: string }[];
    assert.equal(body.length, 1);
    assert.equal(body[0].id, req.id);
    assert.equal(body[0].status, "approved");
    assert.equal(body[0].jobId, jobId);
  } finally {
    await panel.stop();
  }
});

// ---------------------------------------------------------------- watch

const PNG_BYTES = Buffer.from("fake-png-frame-bytes");

test("watch: the frame endpoint serves the bridge's PNG, auth-gated, throttled", async () => {
  const fake = new FakeMacHostAdapter();
  fake.state.screenshotPngBase64 = PNG_BYTES.toString("base64");
  const r = await rig({ macHost: fake });
  const panel = new PanelServer(r.backend, { token: "test-token-123", port: 0 });
  await panel.start();
  try {
    const base = `http://127.0.0.1:${panel.port}`;
    const noAuth = await fetch(`${base}/api/watch/frame`);
    assert.equal(noAuth.status, 401);
    const ok = await fetch(`${base}/api/watch/frame`, {
      headers: { authorization: "Bearer test-token-123" },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG_BYTES);
    // A second ask inside the throttle window gets the SAME frame
    // without a second observation of the desktop.
    const again = await fetch(`${base}/api/watch/frame`, {
      headers: { authorization: "Bearer test-token-123" },
    });
    assert.equal(again.status, 200);
    assert.equal(
      fake.calls.filter((c) => c === "observe").length,
      1,
      "the throttle cache served the repeat ask — the desktop was observed once",
    );
  } finally {
    await panel.stop();
  }
});

test("watch: no Screen Recording grant → 503 with the honest notice", async () => {
  const r = await rig({ macHost: new FakeMacHostAdapter() }); // no screenshot on the fake
  const frame = await r.backend.watchFrame();
  assert.equal(frame.ok, false);
  if (!frame.ok) assert.match(frame.detail, /Screen Recording/);
  const panel = new PanelServer(r.backend, { token: "test-token-123", port: 0 });
  await panel.start();
  try {
    const res = await fetch(`http://127.0.0.1:${panel.port}/api/watch/frame`, {
      headers: { authorization: "Bearer test-token-123" },
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { ok: boolean; detail: string };
    assert.equal(body.ok, false);
    assert.match(body.detail, /timeline below still works/);
  } finally {
    await panel.stop();
  }
});

test("watch: bridge absent → 503 saying so, never a fake frame", async () => {
  const r = await rig({ macHost: new UnavailableMacHostAdapter() });
  const frame = await r.backend.watchFrame();
  assert.equal(frame.ok, false);
  if (!frame.ok) {
    assert.match(frame.detail, /No frame:/);
    assert.match(frame.detail, /not installed on this host/);
  }
});

test("watch: the timeline merges events + gate logs, newest first, receipts attached", async () => {
  const r = await rig();
  appendFileSync(
    join(r.dir, "events.jsonl"),
    JSON.stringify({ ts: 1000, kind: "approval_approved", id: "appr_1", jobId: "job_a", via: "panel" }) + "\n" +
    JSON.stringify({ ts: 3000, kind: "permissive_action", jobId: "job_b", detail: "let a click through" }) + "\n" +
    "{torn line\n",
  );
  appendFileSync(
    join(r.dir, "gate.jsonl"),
    JSON.stringify({
      ts: 2000, jobId: "job_a", surface: "tool-call", action: "block", scanned: true,
      receiptId: "rcpt_gate_1", contentSha256: "abc", detail: "gate said no",
    }) + "\n",
  );
  const entries = readWatchTimeline(r.dir, 60);
  assert.deepEqual(entries.map((e) => e.ts), [3000, 2000, 1000], "newest first, torn line skipped");
  const gate = entries[1];
  assert.equal(gate.source, "gate");
  assert.equal(gate.kind, "gate tool-call → block");
  assert.equal(gate.receiptId, "rcpt_gate_1");
  assert.equal(gate.jobId, "job_a");
  assert.equal(entries[0].source, "events");
  assert.equal(entries[0].detail, "let a click through");
  assert.ok(existsSync(join(r.dir, "events.jsonl")));
});

// ------------------------------------------------------- page + registry

test("page + help: Chat and Watch sections exist, with markers that resolve", () => {
  for (const id of ["panel-chat", "panel-watch"]) {
    const entry = HELP_BY_ID.get(id);
    assert.ok(entry, `help registry is missing ${id}`);
    assert.ok(entry.tip.length > 20 && entry.body.length > entry.tip.length);
    assert.ok(PANEL_HTML.includes(`data-help="${id}"`), `page has no marker for ${id}`);
  }
  assert.ok(PANEL_HTML.includes('id="chat-input"'), "composer exists");
  assert.ok(PANEL_HTML.includes('id="chat-log"'), "transcript exists");
  assert.ok(PANEL_HTML.includes('id="watch-frame"'), "frame element exists");
  assert.ok(PANEL_HTML.includes('id="watch-timeline"'), "timeline exists");
  assert.ok(PANEL_HTML.includes('id="watch-toggle"'), "pause control exists");
  assert.ok(PANEL_HTML.includes("/api/chat/history"), "page polls chat history");
  assert.ok(PANEL_HTML.includes("/api/watch/frame"), "page pulls frames");
  assert.ok(PANEL_HTML.includes("/api/watch/timeline"), "page polls the timeline");
  // The honesty lines the scope demands, in the registry copy:
  assert.match(HELP_BY_ID.get("panel-chat")?.body ?? "", /not a bypass|never relaxes|blocked here/);
  assert.match(HELP_BY_ID.get("panel-watch")?.tip ?? "", /never stored/);
});
