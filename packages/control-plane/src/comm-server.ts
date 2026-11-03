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
import { estimateTokens, fakeComplete, FAKE_MODEL_NAME } from "./provider.js";

export interface HostHooks {
  onRuntimeHello(): void;
  onModelIssued(jobId: string, text: string | undefined): void;
  noteAuthorizedWrite(jobId: string, path: string, content: string): void;
  onParked(jobId: string, tool: string): void;
  onDenied(jobId: string, tool: string, note: string): void;
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

export class CommServer {
  private conn: Socket | null = null;
  private verifyWaiters = new Map<string, (v: { ok: boolean; digest?: string }) => void>();
  private seq = 0;

  constructor(
    private socketPath: string,
    private governor: Governor,
    private jobs: JobRunner,
    private hooks: HostHooks,
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

  private async onRequest(req: RuntimeRequest): Promise<void> {
    switch (req.t) {
      case "hello": {
        this.send({ t: "welcome", controlVersion: "0.0.1", killed: this.governor.isKilled() });
        this.hooks.onRuntimeHello();
        break;
      }
      case "model_request": {
        const est = estimateTokens(req.prompt) + 64;
        const decision = this.governor.authorize(req.jobId, est);
        if (!decision.ok) {
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
        const reply = fakeComplete(req.prompt);
        const tokensIn = estimateTokens(req.prompt);
        const tokensOut = estimateTokens(reply.text ?? JSON.stringify(reply.toolCall ?? {}));
        this.governor.record({
          ts: Date.now(),
          jobId: req.jobId,
          model: FAKE_MODEL_NAME,
          tokensIn,
          tokensOut,
          costUsd: 0,
        });
        this.jobs.addUsage(req.jobId, tokensIn, tokensOut, 0);
        this.hooks.onModelIssued(req.jobId, reply.text);
        this.send({
          t: "model_response",
          reqId: req.reqId,
          ok: true,
          text: reply.text,
          toolCall: reply.toolCall,
          tokensIn,
          tokensOut,
          costUsd: 0,
        });
        break;
      }
      case "tool_call": {
        // --- Phase 1: vault_read — refused by construction. There is no
        // vault read API for the sandbox; asking is itself the red-team
        // signal. The job fails loudly (denial is a terminal, receipted
        // outcome — never a silent drop, never a park).
        if (req.tool === "vault_read") {
          const note =
            "the Vault Broker has no read API — secrets are used via egress injection, never read";
          this.hooks.logRuntime(
            "warn",
            `vault_read attempt refused for job ${req.jobId} (name: ${String(req.args.name ?? "?")})`,
          );
          try {
            this.jobs.transition(req.jobId, "failed-loudly", `denied tool vault_read: ${note}`);
          } catch {
            /* already settled/parked — refusal stands regardless */
          }
          this.hooks.onDenied(req.jobId, req.tool, note);
          this.send({ t: "tool_result", reqId: req.reqId, status: "denied", note });
          break;
        }
        // --- Phase 1: fetch — executed HERE, in the egress proxy. The
        // sandbox has no network; the proxy enforces allowlist, outbound
        // screening, and vault injection, and the screened result rides
        // back with the authorization.
        if (req.tool === "fetch") {
          if (!this.fetchGate) {
            const note = "egress proxy is not configured in this control plane";
            this.send({ t: "tool_result", reqId: req.reqId, status: "denied", note });
            break;
          }
          const r = await this.fetchGate.fetch(
            {
              url: String(req.args.url ?? ""),
              method: typeof req.args.method === "string" ? req.args.method : undefined,
              headers:
                req.args.headers && typeof req.args.headers === "object"
                  ? (req.args.headers as Record<string, string>)
                  : undefined,
              body: typeof req.args.body === "string" ? req.args.body : undefined,
              secretName:
                typeof req.args.secretName === "string" ? req.args.secretName : undefined,
            },
            { jobId: req.jobId },
          );
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
          const summary =
            `fetch ${String(req.args.url ?? "")} -> HTTP ${r.status ?? "?"}; ` +
            `body: ${(r.body ?? "").slice(0, 500)}` +
            (r.note ? `; notes: ${r.note}` : "");
          this.send({
            t: "tool_result",
            reqId: req.reqId,
            status: "authorized",
            note: r.note,
            result: { ok: true, summary },
          });
          break;
        }
        const cls = req.declaredClass;
        if (cls === "destructive" || cls === "external-send" || cls === "pay") {
          try {
            this.jobs.transition(req.jobId, "needs-approval", `tool ${req.tool} (${cls}) requires approval`);
          } catch {
            /* already parked/settled — authorization still refused */
          }
          this.hooks.onParked(req.jobId, req.tool);
          this.send({ t: "tool_result", reqId: req.reqId, status: "needs_approval", note: "parked by Approval Engine stub (Phase 0): nothing executed" });
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
