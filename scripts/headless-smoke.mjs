#!/usr/bin/env node
/**
 * Headless smoke — the portability gate (redo build spec §2.3,
 * v0.13.0 R1).
 *
 *     npm run build && node scripts/headless-smoke.mjs
 *
 * This script boots the GUS core from the BUILT dist trees
 * (each package's own dist directory) on a plain Node process — no Mac host, no
 * desktop, no network, no provider key — and settles one text job
 * end-to-end with a receipt: Governor, JobRunner, PolicyStore,
 * ApprovalEngine, the context pack, and a CommServer on a unix
 * socket, driven by a raw socket client through hello →
 * model_request → model_response, then settled verified-done the
 * way the host settles it.
 *
 * Why it exists: the redo's groundwork promise is that the core is
 * portable — the same code must run on the operator's Mac, on a
 * Linux box, in a container, later in the cloud. If the core ever
 * gains a Mac-only assumption in the boot path (a host adapter
 * constructed eagerly, a desktop path read at startup, a
 * platform-specific module imported at load), THIS goes red,
 * before any of that reaches a release. It is a gate, not a demo:
 * exit 0 is the only success, and a failure names the step that
 * failed.
 *
 * Two wiring choices worth naming, both mirroring the context-pack
 * test rig (test/unit/context-pack.test.ts):
 *  - The Shield gate is a fake seam (allow, receipt
 *    "rcpt_smoke_1") — the gate's own behaviour is covered by its
 *    suites; what is proven HERE is that the pack assembly and the
 *    comm path run headless with a gate wired in.
 *  - No providerFactory is passed to the CommServer, so its model
 *    path defaults to the deterministic stub (comm-server.ts: no
 *    factory, or a stub provider, takes the stubCompletion path) —
 *    the smoke spends nothing and needs no key, by construction.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { Governor } from "../packages/control-plane/dist/governor.js";
import { JobRunner } from "../packages/control-plane/dist/jobs.js";
import { PolicyStore, DEFAULT_POLICY } from "../packages/control-plane/dist/policy.js";
import { ApprovalEngine } from "../packages/control-plane/dist/approvals.js";
import { CommServer } from "../packages/control-plane/dist/comm-server.js";
import {
  ContextAssembler,
  ContextPackStore,
} from "../packages/control-plane/dist/context-pack.js";
import { LocalReceiptIssuer } from "../packages/gate/dist/index.js";

let step = "boot";

function fail(message) {
  console.error(`FAIL headless smoke at step "${step}": ${message}`);
  process.exit(1);
}

async function main() {
  step = "state dir + policy";
  const dir = mkdtempSync(join(tmpdir(), "gus-headless-smoke-"));
  writeFileSync(
    join(dir, "policy.json"),
    JSON.stringify({ ...DEFAULT_POLICY, mac: { workDirs: ["/work"], shellAllowlist: [] } }),
  );

  step = "construct the core";
  const governor = new Governor(dir, {
    maxTokensPerJob: 1_000_000,
    maxTokensPerDay: 10_000_000,
    defaultPriceUsdPer1k: 0.01,
  });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const approvals = new ApprovalEngine(dir, () => 10 * 60 * 1000);
  const policy = new PolicyStore(join(dir, "policy.json"));
  const store = new ContextPackStore(dir);
  store.ensureSeeded();
  const gate = {
    scanSurface: async (_surface, _jobId, _content) => ({
      action: "allow",
      scanned: true,
      verdict: "clean",
      receipt: { receiptId: "rcpt_smoke_1" },
      detail: "smoke gate allow",
    }),
  };
  const assembler = new ContextAssembler(store, gate);
  const hooks = {
    onRuntimeHello: () => {},
    onModelIssued: () => {},
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

  step = "start the comm server";
  const socketPath = join(dir, "gus.sock");
  // Positional, per comm-server.ts: socketPath, governor, jobs,
  // hooks, policy, approvals, fetchGate, shieldGate,
  // providerFactory (ABSENT — the stub path, see the header),
  // gmailGate, macGate, modeFn, approverFn, githubGate,
  // contextPack.
  const comm = new CommServer(
    socketPath,
    governor,
    jobs,
    hooks,
    policy,
    approvals,
    undefined,
    gate,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    assembler,
  );
  await comm.start();

  let sock;
  try {
    step = "connect + hello";
    sock = createConnection(socketPath);
    await new Promise((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    });
    const received = [];
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) received.push(JSON.parse(line));
      }
    });
    const waitFor = async (pred, what) => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const hit = received.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    sock.write(JSON.stringify({ t: "hello", runtimeVersion: "headless-smoke" }) + "\n");
    const welcome = await waitFor((m) => m.t === "welcome", "the comm welcome");
    if (!welcome) throw new Error("no welcome from the comm server");

    step = "create the job";
    const job = jobs.create("chat", "headless-smoke", "smoke: say hello");
    jobs.transition(job.id, "running");

    step = "model_request over the socket";
    const reqId = "smoke_mr_1";
    sock.write(
      JSON.stringify({
        t: "model_request",
        reqId,
        jobId: job.id,
        workClass: "primary",
        prompt: "smoke: say hello",
      }) + "\n",
    );
    const res = await waitFor(
      (m) => m.t === "model_response" && m.reqId === reqId,
      "the model_response",
    );
    if (res.ok !== true) {
      throw new Error(
        `model_response was not ok (reason: ${res.reason ?? "?"}, detail: ${res.detail ?? "?"})`,
      );
    }

    step = "settle verified-done";
    const settled = jobs.transition(job.id, "verified-done", "headless smoke");
    if (!settled.receiptId) throw new Error("the settled job carries no receipt id");

    step = "verify the receipt on disk";
    const receipts = readFileSync(join(dir, "receipts.jsonl"), "utf8");
    if (!receipts.includes(settled.receiptId)) {
      throw new Error(`receipts.jsonl does not contain ${settled.receiptId}`);
    }

    step = "verify the context pack ran";
    const record = jobs.get(job.id);
    if (!record?.contextManifest) {
      throw new Error("the job carries no context manifest — the pack path did not run headless");
    }

    console.log(
      `PASS headless smoke — job ${job.id} verified-done, receipt ${settled.receiptId}, context pack profile ${record.contextManifest.profile}`,
    );
  } finally {
    try {
      sock?.destroy();
    } catch {
      /* the socket is a smoke client; teardown noise is not a result */
    }
    await comm.close();
    approvals.stop();
  }
}

main().then(
  () => process.exit(0),
  (e) => fail(e instanceof Error ? e.message : String(e)),
);
