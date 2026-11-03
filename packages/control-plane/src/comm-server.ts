/**
 * Comm server — the control plane's end of the sandbox bridge.
 *
 * Listens on a unix socket inside the shared comm volume. The socket is
 * the ONLY way into the control plane from the sandbox, and it exposes
 * requests, not state: the runtime cannot read the ledger, the policy
 * store, the vault, or the kill flag — it can only ask for model calls
 * (Governor-gated), tool authorizations (class-gated), and verifications.
 */
import { createServer, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type { ControlMessage, RuntimeRequest } from "@gus/shared";
import { screenText } from "@gus/shared";
import type { Governor } from "./governor.js";
import type { JobRunner } from "./jobs.js";
import type { PolicyStore } from "./policy.js";
import type { ApprovalEngine, ApprovalRequest } from "./approvals.js";
import { estimateTokens, fakeComplete, FAKE_MODEL_NAME } from "./provider.js";

export interface HostHooks {
  onRuntimeHello(): void;
  onModelIssued(jobId: string, text: string | undefined): void;
  noteAuthorizedWrite(jobId: string, path: string, content: string): void;
  /** Phase 2: an approval was created and the job parked — the host
   *  presents the request (with buttons) on the channel. */
  onApprovalRequested(req: ApprovalRequest): void;
  /** Phase 2: an approved action is about to execute — the host records
   *  the post-condition check to verify once the job finalizes. */
  noteApprovedExecution(jobId: string, tool: string, args: Record<string, unknown>): void;
  onDenied(jobId: string, tool: string, note: string): void;
  /** Phase 2: the Governor refused a model call at a spend cap and the
   *  job was settled failed-loudly — the host notifies the operator. */
  onCapExceeded(jobId: string, detail: string): void;
  onJobUpdate(jobId: string, note: string): void;
  onJobFinal(jobId: string, text: string): Promise<void>;
  logRuntime(level: string, text: string): void;
}

/**
 * The egress gate the comm server delegates `fetch` tool calls to
 * (Phase 1). Structurally the @gus/egress EgressProxy; declared here so
 * the comm layer depends on the contract, not the package. The runtime
 * never sees this interface — it only receives the outcome.
 */
export interface FetchGate {
  fetch(
    req: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      secretName?: string;
    },
    ctx: { jobId: string },
  ): Promise<{
    ok: boolean;
    verdict: string;
    status?: number;
    body?: string;
    note?: string;
  }>;
}

/** Shape runtime fetch args into the FetchGate's request form. */
function fetchArgsFrom(args: Record<string, unknown>): {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  secretName?: string;
} {
  return {
    url: String(args.url ?? ""),
    method: typeof args.method === "string" ? args.method : undefined,
    headers:
      args.headers && typeof args.headers === "object"
        ? (args.headers as Record<string, string>)
        : undefined,
    body: typeof args.body === "string" ? args.body : undefined,
    secretName: typeof args.secretName === "string" ? args.secretName : undefined,
  };
}

function fetchSummary(
  args: Record<string, unknown>,
  r: { status?: number; body?: string; note?: string },
): string {
  return (
    `fetch ${String(args.url ?? "")} -> HTTP ${r.status ?? "?"}; ` +
    `body: ${(r.body ?? "").slice(0, 500)}` +
    (r.note ? `; notes: ${r.note}` : "")
  );
}

export class CommServer {
  private conn: Socket | null = null;
  private verifyWaiters = new Map<string, (v: { ok: boolean; digest?: string }) => void>();
  private seq = 0;

  constructor(
    private socketPath: string,
    private governor: Governor,
    private jobs: JobRunner,
    private hooks: HostHooks,
    private policy: PolicyStore,
    private approvals: ApprovalEngine,
    private fetchGate?: FetchGate,
  ) {}

  async start(): Promise<void> {
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    const server = createServer((sock) => this.onConnection(sock));
    await new Promise<void>((resolve) => server.listen(this.socketPath, resolve));
    // The sandbox runs under a different uid namespace; the socket file
    // must be connectable across it. The comm volume is private to the
    // two containers, so 0777 on the socket is the intended posture.
    chmodSync(this.socketPath, 0o777);
  }

  private onConnection(sock: Socket): void {
    this.conn = sock;
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) void this.onRequest(JSON.parse(line) as RuntimeRequest);
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      if (this.conn === sock) this.conn = null;
    });
  }

  send(msg: ControlMessage): void {
    this.conn?.write(JSON.stringify(msg) + "\n");
  }

  broadcast(msg: ControlMessage): void {
    this.send(msg);
  }

  pushUserMessage(m: { jobId: string; kind: string; text: string }): void {
    this.send({ t: "user_message", jobId: m.jobId, kind: m.kind, text: m.text });
  }

  verify(jobId: string, check: { tool: string; args: Record<string, unknown> }): Promise<{ ok: boolean; digest?: string }> {
    const reqId = `verify_${++this.seq}`;
    return new Promise((resolve) => {
      this.verifyWaiters.set(reqId, resolve);
      this.send({ t: "verify", reqId, jobId, check });
      setTimeout(() => {
        if (this.verifyWaiters.delete(reqId)) resolve({ ok: false });
      }, 5000);
    });
  }

  /**
   * Execute an operator-approved action (Phase 2). Called ONLY by the
   * ChannelHost after a channel resolution. The approval is consumed
   * FIRST (single-use, even if execution then fails), the job un-parks,
   * and the EXACT stored arguments are sent to the runtime — or, for
   * fetch, executed here in the egress proxy with the outcome relayed.
   * There is deliberately no runtime-request path that reaches this
   * method.
   */
  async executeApproval(approval: ApprovalRequest): Promise<void> {
    this.approvals.consume(approval.id);
    try {
      this.jobs.transition(approval.jobId, "running");
    } catch {
      // The job is no longer parked (killed or settled in the race
      // window). The approval is burned — consumed above — and the
      // action does NOT execute. Fail closed, always.
      return;
    }
    this.hooks.noteApprovedExecution(approval.jobId, approval.tool, approval.args);
    if (approval.tool === "fetch") {
      if (!this.fetchGate) {
        const note = "egress proxy is not configured in this control plane";
        try {
          this.jobs.transition(approval.jobId, "failed-loudly", note);
        } catch { /* settled already */ }
        this.hooks.onDenied(approval.jobId, approval.tool, note);
        return;
      }
      const r = await this.fetchGate.fetch(fetchArgsFrom(approval.args), { jobId: approval.jobId });
      if (!r.ok) {
        const note = `egress ${r.verdict}: ${r.note ?? "request refused"}`;
        try {
          this.jobs.transition(approval.jobId, "failed-loudly", note);
        } catch { /* settled already */ }
        this.hooks.onDenied(approval.jobId, approval.tool, note);
        return;
      }
      this.send({
        t: "approved_execution",
        jobId: approval.jobId,
        tool: approval.tool,
        args: approval.args,
        result: { ok: true, summary: fetchSummary(approval.args, r) },
      });
      return;
    }
    this.send({
      t: "approved_execution",
      jobId: approval.jobId,
      tool: approval.tool,
      args: approval.args,
    });
  }

  private async onRequest(req: RuntimeRequest): Promise<void> {
    switch (req.t) {
      case "hello": {
        this.send({ t: "welcome", controlVersion: "0.0.1", killed: this.governor.isKilled() });
        this.hooks.onRuntimeHello();
        break;
      }
      case "model_request": {
        // The Phase 0 stub provider is deterministic, so the exact
        // tokens of the reply are computable BEFORE authorization —
        // the Governor's reservation therefore equals the settlement,
        // and cap math is exact (governor.ts). Real providers estimate
        // from prompt + output budget through the same interface.
        const reply = fakeComplete(req.prompt);
        const tokensIn = estimateTokens(req.prompt);
        const tokensOut = estimateTokens(reply.text ?? JSON.stringify(reply.toolCall ?? {}));
        const decision = this.governor.authorize(req.jobId, tokensIn, tokensOut, FAKE_MODEL_NAME);
        if (!decision.ok) {
          if (decision.reason === "cap_exceeded") {
            // The cap is a terminal, receipted outcome for this job —
            // never a silent stall. (Kill refusals are settled by the
            // channel host, which owns the kill action.)
            try {
              this.jobs.transition(req.jobId, "failed-loudly", `governor cap: ${decision.detail}`);
            } catch {
              /* already settled/parked — the refusal stands regardless */
            }
            this.hooks.onCapExceeded(req.jobId, decision.detail);
          }
          this.send({
            t: "model_response",
            reqId: req.reqId,
            ok: false,
            reason: decision.reason,
            detail: decision.detail,
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
          });
          break;
        }
        const costUsd = this.governor.settle(decision.reservationId, tokensIn, tokensOut);
        this.jobs.addUsage(req.jobId, tokensIn, tokensOut, costUsd);
        this.hooks.onModelIssued(req.jobId, reply.text);
        this.send({
          t: "model_response",
          reqId: req.reqId,
          ok: true,
          text: reply.text,
          toolCall: reply.toolCall,
          tokensIn,
          tokensOut,
          costUsd,
        });
        break;
      }
      case "tool_call": {
        // --- Phase 2: EVERY call is classified by the Approval Engine's
        // policy layer from tool + arguments (policy.ts). The runtime's
        // declaredClass is an input to the classifier, never the
        // decision: the control plane re-derives the class itself.
        const cls = this.policy.classify({
          tool: req.tool,
          declaredClass: req.declaredClass,
          args: req.args,
        });

        if (cls.action === "deny") {
          // Denial is a terminal, receipted outcome — never a silent
          // drop, never a park. (Phase 1's vault_read refusal lives
          // here now: it is the classifier's hard-deny entry.)
          if (req.tool === "vault_read") {
            this.hooks.logRuntime(
              "warn",
              `vault_read attempt refused for job ${req.jobId} (name: ${String(req.args.name ?? "?")})`,
            );
          }
          try {
            this.jobs.transition(req.jobId, "failed-loudly", `denied tool ${req.tool}: ${cls.reason}`);
          } catch {
            /* already settled/parked — refusal stands regardless */
          }
          this.hooks.onDenied(req.jobId, req.tool, cls.reason);
          this.send({ t: "tool_result", reqId: req.reqId, status: "denied", note: cls.reason });
          break;
        }

        if (cls.action === "needs-approval") {
          // Park: the approval record (with the exact screened
          // arguments + their hash) is created BEFORE the job parks;
          // the host presents it on the channel. The runtime's turn
          // ends here — it cannot wait on, poll, or influence the
          // resolution.
          const job = this.jobs.get(req.jobId);
          let approval: ApprovalRequest;
          try {
            approval = this.approvals.create({
              jobId: req.jobId,
              conversationId: job?.conversationId ?? "",
              tool: req.tool,
              args: req.args,
              reason: cls.reason,
            });
          } catch (e) {
            const note = `could not park for approval: ${e instanceof Error ? e.message : String(e)}`;
            this.send({ t: "tool_result", reqId: req.reqId, status: "denied", note });
            break;
          }
          try {
            this.jobs.transition(req.jobId, "needs-approval", `tool ${req.tool} requires approval: ${cls.reason}`);
          } catch {
            /* already parked/settled — the park stands regardless */
          }
          this.hooks.onApprovalRequested(approval);
          this.send({
            t: "tool_result",
            reqId: req.reqId,
            status: "needs_approval",
            note: `parked for approval ${approval.id}: nothing executed`,
          });
          break;
        }

        // --- allowed: fetch executes HERE, in the egress proxy (Phase
        // 1). The sandbox has no network; the proxy enforces allowlist,
        // outbound screening, and vault injection, and the screened
        // result rides back with the authorization.
        if (req.tool === "fetch") {
          if (!this.fetchGate) {
            const note = "egress proxy is not configured in this control plane";
            this.send({ t: "tool_result", reqId: req.reqId, status: "denied", note });
            break;
          }
          const r = await this.fetchGate.fetch(fetchArgsFrom(req.args), { jobId: req.jobId });
          if (!r.ok) {
            const note = `egress ${r.verdict}: ${r.note ?? "request refused"}`;
            try {
              this.jobs.transition(req.jobId, "failed-loudly", note);
            } catch {
              /* already settled/parked — refusal stands regardless */
            }
            this.hooks.onDenied(req.jobId, req.tool, note);
            this.send({ t: "tool_result", reqId: req.reqId, status: "denied", note });
            break;
          }
          this.send({
            t: "tool_result",
            reqId: req.reqId,
            status: "authorized",
            note: r.note,
            result: { ok: true, summary: fetchSummary(req.args, r) },
          });
          break;
        }
        if (req.tool === "workspace_write") {
          this.hooks.noteAuthorizedWrite(
            req.jobId,
            String(req.args.path ?? ""),
            String(req.args.content ?? ""),
          );
        }
        this.send({ t: "tool_result", reqId: req.reqId, status: "authorized" });
        break;
      }
      case "tool_report": {
        this.hooks.logRuntime("info", `tool_report ${req.reqId} ok=${req.ok} ${screenText(req.summary).redacted}`);
        break;
      }
      case "job_final": {
        await this.hooks.onJobFinal(req.jobId, req.text);
        break;
      }
      case "job_update": {
        this.hooks.onJobUpdate(req.jobId, req.note);
        break;
      }
      case "verify_result": {
        const waiter = this.verifyWaiters.get(req.reqId);
        if (waiter) {
          this.verifyWaiters.delete(req.reqId);
          waiter({ ok: req.ok, digest: req.digest });
        }
        break;
      }
      case "log": {
        this.hooks.logRuntime(req.level, screenText(req.text).redacted);
        break;
      }
      case "heartbeat": {
        break;
      }
    }
  }
}
