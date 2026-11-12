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
import { GUS_VERSION } from "@gus/shared";
import { Workspace, executeTool } from "./tools.js";
import { TurnQueue } from "./turn-queue.js";
import { VoiceLane } from "./voice-lane.js";

/** v0.3.4: turns are serialized — the loop's waiters match by
 *  message type and `currentTurn` is a singleton, so two turns in
 *  flight cross-deliver model output (field: 2026-11-05, one job
 *  failed its post-condition with the other job's text). */
const turns = new TurnQueue();

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

/**
 * Turn hop ceiling. Raised from the Phase 0 value of 6 in Phase 2 —
 * deliberately: a hop counter is NOT the spend brake. The Governor's
 * caps (control plane, outside this sandbox) are the brake, and the
 * runaway drill proves a loop dies at the cap, not at an arbitrary
 * iteration count. The ceiling remains only as a liveness backstop.
 */
const MAX_HOPS = 1000;

async function runTurn(jobId: string, text: string, voiceFastLane = false): Promise<void> {
  const signal = { aborted: killed };
  currentTurn = { jobId, signal };
  try {
    await driveLoop(jobId, text, signal, new VoiceLane(voiceFastLane));
  } finally {
    if (currentTurn?.jobId === jobId) currentTurn = null;
  }
}

/** The turn loop proper: model -> authorize -> execute -> report ->
 *  model(TOOL_RESULT ...) -> ... -> job_final. Shared by fresh turns
 *  and by continuations after an approved execution (Phase 2) —
 *  those enter with no lane (an approved execution is deliberate
 *  work, never a spoken quick answer). */
async function driveLoop(
  jobId: string,
  initialPrompt: string,
  signal: { aborted: boolean },
  lane: VoiceLane = new VoiceLane(false),
): Promise<void> {
    let prompt = initialPrompt;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
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
        if (auth.status === "denied") {
          // The control plane has already settled this job failed-loudly
          // and notified the operator; the job_final below is a formality
          // the host will ignore (job already settled). The denial is the
          // outcome — nothing executed, nothing parked.
          send({
            t: "job_final",
            jobId,
            text: `Denied by the control plane: ${auth.note ?? "the action was refused"}`,
          });
          return;
        }
        if (auth.status !== "authorized") {
          send({ t: "job_update", jobId, note: `parked:${auth.status}` });
          return; // job is parked in needs-approval by the control plane
        }
        // If the control plane executed the tool itself (Phase 1: fetch
        // runs in the egress proxy — this sandbox has no network), the
        // outcome arrives with the authorization. Otherwise execute the
        // fixed local tool code.
        let outcome;
        if (auth.result) {
          outcome = auth.result;
        } else {
          try {
            outcome = await executeTool(ws, tc.tool, tc.args, signal, () =>
              send({ t: "heartbeat", jobId }),
            );
          } catch (e) {
            outcome = {
              ok: false,
              summary: `tool error: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
        }
        send({ t: "tool_report", reqId: `tr${++seq}`, jobId, ok: outcome.ok, summary: outcome.summary });
        if (signal.aborted) {
          send({ t: "job_update", jobId, note: "aborted:killed" });
          return;
        }
        // The model is stateless across hops (each model_request is a
        // fresh call), so the continuation carries the operator's
        // original request after the TOOL_RESULT line — a real model
        // deciding "what next" needs to know what it is in the middle
        // of doing. The TOOL_RESULT prefix stays first: the stub's
        // pattern matching keys on it. v0.9.8: a voice fast-lane job's
        // first continuation additionally carries the final-call note
        // (voice-lane.ts) — the steering that keeps a spoken reply to
        // two model calls without ever stranding a tool-using turn.
        prompt = lane.continuationPrompt(
          `TOOL_RESULT ${tc.tool}: ${outcome.summary}\n(The operator's original request was: "${initialPrompt}". Continue it, or reply with plain text to finish.)`,
        );
        continue;
      }
      if (res.text !== undefined) {
        send({ t: "job_final", jobId, text: res.text });
        return;
      }
    }
    send({ t: "job_update", jobId, note: "turn hop limit reached" });
}

function onMessage(m: ControlMessage): void {
  for (const w of [...waiters.values()]) w(m);
  switch (m.t) {
    case "welcome":
      killed = m.killed;
      break;
    case "user_message":
      turns.enqueue(() => runTurn(m.jobId, m.text, m.voiceFastLane === true));
      break;
    case "approved_execution": {
      // Phase 2: the operator approved this exact action on the channel
      // and the control plane consumed the approval before sending
      // this. Execute the STORED arguments (or take the control plane's
      // own outcome for proxy-executed tools), report, and continue the
      // job's turn from the tool result so the job can settle through
      // the normal verification path. The runtime can receive this
      // message; it has no way to send anything resembling it.
      turns.enqueue(async () => {
        const signal = { aborted: killed };
        currentTurn = { jobId: m.jobId, signal };
        try {
          let outcome: { ok: boolean; summary: string };
          if (m.result) {
            outcome = m.result;
          } else {
            try {
              outcome = await executeTool(ws, m.tool, m.args, signal, () =>
                send({ t: "heartbeat", jobId: m.jobId }),
              );
            } catch (e) {
              outcome = {
                ok: false,
                summary: `tool error: ${e instanceof Error ? e.message : String(e)}`,
              };
            }
          }
          send({ t: "tool_report", reqId: `tr${++seq}`, jobId: m.jobId, ok: outcome.ok, summary: outcome.summary });
          if (signal.aborted) {
            send({ t: "job_update", jobId: m.jobId, note: "aborted:killed" });
            return;
          }
          await driveLoop(m.jobId, `TOOL_RESULT ${m.tool}: ${outcome.summary}`, signal);
        } finally {
          if (currentTurn?.jobId === m.jobId) currentTurn = null;
        }
      });
      break;
    }
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
        } else if (m.check.tool === "workspace_absent") {
          // Deletion post-condition: every approved path must be gone.
          const paths = Array.isArray(m.check.args.paths) ? m.check.args.paths.map(String) : [];
          const absent = paths.every((p) => !ws.exists(p));
          send({ t: "verify_result", reqId: m.reqId, ok: absent, note: absent ? "all absent" : "some present" });
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
    send({ t: "hello", runtimeVersion: GUS_VERSION });
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
