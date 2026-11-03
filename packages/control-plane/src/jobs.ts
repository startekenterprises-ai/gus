/**
 * Job Runner (foundation spec §1.5) — Phase 0 core.
 *
 * Durable JSONL job store in control-plane state. Enforces the transition
 * rules: a job may only settle as verified-done or failed-loudly, may park
 * as needs-approval, and every settlement issues a receipt (Phase 0: the
 * local stub issuer from @gus/gate; Phase 4: real Agent-Shield receipts).
 *
 * "Verified" in Phase 0: for chat jobs, verification is a comm round-trip
 * post-condition — the control plane asks the runtime for the job's result
 * artifact (echo token) and compares hashes. It is deliberately NOT the
 * agent's self-report: the runner settles verified-done only when its own
 * checker confirms. Per-job-type checkers (file hash, sent-mail read-back)
 * arrive with their job types in later phases.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { JobKind, JobRecord, JobState } from "@gus/shared";
import { screenText, sha256Hex } from "./screen.js";
import type { LocalReceiptIssuer, Receipt } from "@gus/gate";

const ALLOWED: Record<JobState, JobState[]> = {
  queued: ["running", "needs-approval", "failed-loudly"],
  running: ["needs-approval", "verified-done", "failed-loudly"],
  "needs-approval": ["running", "failed-loudly"],
  "verified-done": [],
  "failed-loudly": [],
};

let counter = 0;

export class JobRunner {
  private jobs = new Map<string, JobRecord>();

  constructor(
    private stateDir: string,
    private receipts: LocalReceiptIssuer,
  ) {
    this.load();
  }

  private storePath(): string {
    return `${this.stateDir}/jobs.jsonl`;
  }

  private load(): void {
    if (!existsSync(this.storePath())) return;
    for (const line of readFileSync(this.storePath(), "utf8").split("\n")) {
      if (!line) continue;
      const rec = JSON.parse(line) as JobRecord;
      this.jobs.set(rec.id, rec);
    }
  }

  private persist(rec: JobRecord): void {
    appendFileSync(this.storePath(), JSON.stringify(rec) + "\n");
  }

  create(kind: JobKind, conversationId: string, redactedInput: string): JobRecord {
    const id = `job_${Date.now().toString(36)}_${(counter++).toString(36)}${Math.floor(Math.random() * 1e4)}`;
    const rec: JobRecord = {
      id,
      kind,
      state: "queued",
      inputHash: sha256Hex(redactedInput),
      conversationId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    this.jobs.set(id, rec);
    this.persist(rec);
    return rec;
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  /** All jobs, newest first (Phase 4: the panel's history surface). */
  list(limit = 200): JobRecord[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /** Most recent non-settled job for a conversation (kill targeting). */
  activeFor(conversationId: string): JobRecord | undefined {
    let found: JobRecord | undefined;
    for (const j of this.jobs.values()) {
      if (j.conversationId === conversationId && j.state !== "verified-done" && j.state !== "failed-loudly") {
        if (!found || j.createdAt > found.createdAt) found = j;
      }
    }
    return found;
  }

  /**
   * True while any job other than `exceptId` is unsettled (queued,
   * running, or parked). Phase 3: the Updater's idle gate — an update
   * never starts while work is in flight, and a parked (needs-approval)
   * job counts as in flight.
   */
  hasActiveJobsExcept(exceptId: string): boolean {
    for (const j of this.jobs.values()) {
      if (j.id === exceptId) continue;
      if (j.state !== "verified-done" && j.state !== "failed-loudly") return true;
    }
    return false;
  }

  /** Phase 4: attach a real Agent-Shield receipt id to this job (a
   *  gated surface produced it). Persisted immediately — the id is the
   *  job's durable link to gate.jsonl and the verify endpoint. */
  noteShieldReceipt(id: string, shieldReceiptId: string): void {
    const rec = this.jobs.get(id);
    if (!rec) return;
    rec.shieldReceiptIds = [...(rec.shieldReceiptIds ?? []), shieldReceiptId];
    rec.updatedAt = Date.now();
    this.persist(rec);
  }

  transition(
    id: string,
    next: JobState,
    outcomeNote?: string,
    opts?: {
      /**
       * Phase 4: settle WITH a real Agent-Shield receipt instead of
       * issuing a local stub. Used when the settlement IS a gated
       * event (a Shield block): the job's receipt is then the
       * verifiable Shield receipt for the scan that stopped it. The
       * receipts.jsonl line says so plainly (kind "agent-shield") —
       * the stub issuer is used only where no Shield call applies.
       */
      shieldReceiptId?: string;
    },
  ): JobRecord {
    const rec = this.jobs.get(id);
    if (!rec) throw new Error(`unknown job ${id}`);
    if (!ALLOWED[rec.state].includes(next)) {
      throw new Error(`illegal job transition ${rec.state} -> ${next} for ${id}`);
    }
    rec.state = next;
    rec.updatedAt = Date.now();
    if (outcomeNote !== undefined) {
      // Notes are operator/agent-visible text: screen before persisting so
      // a secret can never ride into the durable store via a note.
      rec.outcomeNote = screenText(outcomeNote).redacted;
    }
    if (next === "verified-done" || next === "failed-loudly") {
      if (opts?.shieldReceiptId) {
        rec.receiptId = opts.shieldReceiptId;
        appendFileSync(
          `${this.stateDir}/receipts.jsonl`,
          JSON.stringify({
            kind: "agent-shield",
            receiptId: opts.shieldReceiptId,
            jobId: rec.id,
            state: next,
            note: "Settlement receipt is the Agent-Shield Protocol receipt of the gate scan that decided this job — verifiable via the Agent-Shield verify endpoint / /v/ page. Full receipt in gate.jsonl.",
          }) + "\n",
        );
      } else {
        const receipt: Receipt = this.receipts.issue({
          jobId: rec.id,
          state: next,
          contentHash: rec.inputHash,
          costUsd: rec.costUsd,
        });
        rec.receiptId = receipt.receiptId;
        appendFileSync(
          `${this.stateDir}/receipts.jsonl`,
          JSON.stringify(receipt) + "\n",
        );
      }
    }
    this.persist(rec);
    return rec;
  }

  addUsage(id: string, tokensIn: number, tokensOut: number, costUsd: number): void {
    const rec = this.jobs.get(id);
    if (!rec) return;
    rec.tokensIn += tokensIn;
    rec.tokensOut += tokensOut;
    rec.costUsd += costUsd;
    rec.updatedAt = Date.now();
    this.persist(rec);
  }
}
