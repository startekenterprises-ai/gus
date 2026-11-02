/**
 * Agent runtime — the ONLY thing that runs inside the sandbox.
 *
 * It holds: the conversation turn loop, the fixed tool executors, and a
 * comm client. It holds NO provider keys, NO channel credentials, NO
 * control-plane state, and it has no network: its one socket leads to the
 * control plane, which meters, authorizes, verifies, and settles.
 *
 * Turn algorithm (per job):
 *   user_message -> model_request -> [tool_call authorize -> execute ->
 *   tool_report -> model_request(TOOL_RESULT ...)] -> job_final.
 * The control plane egress-screens job_final, verifies it, settles the
 * job, and delivers it to the channel. A `kill` control message aborts
 * the in-flight turn between steps.
 */
import { createConnection, type Socket } from "node:net";
import type { ControlMessage, RuntimeRequest } from "@gus/shared";
import { Workspace, executeTool } from "./tools.js";

const SOCKET = process.env.GUS_COMM_SOCKET ?? "/comm/gus.sock";
const WORKSPACE = process.env.GUS_WORKSPACE ?? "/workspace";

const ws = new Workspace(WORKSPACE);

let sock: Socket;
let buf = "";
let seq = 0;
const waiters = new Map<string, (m: ControlMessage) => void>();
let killed = false;
let currentTurn: { jobId: string; signal: { aborted: boolean } } | null = null;

function send(req: RuntimeRequest): void {
  sock.write(JSON.stringify(req) + "\n");
}

function request<T extends ControlMessage>(req: RuntimeRequest, match: (m: ControlMessage) => boolean): Promise<T> {
  return new Promise((resolvePromise) => {
    const key = `w${++seq}`;
    waiters.set(key, (m) => {
      if (match(m)) {
        waiters.delete(key);
        resolvePromise(m as T);
      }
    });
    send(req);
  });
}

async function runTurn(jobId: string, text: string): Promise<void> {
  const signal = { aborted: killed };
  currentTurn = { jobId, signal };
  try {
    let prompt = text;
    for (let hop = 0; hop < 6; hop++) {
      if (signal.aborted) {
        send({ t: "job_update", jobId, note: "aborted:killed" });
        return;
      }
      const res = await request<Extract<ControlMessage, { t: "model_response" }>>(
        { t: "model_request", reqId: `mr${++seq}`, jobId, workClass: "primary", prompt },
        (m) => m.t === "model_response",
      );
      if (!res.ok) {
        send({ t: "job_update", jobId, note: `model refused: ${res.reason ?? "error"} ${res.detail ?? ""}` });
        send({ t: "job_final", jobId, text: `I couldn't complete that: ${res.reason === "killed" ? "the kill switch is on" : res.detail ?? "provider error"}` });
        return;
      }
      if (res.toolCall) {
        const tc = res.toolCall;
        const auth = await request<Extract<ControlMessage, { t: "tool_result" }>>(
          { t: "tool_call", reqId: `tc${++seq}`, jobId, tool: tc.tool, declaredClass: tc.declaredClass, args: tc.args },
          (m) => m.t === "tool_result",
        );
        if (auth.status !== "authorized") {
          send({ t: "job_update", jobId, note: `parked:${auth.status}` });
          return; // job is parked in needs-approval by the control plane
        }
        const outcome = await executeTool(ws, tc.tool, tc.args, signal, () =>
          send({ t: "heartbeat", jobId }),
        );
        send({ t: "tool_report", reqId: `tr${++seq}`, jobId, ok: outcome.ok, summary: outcome.summary });
        if (signal.aborted) {
          send({ t: "job_update", jobId, note: "aborted:killed" });
          return;
        }
        prompt = `TOOL_RESULT ${tc.tool}: ${outcome.summary}`;
        continue;
      }
      if (res.text !== undefined) {
        send({ t: "job_final", jobId, text: res.text });
        return;
      }
    }
    send({ t: "job_update", jobId, note: "turn hop limit reached" });
  } finally {
    if (currentTurn?.jobId === jobId) currentTurn = null;
  }
}

function onMessage(m: ControlMessage): void {
  for (const w of [...waiters.values()]) w(m);
  switch (m.t) {
    case "welcome":
      killed = m.killed;
      break;
    case "user_message":
      void runTurn(m.jobId, m.text);
      break;
    case "kill":
      killed = true;
      if (currentTurn) currentTurn.signal.aborted = true;
      break;
    case "resume":
      killed = false;
      break;
    case "verify": {
      // Post-condition checks run through the FIXED tool code — the model
      // is not in this path and cannot influence the answer.
      try {
        if (m.check.tool === "workspace_read") {
          const digest = ws.digest(String(m.check.args.path));
          send({ t: "verify_result", reqId: m.reqId, ok: true, digest });
        } else {
          send({ t: "verify_result", reqId: m.reqId, ok: false, note: `no checker for ${m.check.tool}` });
        }
      } catch (e) {
        send({ t: "verify_result", reqId: m.reqId, ok: false, note: String(e) });
      }
      break;
    }
  }
}

function connect(): void {
  sock = createConnection(SOCKET, () => {
    send({ t: "hello", runtimeVersion: "0.0.1" });
  });
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) onMessage(JSON.parse(line) as ControlMessage);
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => setTimeout(connect, 500));
}

connect();
console.log("gus runtime up (sandbox)");
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
