/**
 * Channel host — the control plane's operator-facing brain.
 *
 * Owns: channel adapters, ingress secret-guard, operator commands
 * (/stop, /resume), job creation, egress screening, post-condition
 * verification, and job settlement. The runtime sandbox is reached only
 * through the CommServer; channels never touch the sandbox directly.
 */
import { appendFileSync } from "node:fs";
import type { ApprovalButton, ChannelAdapter, ChannelEvent, JobKind } from "@gus/shared";
import { guardEvent, screenText } from "@gus/shared";
import { sha256Hex, type ShieldGate } from "@gus/gate";
import type { Governor } from "./governor.js";
import type { JobRunner } from "./jobs.js";
import type { CommServer } from "./comm-server.js";
import type { ApprovalEngine, ApprovalRequest } from "./approvals.js";

const SECRET_WARNING = (classes: string[]) =>
  `⚠️ That looked like a secret (${classes.join(", ")}), so I refused it: ` +
  `I didn't forward it to the agent, store it, or put it in any log. ` +
  `If it was real, rotate it now — I can't unsend what other people in this chat may already have seen.`;

/** A post-condition the control plane will verify before a job may
 *  settle verified-done: a written file's content hash, or the absence
 *  of deleted files. Set when a write/delete is authorized (directly or
 *  via approval); checked by fixed runtime code, never by the model. */
type PendingCheck =
  | { type: "write"; path: string; expectedDigest: string }
  | { type: "absent"; paths: string[] };

/**
 * The Phase 3 update surface the host delegates to (implemented over
 * the Updater in main.ts; declared here so the host never imports the
 * updater). startUpdate creates the update job and kicks the pipeline,
 * returning the immediate ack the operator sees.
 */
export interface UpdateCommands {
  startUpdate(conversationId: string, version: string): string;
  versionText(): string;
}

export class ChannelHost {
  private comm!: CommServer;
  private pendingDeliveries = new Map<string, string>();
  private pendingChecks = new Map<string, PendingCheck>();
  private lastModelHash = new Map<string, string>();
  private updateCommands?: UpdateCommands;

  constructor(
    private stateDir: string,
    private governor: Governor,
    private jobs: JobRunner,
    private adapters: ChannelAdapter[],
    private approvals?: ApprovalEngine,
    /** Phase 4: the Shield gate — inbound messages cross it before
     *  they can become runtime work (spec §1.7, choke point 1). */
    private shieldGate?: ShieldGate,
  ) {}

  attachComm(comm: CommServer): void {
    this.comm = comm;
  }

  /** Phase 3: wire the /update and /version channel commands. */
  bindUpdateCommands(cmds: UpdateCommands): void {
    this.updateCommands = cmds;
  }

  /** Operator notification on the primary adapter (updater notices,
   *  confirmations). Same egress screening as every outbound text. */
  async notifyOperator(conversationId: string, text: string): Promise<void> {
    await this.sendTo(this.adapters[0]?.name ?? "telegram", conversationId, text);
  }

  /**
   * Create a job through the live pipeline without a channel event
   * (Phase 3: the post-promotion confirmation job). The text is ours,
   * but it goes through the same create → run → verify → settle path
   * as any operator job; kind "canary" marks it as a system check.
   * Phase 4: onboarding's first guided job reuses the path as a
   * "digest" — system jobs are control-plane-authored, so the inbound
   * Shield scan (which guards OPERATOR-supplied text on its way to
   * the agent) does not apply to them; their tool calls and results
   * still cross the gate like everyone else's.
   */
  runSystemJob(conversationId: string, text: string, kind: JobKind = "canary"): string {
    const job = this.jobs.create(kind, conversationId, screenText(text).redacted);
    this.jobs.transition(job.id, "running");
    this.pendingDeliveries.set(job.id, text);
    this.comm.pushUserMessage({ jobId: job.id, kind: job.kind, text });
    return job.id;
  }

  async start(): Promise<void> {
    // Boot sweep: jobs left queued/running by a previous control-plane
    // incarnation must not hang silently (must-have 5).
    // (JobRunner has no iterator yet; the drill starts from fresh
    // state. The sweep remains deferred past Phase 1.)
    for (const a of this.adapters) {
      await a.start((ev) => void this.onEvent(a.name, ev));
    }
  }

  private logEvent(file: string, obj: unknown): void {
    appendFileSync(`${this.stateDir}/${file}`, JSON.stringify(obj) + "\n");
  }

  /** All outbound channel text passes egress screening — no exceptions,
   *  including our own static notices. */
  private async sendTo(
    adapterName: string,
    conversationId: string,
    text: string,
    buttons?: ApprovalButton[],
  ): Promise<void> {
    const adapter = this.adapters.find((a) => a.name === adapterName) ?? this.adapters[0];
    if (!adapter) return;
    const screened = screenText(text);
    const out = screened.clean
      ? text
      : "[message withheld by secret-guard: it contained what looked like a secret]";
    if (!screened.clean) this.logEvent("guard.jsonl", guardEvent("egress", screened));
    await adapter.send({ conversationId, text: out, buttons });
  }

  private async onEvent(adapterName: string, ev: ChannelEvent): Promise<void> {
    if (ev.type === "button") {
      // Phase 2: button presses resolve approvals. The button id IS the
      // resolution: "approve:<id>" / "deny:<id>", minted by the Approval
      // Engine when the job parked. A press naming no live approval —
      // forged, replayed, or stale — resolves nothing and is logged.
      const adapter = this.adapters.find((a) => a.name === adapterName);
      const m = ev.press.buttonId.match(/^(approve|deny):(.+)$/);
      if (!m) {
        await adapter?.ackButton?.(ev.press.callbackId, "Unknown button — nothing happened.");
        this.logEvent("events.jsonl", { ts: Date.now(), kind: "button_unknown", buttonId: ev.press.buttonId });
        return;
      }
      const [, action, id] = m;
      await adapter?.ackButton?.(ev.press.callbackId, action === "approve" ? "Approved." : "Denied.");
      await this.resolveApproval(adapterName, ev.press.conversationId, id, action === "approve", "channel-button");
      return;
    }
    const msg = ev.message;
    const screened = screenText(msg.text);
    if (!screened.clean) {
      this.logEvent("guard.jsonl", guardEvent("ingress", screened));
      await this.sendTo(adapterName, msg.conversationId, SECRET_WARNING([...new Set(screened.findings.map((f) => f.patternClass))]));
      return;
    }
    const text = msg.text.trim();
    if (text === "/stop") return this.kill(adapterName, msg.conversationId, `channel:${adapterName}`);
    if (text === "/resume") return this.resume(adapterName, msg.conversationId);
    // Approval resolution by command — the text fallback for adapters
    // without buttons. It must name the approval id exactly; a bare
    // "approve" in chat is just a chat message and resolves NOTHING
    // (it becomes an ordinary job, below). Resolution is deliberately
    // impossible to trigger by accident or by the agent's phrasing.
    const cmd = text.match(/^\/(approve|deny)\s+(\S+)$/);
    if (cmd) {
      return this.resolveApproval(adapterName, msg.conversationId, cmd[2], cmd[1] === "approve", "channel-command");
    }

    // Phase 3 operator commands. /version is a pure status read — it
    // answers even while the kill switch is on. /update starts the
    // boring-update pipeline (the Updater owns every stage after the
    // ack); while killed it is refused like all other work.
    if (text === "/version") {
      await this.sendTo(
        adapterName,
        msg.conversationId,
        this.updateCommands?.versionText() ?? "Version info is unavailable in this deployment.",
      );
      return;
    }
    const upd = text.match(/^\/update\s+(\S+)$/);
    if (upd) {
      if (!this.updateCommands) {
        await this.sendTo(adapterName, msg.conversationId, "Updates aren't wired up in this deployment. Nothing was changed.");
        return;
      }
      if (this.governor.isKilled()) {
        await this.sendTo(adapterName, msg.conversationId, "⏹ Kill switch is ON — updates don't run while GUS is stopped. Send /resume first.");
        return;
      }
      const ack = this.updateCommands.startUpdate(msg.conversationId, upd[1]);
      await this.sendTo(adapterName, msg.conversationId, ack);
      return;
    }

    if (this.governor.isKilled()) {
      await this.sendTo(adapterName, msg.conversationId, "⏹ Kill switch is ON. Nothing is running. Send /resume to bring GUS back.");
      return;
    }

    const kind = /^slow job$/i.test(text)
      ? "slow-demo"
      : /^loop spend$/i.test(text)
        ? "loop-demo"
        : /^fetch\b/i.test(text)
          ? "fetch-summarize"
          : "chat";
    const job = this.jobs.create(kind, msg.conversationId, screened.redacted);
    this.jobs.transition(job.id, "running");

    // --- Phase 4: the Shield gate scans the inbound message before
    // it can reach the runtime (spec §1.7, choke point 1). Operator
    // COMMANDS (/stop, /approve, /update…) never reach this point —
    // they are control-plane directives, not agent input, and are
    // handled above. A blocked message settles its job failed-loudly
    // WITH the Shield receipt; the runtime never sees the text.
    if (this.shieldGate) {
      const decision = await this.shieldGate.scanSurface("inbound-message", job.id, text);
      if (decision.receipt) {
        this.jobs.noteShieldReceipt(job.id, decision.receipt.receiptId);
      }
      if (decision.action === "block") {
        try {
          this.jobs.transition(
            job.id,
            "failed-loudly",
            `blocked by the Agent-Shield gate at ingress: ${decision.detail}`,
            { shieldReceiptId: decision.receipt?.receiptId },
          );
        } catch {
          /* already settled — the block stands regardless */
        }
        await this.sendTo(
          adapterName,
          msg.conversationId,
          `🛡 That message was blocked by the Agent-Shield gate before it reached the agent: ${decision.detail}. ` +
            `Nothing ran. The job ended as failed-loudly with the Shield receipt on its record.`,
        );
        return;
      }
      if (decision.action === "flag") {
        this.logEvent("events.jsonl", {
          ts: Date.now(),
          kind: "shield_flag_inbound",
          jobId: job.id,
          detail: decision.detail,
        });
      }
    }

    this.pendingDeliveries.set(job.id, text);
    this.comm.pushUserMessage({ jobId: job.id, kind, text });
  }

  async kill(adapterName: string, conversationId: string, by: string): Promise<void> {
    this.governor.setKilled(true, by);
    this.comm.broadcast({ t: "kill" });
    const active = this.jobs.activeFor(conversationId);
    if (active) {
      this.jobs.transition(active.id, "failed-loudly", "stopped by operator kill switch");
    }
    await this.sendTo(adapterName, conversationId, "⏹ Stopped. Kill switch is ON — send /resume when you want me back.");
  }

  async resume(adapterName: string, conversationId: string): Promise<void> {
    this.governor.setKilled(false, `channel:${adapterName}`);
    this.comm.broadcast({ t: "resume" });
    await this.sendTo(adapterName, conversationId, "▶️ Kill switch off. GUS is live.");
  }

  /**
   * Phase 4: the panel's kill switch — the same Governor flag and the
   * same broadcast as the channel's /stop, applied across every
   * conversation: every unsettled job settles failed-loudly (never
   * silently dropped), and the runtime is told to stop between steps.
   */
  killAll(by: string): { settled: number } {
    this.governor.setKilled(true, by);
    this.comm.broadcast({ t: "kill" });
    let settled = 0;
    for (const job of this.jobs.list(1000)) {
      if (job.state === "verified-done" || job.state === "failed-loudly") continue;
      try {
        this.jobs.transition(job.id, "failed-loudly", "stopped by operator kill switch");
        settled++;
      } catch {
        /* a job mid-settlement in a race — the kill flag still holds */
      }
    }
    return { settled };
  }

  /** Phase 4: the panel's resume — clears the same flag /resume clears. */
  resumeAll(by: string): void {
    this.governor.setKilled(false, by);
    this.comm.broadcast({ t: "resume" });
  }

  // ---- Phase 2: approval resolution (channel-side ONLY) ----

  /**
   * Resolve a pending approval from a channel event. This is the ONLY
   * resolution path in the system: buttons and /approve//deny commands
   * handled here. The runtime has no equivalent — see comm.ts.
   */
  async resolveApproval(
    adapterName: string,
    conversationId: string,
    id: string,
    approve: boolean,
    via: string,
  ): Promise<void> {
    if (!this.approvals) return;
    const req = this.approvals.get(id);
    if (!req || req.status !== "pending") {
      this.logEvent("events.jsonl", {
        ts: Date.now(),
        kind: "approval_resolve_rejected",
        id,
        status: req?.status ?? "unknown",
        via,
      });
      await this.sendTo(
        adapterName,
        conversationId,
        `That approval (${id}) is no longer pending${req ? ` — it is ${req.status}` : ""}. Nothing was executed.`,
      );
      return;
    }
    if (approve && this.governor.isKilled()) {
      await this.sendTo(
        adapterName,
        conversationId,
        "⏹ Kill switch is ON — approvals cannot execute while GUS is stopped. The request stays parked until it expires.",
      );
      return;
    }
    try {
      this.approvals.resolve(id, approve ? "approved" : "denied", via);
    } catch (e) {
      await this.sendTo(
        adapterName,
        conversationId,
        `That approval could not be resolved (${e instanceof Error ? e.message : String(e)}). Nothing was executed.`,
      );
      return;
    }
    this.logEvent("events.jsonl", {
      ts: Date.now(),
      kind: approve ? "approval_approved" : "approval_denied",
      id,
      jobId: req.jobId,
      via,
    });
    if (!approve) {
      try {
        this.jobs.transition(req.jobId, "failed-loudly", `denied by operator: ${req.summary}`);
      } catch {
        /* job already settled (kill raced us) — the denial stands */
      }
      await this.sendTo(
        adapterName,
        conversationId,
        `🚫 Denied: "${req.summary}". Nothing ran. The job ended as failed-loudly with a receipt.`,
      );
      return;
    }
    await this.sendTo(adapterName, conversationId, `✅ Approved: "${req.summary}". Executing exactly that now.`);
    await this.comm.executeApproval(req);
  }

  /** Approval Engine expiry callback: timeout = deny. The parked job
   *  settles failed-loudly (with receipt) and the operator hears why. */
  handleApprovalExpired(req: ApprovalRequest): void {
    try {
      this.jobs.transition(req.jobId, "failed-loudly", `approval timed out — treated as denied: ${req.summary}`);
    } catch {
      /* job already settled — expiry still recorded on the request */
    }
    this.logEvent("events.jsonl", { ts: Date.now(), kind: "approval_expired", id: req.id, jobId: req.jobId });
    void this.sendTo(
      this.adapters[0]?.name ?? "telegram",
      req.conversationId,
      `⌛ Approval expired (no answer in time = denied): "${req.summary}". Nothing ran. The job ended as failed-loudly with a receipt.`,
    );
  }

  // ---- callbacks from CommServer ----

  onRuntimeHello(): void {
    for (const [jobId, text] of this.pendingDeliveries) {
      const job = this.jobs.get(jobId);
      if (job && job.state === "running") {
        this.comm.pushUserMessage({ jobId, kind: job.kind, text });
      }
    }
  }

  onModelIssued(jobId: string, text: string | undefined): void {
    if (text !== undefined) this.lastModelHash.set(jobId, sha256Hex(text));
  }

  noteAuthorizedWrite(jobId: string, path: string, content: string): void {
    this.pendingChecks.set(jobId, { type: "write", path, expectedDigest: sha256Hex(content) });
  }

  /** Phase 2: an approved action is about to execute — record the same
   *  post-condition an authorized one gets, so approval can never become
   *  a verification bypass. */
  noteApprovedExecution(jobId: string, tool: string, args: Record<string, unknown>): void {
    if (tool === "workspace_write") {
      this.pendingChecks.set(jobId, {
        type: "write",
        path: String(args.path ?? ""),
        expectedDigest: sha256Hex(String(args.content ?? "")),
      });
    } else if (tool === "bulk_delete" && Array.isArray(args.paths)) {
      this.pendingChecks.set(jobId, { type: "absent", paths: args.paths.map(String) });
    }
  }

  onApprovalRequested(req: ApprovalRequest): void {
    const job = this.jobs.get(req.jobId);
    if (!job) return;
    const secs = Math.max(1, Math.round((req.expiresAt - Date.now()) / 1000));
    const buttons: ApprovalButton[] = [
      { id: `approve:${req.id}`, label: "✅ Approve" },
      { id: `deny:${req.id}`, label: "🚫 Deny" },
    ];
    void this.sendTo(
      this.adapters[0]?.name ?? "telegram",
      job.conversationId,
      `⏸ Job parked — this needs your approval before anything runs: "${req.summary}". ` +
        `Why: ${req.reason}. Nothing was executed. ` +
        `Tap Approve/Deny, or reply /approve ${req.id} or /deny ${req.id}. ` +
        `No answer within ${secs}s counts as a denial.`,
      buttons,
    );
  }

  onCapExceeded(jobId: string, detail: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    void this.sendTo(
      this.adapters[0]?.name ?? "telegram",
      job.conversationId,
      `💸 Governor cap reached — the job was stopped by the spend ceiling, not by the agent: ${detail}. ` +
        `It ended as failed-loudly with a receipt; the ledger shows every charge.`,
    );
  }

  onDenied(jobId: string, tool: string, note: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    void this.sendTo(
      this.adapters[0]?.name ?? "telegram",
      job.conversationId,
      `🚫 Denied by the control plane: "${tool}" was refused (${note}). The job ended as failed-loudly with a receipt.`,
    );
  }

  onJobUpdate(jobId: string, note: string): void {
    this.logEvent("runtime-log.jsonl", {
      ts: Date.now(),
      jobId,
      text: screenText(note).redacted,
    });
  }

  async onJobFinal(jobId: string, text: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.state === "verified-done" || job.state === "failed-loudly") return;
    const screened = screenText(text);
    if (!screened.clean) this.logEvent("guard.jsonl", guardEvent("egress", screened));
    const outText = screened.clean
      ? text
      : "[A reply was withheld by secret-guard: it contained what looked like a secret.]";

    let verified = false;
    let note: string;
    const pending = this.pendingChecks.get(jobId);
    if (pending && pending.type === "write") {
      const v = await this.comm.verify(jobId, {
        tool: "workspace_read",
        args: { path: pending.path },
      });
      verified = v.ok && v.digest === pending.expectedDigest;
      note = verified
        ? "post-condition ok: workspace file content hash matches the authorized write"
        : "post-condition FAILED: workspace file hash mismatch or unreadable";
      this.pendingChecks.delete(jobId);
    } else if (pending && pending.type === "absent") {
      const v = await this.comm.verify(jobId, {
        tool: "workspace_absent",
        args: { paths: pending.paths },
      });
      verified = v.ok;
      note = verified
        ? `post-condition ok: approved deletion verified — ${pending.paths.length} file(s) are absent`
        : "post-condition FAILED: a file approved for deletion is still present";
      this.pendingChecks.delete(jobId);
    } else {
      verified = this.lastModelHash.get(jobId) === sha256Hex(text);
      note = verified
        ? "post-condition ok: delivered output matches Governor-issued model output"
        : "post-condition FAILED: runtime output differs from Governor-issued model output";
    }

    if (verified) {
      this.jobs.transition(jobId, "verified-done", note);
      await this.sendTo(this.adapters[0]?.name ?? "telegram", job.conversationId, outText);
    } else {
      this.jobs.transition(jobId, "failed-loudly", note);
      await this.sendTo(
        this.adapters[0]?.name ?? "telegram",
        job.conversationId,
        "⚠️ That job failed its verification check, so I won't call it done. It ended as failed-loudly with a receipt in the log.",
      );
    }
    this.pendingDeliveries.delete(jobId);
  }
}
