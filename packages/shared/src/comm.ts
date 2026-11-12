/**
 * The sandbox <-> control-plane wire protocol (NDJSON over a unix socket on
 * a shared volume — the ONLY bridge between the two worlds; the sandbox has
 * no network at all).
 *
 * Load-bearing direction rules:
 * - Channels terminate in the CONTROL PLANE. The runtime only ever sees
 *   `user_message` deliveries the control plane created as jobs, after
 *   secret-guard ingress screening.
 * - Model completions are issued by the Governor (control plane): caps,
 *   routing, and the kill switch live there. The runtime holds no provider
 *   keys and has no direct model path.
 * - Tool calls are authorized by the control plane BEFORE execution
 *   (scan-before-act). Destructive classes park the job in needs-approval.
 * - Job settlement is the control plane's, and verified-done requires a
 *   post-condition check the control plane initiates (a `verify` round
 *   trip executed by the runtime's fixed tool code, or a hash comparison
 *   against output the Governor itself produced) — never the model's
 *   self-report.
 */

export type ToolClass = "read" | "write" | "destructive" | "external-send" | "pay";

export type RuntimeRequest =
  | { t: "hello"; runtimeVersion: string }
  | {
      t: "model_request";
      reqId: string;
      jobId: string;
      /** Class of work, for Governor routing ("primary" | "cheap"). */
      workClass: "primary" | "cheap";
      prompt: string;
    }
  | {
      /** Authorization request — sent BEFORE the tool executes. */
      t: "tool_call";
      reqId: string;
      jobId: string;
      tool: string;
      /** Declared class from the tool definition; the control plane
       *  re-classifies from arguments before believing it (Phase 2). */
      declaredClass: ToolClass;
      args: Record<string, unknown>;
    }
  | {
      /** Post-execution report for an authorized tool call. */
      t: "tool_report";
      reqId: string;
      jobId: string;
      ok: boolean;
      /** Screened-by-control-plane-on-arrival summary. */
      summary: string;
    }
  | {
      /** The runtime's proposed final answer for a job. The control plane
       *  egress-screens it, verifies, settles the job, and only then puts
       *  it on the channel. */
      t: "job_final";
      jobId: string;
      text: string;
    }
  | { t: "job_update"; jobId: string; note: string }
  | {
      /** Answer to a control-plane `verify` request, produced by the
       *  runtime's fixed checker code (not by the model). */
      t: "verify_result";
      reqId: string;
      ok: boolean;
      digest?: string;
      note?: string;
    }
  | { t: "log"; level: "info" | "warn" | "error"; text: string }
  | { t: "heartbeat"; jobId?: string };

export type ControlMessage =
  | { t: "welcome"; controlVersion: string; killed: boolean }
  | {
      /** A new operator message, as a job, after ingress screening. */
      t: "user_message";
      jobId: string;
      kind: string;
      text: string;
      /** v0.9.8: the job is a live voice call's spoken chat turn —
       *  the runtime runs it in the voice fast lane (see
       *  runtime/src/voice-lane.ts). Set only from the job
       *  record's own flag, never from message content. */
      voiceFastLane?: boolean;
    }
  | {
      t: "model_response";
      reqId: string;
      ok: boolean;
      text?: string;
      /** Provider directive: the model wants this tool executed (runtime
       *  must still obtain tool_call authorization). */
      toolCall?: { tool: string; declaredClass: ToolClass; args: Record<string, unknown> };
      /** Refusal reason when !ok. */
      reason?: "killed" | "cap_exceeded" | "provider_error";
      detail?: string;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
    }
  | {
      t: "tool_result";
      reqId: string;
      /** "authorized" | "needs_approval" | "denied" | "killed" */
      status: string;
      note?: string;
      /** Phase 1: when the CONTROL PLANE executed the tool itself (the
       *  fetch tool runs in the egress proxy — the sandbox has no network
       *  to execute it with), the outcome travels with the authorization.
       *  The runtime uses it verbatim and never executes locally. */
      result?: { ok: boolean; summary: string };
    }
  | {
      /** Post-condition check, executed by the runtime's checker code. */
      t: "verify";
      reqId: string;
      jobId: string;
      check: { tool: string; args: Record<string, unknown> };
    }
  | {
      /** Phase 2: execute a tool call the operator approved on the
       *  channel. Carries the EXACT approved arguments from the Approval
       *  Engine's durable record — never anything the runtime composed.
       *  The approval itself was consumed by the control plane before
       *  this message was sent (single-use). When the control plane
       *  executed the tool itself (fetch runs in the egress proxy), the
       *  outcome travels in `result` and the runtime executes nothing.
       *  Note the asymmetry, by design: there is NO runtime->control
       *  message that requests, extends, or resolves an approval. The
       *  sandbox can be parked; it can never unpark itself. */
      t: "approved_execution";
      jobId: string;
      tool: string;
      args: Record<string, unknown>;
      result?: { ok: boolean; summary: string };
    }
  | { t: "kill" }
  | { t: "resume" };
