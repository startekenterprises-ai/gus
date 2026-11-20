/**
 * Approval delegation (v0.5) — Permissive-mode agent approvers.
 *
 * What is pinned here:
 *  - The policy file: missing/malformed means delegation OFF; a
 *    written policy reads back; the rate clamps.
 *  - The scope taxonomy: bounded classes (Mac input, fs writes
 *    outside the work dirs, non-allowlisted shell), the floors
 *    (deletes, installs, sends, git push, sudo/dd/kill-class shell,
 *    keychain) refuse under EVERY scope, everything else is "other".
 *  - Routing: Enforcing ignores the policy; Permissive with the
 *    policy off ignores it; each checkbox routes its origin; the
 *    hourly budget turns a delegable park into an operator park.
 *  - The CommServer path: GUS decides synchronously with a metered
 *    model call; approve → the record is consumed and the call
 *    executes; deny / garbage / provider error → fail-closed denial
 *    and a failed-loudly job; the record carries resolvedBy "gus",
 *    the policy snapshot, and the model's reason.
 *  - The ChannelHost path: a delegate may resolve a routed park on
 *    a job it did NOT submit (command and button), never its own,
 *    and never in Enforcing.
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
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";
import { Governor } from "../../packages/control-plane/src/governor.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { PolicyStore, DEFAULT_POLICY, type PolicyData } from "../../packages/control-plane/src/policy.js";
import { ApprovalEngine, type ApprovalRequest } from "../../packages/control-plane/src/approvals.js";
import { CommServer, type HostHooks } from "../../packages/control-plane/src/comm-server.js";
import { ChannelHost } from "../../packages/control-plane/src/channel-host.js";
import type { Provider } from "../../packages/control-plane/src/providers.js";
import { loadGovernorMode, writeGovernorMode } from "../../packages/control-plane/src/governor-mode.js";
import {
  DEFAULT_APPROVER_POLICY,
  loadApproverPolicy,
  parseApprovalDecision,
  parkScopeClass,
  routePark,
  writeApproverPolicy,
  type ApproverPolicy,
} from "../../packages/control-plane/src/approver-policy.js";
import { PANEL_HTML } from "../../packages/panel/src/page.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The engine's durable records, the way a restart would see them. */
function records(engine: ApprovalEngine): ApprovalRequest[] {
  return [
    ...(engine as unknown as { requests: Map<string, ApprovalRequest> }).requests.values(),
  ];
}

const FULL_POLICY: ApproverPolicy = {
  gusApprovesDelegates: true,
  gusApprovesOwn: true,
  delegatesMayApprove: true,
  scope: "all_except_floors",
  maxApprovalsPerHour: 30,
};

function policyData(mac: Partial<PolicyData["mac"]> = {}): PolicyData {
  return {
    ...DEFAULT_POLICY,
    mac: { workDirs: ["/work"], shellAllowlist: [], ...mac },
  };
}

// ---------------------------------------------------------- policy file

test("approver policy file: missing or malformed is all-off; written policy reads back; rate clamps", () => {
  const dir = tempDir("gus-appr-file-");
  assert.deepEqual(loadApproverPolicy(dir), DEFAULT_APPROVER_POLICY);
  writeFileSync(join(dir, "approver-policy.json"), "{not json");
  assert.deepEqual(loadApproverPolicy(dir), DEFAULT_APPROVER_POLICY);
  writeFileSync(join(dir, "approver-policy.json"), JSON.stringify({ gusApprovesOwn: "yes" }));
  assert.equal(loadApproverPolicy(dir).gusApprovesOwn, false, "only a literal true enables a path");
  writeApproverPolicy(dir, { ...FULL_POLICY, maxApprovalsPerHour: 5000 }, "test");
  const back = loadApproverPolicy(dir);
  assert.equal(back.gusApprovesDelegates, true);
  assert.equal(back.gusApprovesOwn, true);
  assert.equal(back.delegatesMayApprove, true);
  assert.equal(back.scope, "all_except_floors");
  assert.equal(back.maxApprovalsPerHour, 1000, "the rate clamps to the sane ceiling");
});

// ---------------------------------------------------------- decision parser

test("decision parser: exactly one JSON decision or nothing", () => {
  assert.deepEqual(parseApprovalDecision('{"decision":"approve","reason":"small and reversible"}'), {
    decision: "approve",
    reason: "small and reversible",
  });
  assert.deepEqual(parseApprovalDecision('Here is my decision: {"decision": "deny", "reason": "too broad"} — done'), {
    decision: "deny",
    reason: "too broad",
  });
  assert.equal(parseApprovalDecision("I think this is fine, go ahead"), undefined);
  assert.equal(parseApprovalDecision('{"decision":"maybe","reason":"x"}'), undefined);
  assert.equal(parseApprovalDecision(""), undefined);
});

// ---------------------------------------------------------- scope taxonomy

const cls = (effectiveClass: "read" | "write" | "destructive" | "external-send" | "pay", reason = "parked") => ({
  action: "needs-approval" as const,
  effectiveClass,
  reason,
});
const call = (tool: string, args: Record<string, unknown> = {}) => ({
  tool,
  declaredClass: "write" as const,
  args,
});

test("scope taxonomy: bounded classes, floors, and the rest", () => {
  const pd = policyData();
  // Bounded: Mac input injection.
  for (const t of ["mac.click", "mac.type", "mac.key", "mac.scroll", "mac.picker.select"]) {
    assert.equal(parkScopeClass(call(t), cls("write"), pd), "bounded", t);
  }
  // Bounded: fs writes outside the work dirs (both jail forms).
  assert.equal(parkScopeClass(call("mac.fs.write", { path: "/elsewhere/x" }), cls("destructive"), pd), "bounded");
  assert.equal(parkScopeClass(call("workspace_write", { path: "../escape.txt" }), cls("destructive"), pd), "bounded");
  // Bounded: non-allowlisted shell.
  assert.equal(
    parkScopeClass(call("mac.shell.run", { command: "make thing", cwd: "/work" }), cls("write"), pd),
    "bounded",
  );
  // Floors — under any scope.
  assert.equal(parkScopeClass(call("bulk_delete", { paths: ["a"] }), cls("destructive"), pd), "floor");
  assert.equal(parkScopeClass(call("gmail_delete", { messageIds: ["1"] }), cls("destructive"), pd), "floor");
  assert.equal(parkScopeClass(call("gmail_send", { to: ["a@b.c"] }), cls("external-send"), pd), "floor");
  assert.equal(parkScopeClass(call("send_post", {}), cls("external-send"), pd), "floor");
  assert.equal(parkScopeClass(call("vault_read", { name: "x" }), cls("read"), pd), "floor");
  for (const command of [
    "rm -rf build",
    "sudo ls",
    "dd if=/dev/zero of=/dev/disk2",
    "kill 1234",
    "git push origin main",
    "npm install left-pad",
    "brew install wget",
    "security find-generic-password -a x",
    "ls && rm old.log",
  ]) {
    assert.equal(
      parkScopeClass(call("mac.shell.run", { command, cwd: "/work" }), cls("destructive"), pd),
      "floor",
      command,
    );
  }
  // Other: approvable only under all_except_floors.
  assert.equal(parkScopeClass(call("mac.fs.read", { path: "/elsewhere/x" }), cls("destructive"), pd), "other");
  assert.equal(
    parkScopeClass(call("mac.shell.run", { command: "mv a b", cwd: "/work" }), cls("destructive"), pd),
    "other",
  );
  assert.equal(
    parkScopeClass(call("mac.shell.run", { command: "curl https://x.test", cwd: "/work" }), cls("write"), pd),
    "other",
  );
  assert.equal(parkScopeClass(call("fetch", { url: "https://x.test", secretName: "k" }), cls("read"), pd), "other");
  assert.equal(parkScopeClass(call("charge_card", {}), cls("pay"), pd), "other");
});

// ---------------------------------------------------------- routing

test("routing: mode, checkboxes, origin, scope, and the rate budget", () => {
  const pd = policyData();
  const boundedCall = call("mac.click", { element: "OK" });
  const boundedCls = cls("write");
  const base = { call: boundedCall, cls: boundedCls, policyData: pd, agentApprovalsLastHour: 0 };

  assert.equal(routePark({ ...base, mode: "enforcing", policy: FULL_POLICY }).kind, "none");
  assert.equal(
    routePark({ ...base, mode: "permissive", policy: DEFAULT_APPROVER_POLICY }).kind,
    "none",
    "permissive with delegation off routes nowhere",
  );
  // Each checkbox routes its own origin.
  assert.equal(
    routePark({ ...base, mode: "permissive", policy: { ...DEFAULT_APPROVER_POLICY, gusApprovesOwn: true } }).kind,
    "gus",
  );
  assert.equal(
    routePark({
      ...base,
      mode: "permissive",
      policy: { ...DEFAULT_APPROVER_POLICY, gusApprovesDelegates: true },
      originDelegate: "Nova",
    }).kind,
    "gus",
  );
  assert.equal(
    routePark({
      ...base,
      mode: "permissive",
      policy: { ...DEFAULT_APPROVER_POLICY, gusApprovesOwn: true },
      originDelegate: "Nova",
    }).kind,
    "none",
    "the own-jobs checkbox does not cover a delegate's job",
  );
  assert.equal(
    routePark({ ...base, mode: "permissive", policy: { ...DEFAULT_APPROVER_POLICY, delegatesMayApprove: true } }).kind,
    "delegate",
  );
  // Bounded scope excludes an "other" park even with GUS's checkbox on.
  assert.equal(
    routePark({
      mode: "permissive",
      policy: { ...DEFAULT_APPROVER_POLICY, gusApprovesOwn: true, scope: "bounded" },
      call: call("fetch", { url: "https://x.test", secretName: "k" }),
      cls: cls("read"),
      policyData: pd,
      agentApprovalsLastHour: 0,
    }).kind,
    "none",
  );
  // Floors refuse under all_except_floors too.
  assert.equal(
    routePark({
      mode: "permissive",
      policy: FULL_POLICY,
      call: call("bulk_delete", { paths: ["a"] }),
      cls: cls("destructive"),
      policyData: pd,
      agentApprovalsLastHour: 0,
    }).kind,
    "none",
  );
  // Budget spent: a delegable park goes back to the operator AS A PARK.
  const spent = routePark({
    ...base,
    mode: "permissive",
    policy: { ...DEFAULT_APPROVER_POLICY, gusApprovesOwn: true, maxApprovalsPerHour: 2 },
    agentApprovalsLastHour: 2,
  });
  assert.equal(spent.kind, "park-operator");
});

// ---------------------------------------------------------- comm-server stack

interface Stack {
  dir: string;
  jobs: JobRunner;
  approvals: ApprovalEngine;
  comm: CommServer;
  sock: Socket;
  received: ControlMessage[];
  providerCalls: string[];
  permissiveActions: string[];
  approvalRequests: string[];
  close(): Promise<void>;
  toolCall(jobId: string, tool: string, declaredClass: "read" | "write" | "destructive" | "external-send", args: Record<string, unknown>): Promise<ControlMessage>;
  makeJob(input: string): string;
}

async function startStack(opts: {
  mode: "enforcing" | "permissive";
  approver?: ApproverPolicy;
  decision?: string | Error;
  macGate?: boolean;
}): Promise<Stack> {
  const dir = tempDir("gus-appr-comm-");
  if (opts.mode === "permissive") writeGovernorMode(dir, "permissive", "test");
  if (opts.approver) writeApproverPolicy(dir, opts.approver, "test");
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policyData()));

  const governor = new Governor(dir, { maxTokensPerJob: 1_000_000, maxTokensPerDay: 10_000_000 });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const approvals = new ApprovalEngine(dir, () => 10 * 60 * 1000);
  const policy = new PolicyStore(join(dir, "policy.json"));
  const providerCalls: string[] = [];
  const permissiveActions: string[] = [];
  const approvalRequests: string[] = [];

  const provider: Provider = {
    id: "openai",
    model: "decision-fake",
    modelKey: "fake/decision",
    maxTokensOut: 512,
    kind: "remote",
    complete: async (prompt: string) => {
      providerCalls.push(prompt);
      if (opts.decision instanceof Error) throw opts.decision;
      return {
        reply: { text: opts.decision ?? '{"decision":"approve","reason":"small, named, and reversible"}' },
        tokensIn: 100,
        tokensOut: 20,
      };
    },
  };
  const hooks: HostHooks = {
    onRuntimeHello: () => {},
    onModelIssued: () => {},
    onModelRefused: () => {},
    noteAuthorizedWrite: () => {},
    onApprovalRequested: (req) => approvalRequests.push(req.id),
    noteApprovedExecution: () => {},
    onDenied: () => {},
    onCapExceeded: () => {},
    onJobUpdate: () => {},
    onJobFinal: async () => {},
    onPermissiveAction: (_jobId, detail) => permissiveActions.push(detail),
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
    opts.macGate
      ? { execute: async () => ({ ok: true, summary: "mac action done" }) }
      : undefined,
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
    dir,
    jobs,
    approvals,
    comm,
    sock,
    received,
    providerCalls,
    permissiveActions,
    approvalRequests,
    async close() {
      sock.destroy();
      await comm.close();
      approvals.stop();
    },
    makeJob(input: string): string {
      const job = jobs.create("chat", "conv-1", input);
      jobs.transition(job.id, "running");
      return job.id;
    },
    async toolCall(jobId, tool, declaredClass, args) {
      const reqId = `req_${++seq}`;
      const before = received.length;
      sock.write(JSON.stringify({ t: "tool_call", reqId, jobId, tool, declaredClass, args }) + "\n");
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const hit = received
          .slice(before)
          .find((m) => m.t === "tool_result" && (m as { reqId?: string }).reqId === reqId);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no tool_result for ${reqId}`);
    },
  };
}

type ToolResult = Extract<ControlMessage, { t: "tool_result" }>;

const ESCAPE_WRITE = { path: "../escape.txt", content: "hello" };

test("comm: enforcing ignores the approver policy entirely — the park is the operator's", async () => {
  const s = await startStack({ mode: "enforcing", approver: FULL_POLICY });
  try {
    const jobId = s.makeJob("write outside");
    const res = (await s.toolCall(jobId, "workspace_write", "write", ESCAPE_WRITE)) as ToolResult;
    assert.equal(res.status, "needs_approval");
    assert.equal(s.providerCalls.length, 0, "no decision call in enforcing");
    const pending = s.approvals.pendingForJob(jobId);
    assert.ok(pending, "the park exists");
    assert.equal(pending.delegation, undefined, "an enforcing park carries no delegation stamp");
    assert.equal(s.jobs.get(jobId)?.state, "needs-approval");
  } finally {
    await s.close();
  }
});

test("comm: permissive with delegation off proceeds stamped, exactly as v0.4", async () => {
  const s = await startStack({ mode: "permissive" });
  try {
    const jobId = s.makeJob("write outside");
    const res = (await s.toolCall(jobId, "workspace_write", "write", ESCAPE_WRITE)) as ToolResult;
    assert.equal(res.status, "authorized");
    assert.equal(s.providerCalls.length, 0);
    assert.equal(s.approvals.pending().length, 0);
    assert.equal(s.approvals.agentApprovalCountSince(0), 0);
    assert.ok(s.permissiveActions.some((d) => d.includes("PERMISSIVE")), "the let-through is stamped");
  } finally {
    await s.close();
  }
});

test("comm: GUS approves its own job's park — record consumed, stamped, reasoned", async () => {
  const s = await startStack({
    mode: "permissive",
    approver: { ...DEFAULT_APPROVER_POLICY, gusApprovesOwn: true },
  });
  try {
    const jobId = s.makeJob("write outside");
    const res = (await s.toolCall(jobId, "workspace_write", "write", ESCAPE_WRITE)) as ToolResult;
    assert.equal(res.status, "authorized", "the approved call executes");
    assert.equal(s.providerCalls.length, 1, "one decision call");
    assert.ok(s.providerCalls[0].includes("workspace_write"), "the prompt names the tool");
    const rec = records(s.approvals).find((r) => r.jobId === jobId);
    assert.equal(rec?.status, "consumed", "approved, then consumed before execution");
    const job = s.jobs.get(jobId);
    assert.equal(job?.state, "running", "the job was never parked or settled by the approval");
    assert.equal(s.approvals.agentApprovalCountSince(0), 1, "the resolution counts against the budget");
  } finally {
    await s.close();
  }
});

test("comm: the approval record carries resolvedBy, the policy snapshot, and the model's reason", async () => {
  const s = await startStack({
    mode: "permissive",
    approver: { ...DEFAULT_APPROVER_POLICY, gusApprovesOwn: true, maxApprovalsPerHour: 7 },
    decision: '{"decision":"approve","reason":"one named file, content shown, reversible"}',
  });
  try {
    const jobId = s.makeJob("write outside");
    await s.toolCall(jobId, "workspace_write", "write", ESCAPE_WRITE);
    // Read the durable store back the way a restart would.
    const reloaded = new ApprovalEngine(s.dir, () => 60_000);
    const rec = records(reloaded).find((r) => r.jobId === jobId);
    assert.ok(rec, "the record is durable");
    assert.equal(rec.status, "consumed", "approved then consumed before execution — single-use");
    assert.equal(rec.resolvedBy, "gus");
    assert.equal(rec.agentResolution?.reason, "one named file, content shown, reversible");
    assert.equal(rec.agentResolution?.policy.gusApprovesOwn, true);
    assert.equal(rec.agentResolution?.policy.maxApprovalsPerHour, 7, "the snapshot is the policy in force");
    reloaded.stop();
  } finally {
    await s.close();
  }
});

test("comm: GUS denies — the call is refused and the job settles failed-loudly", async () => {
  const s = await startStack({
    mode: "permissive",
    approver: { ...DEFAULT_APPROVER_POLICY, gusApprovesOwn: true },
    decision: '{"decision":"deny","reason":"the path escapes the workspace and the purpose is unstated"}',
  });
  try {
    const jobId = s.makeJob("write outside");
    const res = (await s.toolCall(jobId, "workspace_write", "write", ESCAPE_WRITE)) as ToolResult;
    assert.equal(res.status, "denied");
    assert.match(res.note ?? "", /denied by GUS as delegated approver/);
    assert.equal(s.jobs.get(jobId)?.state, "failed-loudly");
  } finally {
    await s.close();
  }
});

test("comm: unparseable decision and provider error both fail closed to a denial", async () => {
  for (const decision of ["Sure, go ahead!", new Error("provider 503")]) {
    const s = await startStack({
      mode: "permissive",
      approver: { ...DEFAULT_APPROVER_POLICY, gusApprovesOwn: true },
      decision,
    });
    try {
      const jobId = s.makeJob("write outside");
      const res = (await s.toolCall(jobId, "workspace_write", "write", ESCAPE_WRITE)) as ToolResult;
      assert.equal(res.status, "denied", String(decision));
      assert.equal(s.jobs.get(jobId)?.state, "failed-loudly");
    } finally {
      await s.close();
    }
  }
});

test("comm: a floor class never reaches the approver — even under all_except_floors it just proceeds stamped", async () => {
  const s = await startStack({ mode: "permissive", approver: FULL_POLICY });
  try {
    const jobId = s.makeJob("delete things");
    const res = (await s.toolCall(jobId, "bulk_delete", "destructive", { paths: ["a.txt", "b.txt"] })) as ToolResult;
    assert.equal(res.status, "authorized", "permissive proceeds — the floor only bars AGENT approval");
    assert.equal(s.providerCalls.length, 0, "the decision model is never asked about a floor");
    assert.equal(s.approvals.agentApprovalCountSince(0), 0, "no approval record was created or resolved");
    assert.ok(s.permissiveActions.some((d) => d.includes("floor class")), "the stamp says why");
  } finally {
    await s.close();
  }
});

test("comm: bounded scope leaves an 'other' park to the mode; all_except_floors routes it to GUS", async () => {
  const fetchArgs = { url: "https://x.test/data", secretName: "api-key" };
  const bounded = await startStack({
    mode: "permissive",
    approver: { ...DEFAULT_APPROVER_POLICY, gusApprovesOwn: true, scope: "bounded" },
  });
  try {
    const jobId = bounded.makeJob("fetch with a credential");
    // The park proceeds under the mode (this stack wires no egress
    // gate, so execution then refuses plainly) — what matters is
    // that no approver was consulted about it.
    await bounded.toolCall(jobId, "fetch", "read", fetchArgs);
    assert.equal(bounded.providerCalls.length, 0, "bounded scope never asks about a credential fetch");
    assert.equal(bounded.approvals.agentApprovalCountSince(0), 0);
  } finally {
    await bounded.close();
  }

  const wide = await startStack({
    mode: "permissive",
    approver: { ...DEFAULT_APPROVER_POLICY, gusApprovesOwn: true, scope: "all_except_floors" },
  });
  try {
    const jobId = wide.makeJob("fetch with a credential");
    // GUS approves the park; execution then refuses plainly because
    // this stack wires no egress gate — the approval still happened.
    await wide.toolCall(jobId, "fetch", "read", fetchArgs);
    assert.equal(wide.providerCalls.length, 1, "the wide scope routes the park to GUS");
    assert.equal(wide.approvals.agentApprovalCountSince(0), 1);
  } finally {
    await wide.close();
  }
});

test("comm: delegate origin needs the delegates checkbox — the own checkbox does not cover it", async () => {
  const covered = await startStack({
    mode: "permissive",
    approver: { ...DEFAULT_APPROVER_POLICY, gusApprovesDelegates: true },
  });
  try {
    const jobId = covered.makeJob("[from Nova] write outside please");
    assert.equal(covered.jobs.get(jobId)?.origin, "Nova", "the origin is read off the job record");
    const res = (await covered.toolCall(jobId, "workspace_write", "write", ESCAPE_WRITE)) as ToolResult;
    assert.equal(res.status, "authorized");
    assert.equal(covered.providerCalls.length, 1);
    assert.equal(covered.approvals.agentApprovalCountSince(0), 1);
  } finally {
    await covered.close();
  }

  const uncovered = await startStack({
    mode: "permissive",
    approver: { ...DEFAULT_APPROVER_POLICY, gusApprovesOwn: true },
  });
  try {
    const jobId = uncovered.makeJob("[from Nova] write outside please");
    const res = (await uncovered.toolCall(jobId, "workspace_write", "write", ESCAPE_WRITE)) as ToolResult;
    assert.equal(res.status, "authorized", "permissive still proceeds");
    assert.equal(uncovered.providerCalls.length, 0, "but no approver was consulted");
    assert.equal(uncovered.approvals.agentApprovalCountSince(0), 0);
  } finally {
    await uncovered.close();
  }
});

test("comm: a Mac input park routes to GUS and executes through the Mac gate", async () => {
  const s = await startStack({
    mode: "permissive",
    approver: { ...DEFAULT_APPROVER_POLICY, gusApprovesOwn: true },
    macGate: true,
  });
  try {
    const jobId = s.makeJob("click the thing");
    const res = (await s.toolCall(jobId, "mac.click", "write", { element: "OK button" })) as ToolResult;
    assert.equal(res.status, "authorized");
    assert.equal(s.providerCalls.length, 1);
    assert.equal(s.approvals.agentApprovalCountSince(0), 1);
  } finally {
    await s.close();
  }
});

test("comm: the hourly budget turns a delegable park into an operator park", async () => {
  const s = await startStack({
    mode: "permissive",
    approver: { ...DEFAULT_APPROVER_POLICY, gusApprovesOwn: true, maxApprovalsPerHour: 1 },
  });
  try {
    // Spend the one agent approval on a first job.
    const first = s.makeJob("first write");
    const r1 = (await s.toolCall(first, "workspace_write", "write", ESCAPE_WRITE)) as ToolResult;
    assert.equal(r1.status, "authorized");
    assert.equal(s.approvals.agentApprovalCountSince(0), 1);
    // The second job's identical park now goes to the operator.
    const second = s.makeJob("second write");
    const r2 = (await s.toolCall(second, "workspace_write", "write", ESCAPE_WRITE)) as ToolResult;
    assert.equal(r2.status, "needs_approval", "budget spent → park, not proceed");
    const pending = s.approvals.pendingForJob(second);
    assert.ok(pending);
    assert.match(pending.reason, /rate limit reached/);
    assert.equal(pending.delegation, undefined, "an operator park is not delegate-resolvable");
    assert.equal(s.providerCalls.length, 1, "no second decision call");
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------- channel-host delegate path

const GROUP = "-100999";
const OPERATOR = "111";
const NOVA = "222";
const REX = "333";

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

const tick = () => new Promise((r) => setTimeout(r, 30));

interface HostStack {
  dir: string;
  jobs: JobRunner;
  approvals: ApprovalEngine;
  adapter: RecordingAdapter;
  executed: string[];
  say(senderId: string, text: string): void;
  press(senderId: string, buttonId: string): void;
  parkFor(originInput: string, delegation?: { scopeClass: "bounded"; originDelegate?: string }): string;
}

async function startHost(opts: { mode: "enforcing" | "permissive"; approver?: ApproverPolicy }): Promise<HostStack> {
  const dir = tempDir("gus-appr-host-");
  writeFileSync(
    join(dir, "delegates.json"),
    JSON.stringify({
      conversations: {
        [GROUP]: {
          operatorId: OPERATOR,
          delegates: [
            { senderId: NOVA, name: "Nova" },
            { senderId: REX, name: "Rex" },
          ],
        },
      },
    }),
  );
  if (opts.mode === "permissive") writeGovernorMode(dir, "permissive", "test");
  if (opts.approver) writeApproverPolicy(dir, opts.approver, "test");
  const governor = new Governor(dir, { maxTokensPerJob: 100, maxTokensPerDay: 10_000 });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const approvals = new ApprovalEngine(dir, () => 10 * 60 * 1000);
  const adapter = new RecordingAdapter();
  const host = new ChannelHost(dir, governor, jobs, [adapter], approvals);
  const executed: string[] = [];
  host.attachComm({
    pushUserMessage: () => {},
    broadcast: () => {},
    executeApproval: async (req: { id: string }) => {
      approvals.consume(req.id);
      executed.push(req.id);
    },
  } as never);
  await host.start();
  return {
    dir,
    jobs,
    approvals,
    adapter,
    executed,
    say: (senderId, text) =>
      adapter.handler?.({
        type: "message",
        message: { conversationId: GROUP, messageId: "m", senderId, text, receivedAt: Date.now() },
      }),
    press: (senderId, buttonId) =>
      adapter.handler?.({
        type: "button",
        press: { conversationId: GROUP, senderId, buttonId, callbackId: "cb" },
      }),
    parkFor: (originInput, delegation) => {
      const job = jobs.create("chat", GROUP, originInput);
      jobs.transition(job.id, "running");
      jobs.transition(job.id, "needs-approval", "parked for the test");
      const req = approvals.create({
        jobId: job.id,
        conversationId: GROUP,
        tool: "mac.click",
        args: { element: "OK button" },
        reason: "input injection parks",
        delegation,
      });
      return req.id;
    },
  };
}

test("host: a delegate resolves a routed park on a job it did not submit — stamped as its own", async () => {
  const h = await startHost({
    mode: "permissive",
    approver: { ...DEFAULT_APPROVER_POLICY, delegatesMayApprove: true },
  });
  const id = h.parkFor("operator job", { scopeClass: "bounded" });
  h.say(NOVA, `/approve ${id}`);
  await tick();
  const rec = h.approvals.get(id);
  assert.equal(rec?.status, "consumed", "resolved then executed (consumed by the comm stub)");
  assert.equal(rec?.resolvedBy, "delegate:Nova");
  assert.ok(rec?.agentResolution, "the agent stamp is on the record");
  assert.equal(rec?.agentResolution?.policy.delegatesMayApprove, true);
  assert.deepEqual(h.executed, [id]);
});

test("host: a delegate pressing the button resolves another delegate's job park", async () => {
  const h = await startHost({
    mode: "permissive",
    approver: { ...DEFAULT_APPROVER_POLICY, delegatesMayApprove: true },
  });
  const id = h.parkFor("[from Nova] click for me", { scopeClass: "bounded", originDelegate: "Nova" });
  h.press(REX, `approve:${id}`);
  await tick();
  assert.equal(h.approvals.get(id)?.resolvedBy, "delegate:Rex");
  assert.deepEqual(h.executed, [id]);
});

test("host: a delegate can NEVER resolve a park on its own job", async () => {
  const h = await startHost({
    mode: "permissive",
    approver: { ...DEFAULT_APPROVER_POLICY, delegatesMayApprove: true },
  });
  const id = h.parkFor("[from Nova] click for me", { scopeClass: "bounded", originDelegate: "Nova" });
  h.say(NOVA, `/approve ${id}`);
  await tick();
  assert.equal(h.approvals.get(id)?.status, "pending", "the park stands");
  assert.deepEqual(h.executed, []);
  assert.ok(
    h.adapter.sent.some((m) => m.text.includes("stays with the operator")),
    "the refusal names the reason",
  );
});

test("host: in enforcing the delegation policy is inert — a delegate's /approve is operator-only", async () => {
  const h = await startHost({
    mode: "enforcing",
    approver: { ...DEFAULT_APPROVER_POLICY, delegatesMayApprove: true },
  });
  const id = h.parkFor("operator job", { scopeClass: "bounded" });
  h.say(NOVA, `/approve ${id}`);
  await tick();
  assert.equal(h.approvals.get(id)?.status, "pending");
  assert.deepEqual(h.executed, []);
  assert.ok(h.adapter.sent.some((m) => m.text.includes("operator-only")));
});

test("host: an unrouted park stays the operator's even with delegatesMayApprove on", async () => {
  const h = await startHost({
    mode: "permissive",
    approver: { ...DEFAULT_APPROVER_POLICY, delegatesMayApprove: true },
  });
  const id = h.parkFor("operator job", undefined);
  h.say(NOVA, `/approve ${id}`);
  await tick();
  assert.equal(h.approvals.get(id)?.status, "pending");
  assert.deepEqual(h.executed, []);
});

// ---------------------------------------------------------- panel surface

test("panel: the delegation card and its endpoint are wired into the page", () => {
  assert.ok(PANEL_HTML.includes("Approval delegation"));
  assert.ok(PANEL_HTML.includes('id="del-gus-delegates"'));
  assert.ok(PANEL_HTML.includes('id="del-gus-own"'));
  assert.ok(PANEL_HTML.includes('id="del-delegates"'));
  assert.ok(PANEL_HTML.includes("/api/approver-policy"));
  assert.ok(PANEL_HTML.includes("delegation-fields"), "the card greys out outside permissive");
});
