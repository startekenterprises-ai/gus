/**
 * Comm server — the control plane's end of the sandbox bridge.
 *
 * Listens on a unix socket inside the shared comm volume. The socket is
 * the ONLY way into the control plane from the sandbox, and it exposes
 * requests, not state: the runtime cannot read the ledger, the policy
 * store, the vault, or the kill flag — it can only ask for model calls
 * (Governor-gated), tool authorizations (class-gated), and verifications.
 */
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type { ControlMessage, RuntimeRequest } from "@gus/shared";
import { GUS_VERSION, screenText } from "@gus/shared";
import type { ShieldGate } from "@gus/gate";
import type { Governor } from "./governor.js";
import type { JobRunner } from "./jobs.js";
import type { PolicyStore } from "./policy.js";
import { canonicalize, type ApprovalEngine, type ApprovalRequest } from "./approvals.js";
import { estimateTokens, fakeComplete, FAKE_MODEL_NAME } from "./provider.js";
import { stubCompletion, type Provider } from "./providers.js";
import { isGmailTool } from "./gmail.js";

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

/**
 * The Gmail gate the comm server delegates `gmail_*` tool calls to
 * (Phase 6). Structurally the GmailService (gmail.ts); declared here
 * so the comm layer depends on the contract, not the pack. Like
 * fetch, gmail executes HERE — the OAuth credential never crosses to
 * the sandbox, which only ever receives the verified outcome.
 */
export interface GmailGate {
  execute(
    jobId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; summary: string; refused?: boolean }>;
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
  private server?: Server;
  private verifyWaiters = new Map<string, (v: { ok: boolean; digest?: string }) => void>();
  private seq = 0;
  /** Runtime version from the most recent `hello` on this socket. */
  private runtimeVersionSeen?: string;
  private versionWaiters: { version: string; resolve: (ok: boolean) => void }[] = [];

  constructor(
    private socketPath: string,
    private governor: Governor,
    private jobs: JobRunner,
    private hooks: HostHooks,
    private policy: PolicyStore,
    private approvals: ApprovalEngine,
    private fetchGate?: FetchGate,
    /** Phase 4: the Shield gate (spec §1.7). Optional so the canary
     *  runner's scratch endpoint and pre-Phase-4 wiring construct
     *  without it; when present, every tool call and every tool result
     *  crosses it. An unprovisioned gate steps aside by its own rules
     *  (shield-gate.ts), so Phases 0–3 behavior is unchanged. */
    private shieldGate?: ShieldGate,
    /** Phase 4: resolves the active provider per model call (config
     *  is re-read each time, so an onboarding/panel change is live on
     *  the next call). Defaults to the deterministic stub. */
    private providerFactory?: () => Provider,
    /** Phase 6: the Gmail pack's executor. Optional so pre-Phase-6
     *  wiring constructs without it; gmail calls then refuse plainly
     *  ("pack not configured") instead of ever reaching the runtime. */
    private gmailGate?: GmailGate,
  ) {}

  async start(): Promise<void> {
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    const server = createServer((sock) => this.onConnection(sock));
    this.server = server;
    await new Promise<void>((resolve) => server.listen(this.socketPath, resolve));
    // The sandbox runs under a different uid namespace; the socket file
    // must be connectable across it. The comm volume is private to the
    // two containers, so 0777 on the socket is the intended posture.
    chmodSync(this.socketPath, 0o777);
  }

  /** Stop listening and remove the socket file. Used by the canary
   *  runner (Phase 3), which hosts a short-lived second comm endpoint
   *  for a candidate runtime and must not leave it behind. */
  async close(): Promise<void> {
    this.conn?.destroy();
    this.conn = null;
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    for (const w of this.versionWaiters.splice(0)) w.resolve(false);
  }

  /** The runtime version most recently announced on this socket. */
  get runtimeVersion(): string | undefined {
    return this.runtimeVersionSeen;
  }

  /**
   * Resolve true once a runtime hello announces `version` on this
   * socket (immediately, if the last hello already did); false on
   * timeout. Phase 3: the Updater's health check for a candidate
   * runtime and its post-promotion live confirmation both reduce to
   * this question.
   */
  waitRuntimeVersion(version: string, timeoutMs: number): Promise<boolean> {
    if (this.runtimeVersionSeen === version) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = { version, resolve };
      this.versionWaiters.push(waiter);
      setTimeout(() => {
        const i = this.versionWaiters.indexOf(waiter);
        if (i >= 0) {
          this.versionWaiters.splice(i, 1);
          resolve(false);
        }
      }, timeoutMs);
    });
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
      // Phase 4: an approved fetch's result crosses the same Shield
      // gate as any other — approval authorizes the ACTION; it never
      // waives the scan of what comes back.
      const gated = await this.gateToolResult(approval.jobId, approval.tool, approval.args, {
        ok: true,
        summary: fetchSummary(approval.args, r),
      });
      this.send({
        t: "approved_execution",
        jobId: approval.jobId,
        tool: approval.tool,
        args: approval.args,
        result: gated,
      });
      return;
    }
    if (isGmailTool(approval.tool)) {
      // Phase 6: an approved gmail action executes HERE, in the
      // control plane (the OAuth credential cannot cross to the
      // sandbox), with the EXACT stored arguments — the outcome rides
      // back with the approved_execution, like an approved fetch.
      if (!this.gmailGate) {
        const note = "the Gmail pack is not configured in this control plane";
        try {
          this.jobs.transition(approval.jobId, "failed-loudly", note);
        } catch { /* settled already */ }
        this.hooks.onDenied(approval.jobId, approval.tool, note);
        return;
      }
      const r = await this.gmailGate.execute(approval.jobId, approval.tool, approval.args);
      if (r.refused) {
        try {
          this.jobs.transition(approval.jobId, "failed-loudly", r.summary);
        } catch { /* settled already */ }
        this.hooks.onDenied(approval.jobId, approval.tool, r.summary);
        return;
      }
      this.send({
        t: "approved_execution",
        jobId: approval.jobId,
        tool: approval.tool,
        args: approval.args,
        result: r,
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

  /** A Governor refusal on a model call: cap refusals are terminal,
   *  receipted job outcomes (never silent stalls); kill refusals are
   *  settled by the channel host, which owns the kill action. */
  private refuseModel(
    req: Extract<RuntimeRequest, { t: "model_request" }>,
    decision: { ok: false; reason: "killed" | "cap_exceeded"; detail: string },
  ): void {
    if (decision.reason === "cap_exceeded") {
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
  }

  /**
   * Phase 4 gate, tool-result surface: scan a control-plane-executed
   * tool's result BEFORE it can reach the model. Returns the summary
   * the runtime may relay, or a withholding notice when the gate
   * blocks — the scanned content itself never crosses. Flagged
   * results proceed with the flag stated in the summary.
   */
  private async gateToolResult(
    jobId: string,
    tool: string,
    args: Record<string, unknown>,
    result: { ok: boolean; summary: string },
  ): Promise<{ ok: boolean; summary: string }> {
    if (!this.shieldGate || tool !== "fetch") return result;
    const decision = await this.shieldGate.scanSurface("tool-result", jobId, result.summary);
    if (decision.receipt) this.jobs.noteShieldReceipt(jobId, decision.receipt.receiptId);
    if (decision.action === "block") {
      return {
        ok: false,
        summary:
          `the fetched content was withheld by the Agent-Shield gate: ${decision.detail}. ` +
          `Nothing from that page was shown to the agent.`,
      };
    }
    if (decision.action === "flag") {
      return { ok: result.ok, summary: `${result.summary}; shield note: ${decision.detail}` };
    }
    return result;
  }

  private async onRequest(req: RuntimeRequest): Promise<void> {
    switch (req.t) {
      case "hello": {
        this.runtimeVersionSeen = req.runtimeVersion;
        for (const w of [...this.versionWaiters]) {
          if (w.version === req.runtimeVersion) {
            this.versionWaiters.splice(this.versionWaiters.indexOf(w), 1);
            w.resolve(true);
          }
        }
        this.send({ t: "welcome", controlVersion: GUS_VERSION, killed: this.governor.isKilled() });
        this.hooks.onRuntimeHello();
        break;
      }
      case "model_request": {
        const provider = this.providerFactory?.();
        if (!provider || provider.kind === "stub") {
          // The stub provider is deterministic, so the exact tokens of
          // the reply are computable BEFORE authorization — the
          // Governor's reservation therefore equals the settlement,
          // and cap math is exact (governor.ts).
          const { reply, tokensIn, tokensOut } = stubCompletion(req.prompt);
          const decision = this.governor.authorize(req.jobId, tokensIn, tokensOut, FAKE_MODEL_NAME);
          if (!decision.ok) {
            this.refuseModel(req, decision);
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
        // Phase 4: a real provider. Reserve against an estimate
        // (prompt tokens + the configured output budget), spend, then
        // settle the ACTUAL usage the provider reports. A provider
        // failure refunds the reservation — the ledger reconciles and
        // the job hears a provider_error, never a silent stall.
        const estIn = estimateTokens(req.prompt);
        const decision = this.governor.authorize(
          req.jobId,
          estIn,
          provider.maxTokensOut,
          provider.modelKey,
        );
        if (!decision.ok) {
          this.refuseModel(req, decision);
          break;
        }
        try {
          const completion = await provider.complete(req.prompt);
          const costUsd = this.governor.settle(
            decision.reservationId,
            completion.tokensIn,
            completion.tokensOut,
          );
          this.jobs.addUsage(req.jobId, completion.tokensIn, completion.tokensOut, costUsd);
          this.hooks.onModelIssued(req.jobId, completion.reply.text);
          this.send({
            t: "model_response",
            reqId: req.reqId,
            ok: true,
            text: completion.reply.text,
            toolCall: completion.reply.toolCall,
            tokensIn: completion.tokensIn,
            tokensOut: completion.tokensOut,
            costUsd,
          });
        } catch (e) {
          try {
            this.governor.refund(decision.reservationId, "provider_error");
          } catch {
            /* reservation already closed — the refusal to spend stands */
          }
          const detail = screenText(e instanceof Error ? e.message : String(e)).redacted;
          this.hooks.logRuntime("error", `provider error for job ${req.jobId}: ${detail}`);
          this.send({
            t: "model_response",
            reqId: req.reqId,
            ok: false,
            reason: "provider_error",
            detail,
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
          });
        }
        break;
      }
      case "tool_call": {
        // --- Phase 4: the Shield gate scans the call's arguments
        // BEFORE anything else (spec §1.7, choke point 1:
        // scan-before-act). A block is terminal and receipted with
        // the Shield receipt itself; the call never reaches the
        // classifier, let alone execution.
        if (this.shieldGate) {
          const gateDecision = await this.shieldGate.scanSurface(
            "tool-call",
            req.jobId,
            canonicalize({ tool: req.tool, args: req.args }),
          );
          if (gateDecision.receipt) {
            this.jobs.noteShieldReceipt(req.jobId, gateDecision.receipt.receiptId);
          }
          if (gateDecision.action === "block") {
            const note = `blocked by the Agent-Shield gate before execution: ${gateDecision.detail}`;
            try {
              this.jobs.transition(req.jobId, "failed-loudly", note, {
                shieldReceiptId: gateDecision.receipt?.receiptId,
              });
            } catch {
              /* already settled/parked — the block stands regardless */
            }
            this.hooks.onDenied(req.jobId, req.tool, note);
            this.send({ t: "tool_result", reqId: req.reqId, status: "denied", note });
            break;
          }
          if (gateDecision.action === "flag") {
            this.hooks.logRuntime(
              "warn",
              `shield gate flagged tool call ${req.tool} for job ${req.jobId}: ${gateDecision.detail}`,
            );
          }
        }

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
          // Phase 4: the fetched content crosses the Shield gate
          // before it can reach the model's context (choke point 1,
          // result side). A block relays only the withholding notice.
          const gated = await this.gateToolResult(req.jobId, req.tool, req.args, {
            ok: true,
            summary: fetchSummary(req.args, r),
          });
          this.send({
            t: "tool_result",
            reqId: req.reqId,
            status: "authorized",
            note: r.note,
            result: gated,
          });
          break;
        }
        // --- Phase 6: gmail_* executes HERE, in the control plane,
        // like fetch (the OAuth credential never crosses to the
        // sandbox). The service Shield-scans inbound content,
        // secret-guards outbound content, and verifies every outcome
        // before its summary rides back with the authorization.
        if (isGmailTool(req.tool)) {
          if (!this.gmailGate) {
            const note = "the Gmail pack is not configured in this control plane";
            this.send({ t: "tool_result", reqId: req.reqId, status: "denied", note });
            break;
          }
          const r = await this.gmailGate.execute(req.jobId, req.tool, req.args);
          if (r.refused) {
            // Hard refusal (secret-guard, transport failure): the
            // egress-refusal shape — terminal, receipted, loud.
            try {
              this.jobs.transition(req.jobId, "failed-loudly", r.summary);
            } catch {
              /* already settled/parked — refusal stands regardless */
            }
            this.hooks.onDenied(req.jobId, req.tool, r.summary);
            this.send({ t: "tool_result", reqId: req.reqId, status: "denied", note: r.summary });
            break;
          }
          // Otherwise the outcome rides back as the result — including
          // a Shield-withheld read (ok:false), exactly like a blocked
          // fetch result: the job continues, the content never crossed.
          this.send({
            t: "tool_result",
            reqId: req.reqId,
            status: "authorized",
            result: r,
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
