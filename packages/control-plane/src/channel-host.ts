/**
 * Channel host — the control plane's operator-facing brain.
 *
 * Owns: channel adapters, ingress secret-guard, operator commands
 * (/stop, /resume), job creation, egress screening, post-condition
 * verification, and job settlement. The runtime sandbox is reached only
 * through the CommServer; channels never touch the sandbox directly.
 */
import { appendFileSync } from "node:fs";
import type { ChannelAdapter, ChannelEvent } from "@gus/shared";
import { guardEvent, screenText } from "@gus/shared";
import { sha256Hex } from "@gus/gate";
import type { Governor } from "./governor.js";
import type { JobRunner } from "./jobs.js";
import type { CommServer } from "./comm-server.js";

const SECRET_WARNING = (classes: string[]) =>
  `⚠️ That looked like a secret (${classes.join(", ")}), so I refused it: ` +
  `I didn't forward it to the agent, store it, or put it in any log. ` +
  `If it was real, rotate it now — I can't unsend what other people in this chat may already have seen.`;

export class ChannelHost {
  private comm!: CommServer;
  private pendingDeliveries = new Map<string, string>();
  private pendingWrites = new Map<string, { path: string; expectedDigest: string }>();
  private lastModelHash = new Map<string, string>();

  constructor(
    private stateDir: string,
    private governor: Governor,
    private jobs: JobRunner,
    private adapters: ChannelAdapter[],
  ) {}

  attachComm(comm: CommServer): void {
    this.comm = comm;
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
  private async sendTo(adapterName: string, conversationId: string, text: string): Promise<void> {
    const adapter = this.adapters.find((a) => a.name === adapterName) ?? this.adapters[0];
    if (!adapter) return;
    const screened = screenText(text);
    const out = screened.clean
      ? text
      : "[message withheld by secret-guard: it contained what looked like a secret]";
    if (!screened.clean) this.logEvent("guard.jsonl", guardEvent("egress", screened));
    await adapter.send({ conversationId, text: out });
  }

  private async onEvent(adapterName: string, ev: ChannelEvent): Promise<void> {
    if (ev.type === "button") {
      // Approval resolution is Phase 2. Presses are acknowledged and
      // logged; parked jobs stay parked (nothing executes on a press yet).
      const adapter = this.adapters.find((a) => a.name === adapterName);
      await adapter?.ackButton?.(ev.press.callbackId, "Approvals land in Phase 2 — job stays parked.");
      this.logEvent("events.jsonl", { ts: Date.now(), kind: "button_press_phase0", buttonId: ev.press.buttonId });
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

    if (this.governor.isKilled()) {
      await this.sendTo(adapterName, msg.conversationId, "⏹ Kill switch is ON. Nothing is running. Send /resume to bring GUS back.");
      return;
    }

    const kind = /^slow job$/i.test(text)
      ? "slow-demo"
      : /^fetch\b/i.test(text)
        ? "fetch-summarize"
        : "chat";
    const job = this.jobs.create(kind, msg.conversationId, screened.redacted);
    this.jobs.transition(job.id, "running");
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
    this.pendingWrites.set(jobId, { path, expectedDigest: sha256Hex(content) });
  }

  onParked(jobId: string, tool: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    void this.sendTo(
      this.adapters[0]?.name ?? "telegram",
      job.conversationId,
      `⏸ Job parked: "${tool}" needs your approval before anything runs. Nothing was executed. (Approval resolution lands in Phase 2.)`,
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
    const pending = this.pendingWrites.get(jobId);
    if (pending) {
      const v = await this.comm.verify(jobId, {
        tool: "workspace_read",
        args: { path: pending.path },
      });
      verified = v.ok && v.digest === pending.expectedDigest;
      note = verified
        ? "post-condition ok: workspace file content hash matches the authorized write"
        : "post-condition FAILED: workspace file hash mismatch or unreadable";
      this.pendingWrites.delete(jobId);
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
