/**
 * Approval Engine (foundation spec §1.4) — Phase 2.
 *
 * Approvals are CONTROL-PLANE STATE: a durable append-only store in
 * <state>/approvals.jsonl, loaded on boot. They survive sandbox
 * restarts, control-plane restarts, and any amount of conversation
 * compaction BY CONSTRUCTION — the agent's context is not an input to
 * anything in this file. The runtime has no message type that can
 * create, resolve, extend, or forge an approval (see comm.ts); the only
 * resolution inputs are channel events handled by the ChannelHost
 * (inline buttons, or /approve /deny commands from the operator).
 *
 * Binding: every request records the sha256 of the CANONICAL form of the
 * exact tool + arguments (object keys sorted recursively, so key order
 * cannot smuggle a different call past a granted approval). Change any
 * argument — a path, a count, a URL — and the hash differs, no approval
 * matches, and the call must be re-requested. Execution always uses the
 * arguments stored HERE, never a fresh copy from the runtime.
 *
 * Lifecycle: pending → approved → consumed (single-use: consumption is
 * recorded before execution starts) | pending → denied | pending →
 * expired. Timeout = deny: an expiry sweep runs on a timer and on every
 * read; expiring a request fires onExpire so the parked job settles
 * failed-loudly instead of hanging in needs-approval forever.
 *
 * Arguments are secret-guard screened before they are stored or shown:
 * the store keeps the screened form (which is also the form whose hash
 * binds, and the form that executes — screening can only redact, never
 * alter semantics toward MORE privilege).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { screenText } from "@gus/shared";
import { sha256Hex } from "@gus/gate";
import { gmailMessageIds, gmailRecipients } from "./gmail.js";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

export interface ApprovalRequest {
  id: string;
  jobId: string;
  conversationId: string;
  tool: string;
  /** Screened arguments — the exact form that will execute. */
  args: Record<string, unknown>;
  /** sha256 of canonical {tool, args} — the binding. */
  argsHash: string;
  /** Plain-language description of exactly what will happen. */
  summary: string;
  /** Classifier's reason this call needs approval. */
  reason: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  /** How it was resolved: "channel-button" | "channel-command" | "timeout". */
  resolvedBy?: string;
}

/** Canonical JSON: object keys sorted recursively. Two argument sets
 *  hash equal iff they are semantically identical. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function argsHashFor(tool: string, args: Record<string, unknown>): string {
  return sha256Hex(canonicalize({ tool, args }));
}

/** Screen an args object for storage/display/execution. */
export function screenArgs(args: Record<string, unknown>): Record<string, unknown> {
  const screened = screenText(JSON.stringify(args));
  if (screened.clean) return args;
  try {
    return JSON.parse(screened.redacted) as Record<string, unknown>;
  } catch {
    // Redaction broke the JSON shape (a secret spanning a quote): keep a
    // inert placeholder — the parked call will fail loudly at execution
    // rather than ever run with unscreened arguments.
    return { _redacted: screened.redacted };
  }
}

/** Plain-language description of exactly what an approval would do. */
export function describeAction(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "bulk_delete": {
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
      if (paths.length > 0) {
        return `Delete ${paths.length} file(s) from the workspace: ${paths.join(", ")}`;
      }
      return `Delete ${String(args.count ?? "?")} file(s) from the workspace`;
    }
    case "workspace_write":
      return `Write file "${String(args.path ?? "?")}" in the workspace (${String(args.content ?? "").length} chars)`;
    case "fetch": {
      const base = `Fetch ${String(args.url ?? "?")}${args.method ? ` (${String(args.method)})` : ""}`;
      return typeof args.secretName === "string"
        ? `${base} using the stored credential "${args.secretName}" (injected by the egress proxy — the agent never sees the value)`
        : base;
    }
    // Phase 6 (Gmail pack): summaries enumerate the EXACT message IDs
    // and recipients — that enumeration is the Yue rule made visible;
    // an approval that cannot say precisely what it covers does not
    // get granted.
    case "gmail_delete": {
      const ids = gmailMessageIds(args);
      return `Delete ${ids.length} Gmail message(s) ${args.permanent === true ? "PERMANENTLY" : "(move to trash)"}: ${ids.join(", ") || "(none named)"}`;
    }
    case "gmail_label":
    case "gmail_archive":
    case "gmail_spam": {
      const ids = gmailMessageIds(args);
      const what =
        tool === "gmail_archive"
          ? "Archive (remove from inbox)"
          : tool === "gmail_spam"
            ? "Report as spam"
            : `Change labels (+[${[...(Array.isArray(args.addLabelIds) ? args.addLabelIds.map(String) : []), ...(typeof args.label === "string" ? [args.label] : [])].join(", ")}] -[${Array.isArray(args.removeLabelIds) ? args.removeLabelIds.map(String).join(", ") : ""}])`;
      return `${what} on ${ids.length} Gmail message(s): ${ids.join(", ") || "(none named)"}`;
    }
    case "gmail_send": {
      const to = gmailRecipients(args);
      return `Send email to ${to.join(", ") || "(no recipients named)"} — subject "${String(args.subject ?? "")}" (${String(args.body ?? "").length} chars)`;
    }
    case "gmail_reply": {
      const to = gmailRecipients(args);
      return `Reply in Gmail thread of message ${String(args.messageId ?? "?")} to ${to.length ? to.join(", ") : "the original sender"} — subject "${String(args.subject ?? "(thread subject)")}" (${String(args.body ?? "").length} chars)`;
    }
    case "gmail_block_sender":
      return `Block Gmail sender ${String(args.from ?? args.address ?? "?")} (their future mail skips the inbox and lands in spam)`;
    case "gmail_draft": {
      const to = gmailRecipients(args);
      return `Create a Gmail draft to ${to.join(", ") || "(no recipients named)"} — subject "${String(args.subject ?? "")}" (draft only, not sent)`;
    }
    default:
      return `Run ${tool} with ${canonicalize(args).slice(0, 200)}`;
  }
}

let counter = 0;

export class ApprovalEngine {
  private requests = new Map<string, ApprovalRequest>();
  private timer?: NodeJS.Timeout;

  /** Fired when a pending approval times out (the host settles the
   *  parked job failed-loudly and notifies the operator). */
  onExpire?: (req: ApprovalRequest) => void;

  constructor(
    private stateDir: string,
    private timeoutMs: () => number,
  ) {
    this.load();
    // Expiry sweep. Unref'd: it must never keep a process (or a test
    // run) alive on its own.
    this.timer = setInterval(() => this.sweepExpired(), 250);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private storePath(): string {
    return `${this.stateDir}/approvals.jsonl`;
  }

  private load(): void {
    if (!existsSync(this.storePath())) return;
    for (const line of readFileSync(this.storePath(), "utf8").split("\n")) {
      if (!line) continue;
      const rec = JSON.parse(line) as ApprovalRequest;
      this.requests.set(rec.id, rec);
    }
  }

  private persist(rec: ApprovalRequest): void {
    appendFileSync(this.storePath(), JSON.stringify(rec) + "\n");
  }

  private transition(rec: ApprovalRequest, status: ApprovalStatus, resolvedBy?: string): ApprovalRequest {
    rec.status = status;
    if (status !== "pending") rec.resolvedAt = Date.now();
    if (resolvedBy) rec.resolvedBy = resolvedBy;
    this.persist(rec);
    return rec;
  }

  /** Create a pending approval for a parked call. One pending approval
   *  per job: a job parks on exactly one tool call at a time. */
  create(input: {
    jobId: string;
    conversationId: string;
    tool: string;
    args: Record<string, unknown>;
    reason: string;
  }): ApprovalRequest {
    for (const r of this.requests.values()) {
      if (r.jobId === input.jobId && r.status === "pending") {
        throw new Error(`job ${input.jobId} already has a pending approval ${r.id}`);
      }
    }
    const args = screenArgs(input.args);
    const now = Date.now();
    const rec: ApprovalRequest = {
      id: `appr_${now.toString(36)}_${(counter++).toString(36)}${Math.floor(Math.random() * 1e4)}`,
      jobId: input.jobId,
      conversationId: input.conversationId,
      tool: input.tool,
      args,
      argsHash: argsHashFor(input.tool, args),
      summary: describeAction(input.tool, args),
      reason: input.reason,
      status: "pending",
      createdAt: now,
      expiresAt: now + this.timeoutMs(),
    };
    this.requests.set(rec.id, rec);
    this.persist(rec);
    return rec;
  }

  get(id: string): ApprovalRequest | undefined {
    this.sweepExpired();
    return this.requests.get(id);
  }

  pendingForJob(jobId: string): ApprovalRequest | undefined {
    this.sweepExpired();
    for (const r of this.requests.values()) {
      if (r.jobId === jobId && r.status === "pending") return r;
    }
    return undefined;
  }

  /** All currently-pending approvals, oldest first (Phase 4: the
   *  panel's queue surface — the same records the channel shows). */
  pending(): ApprovalRequest[] {
    this.sweepExpired();
    return [...this.requests.values()]
      .filter((r) => r.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** True while any approval is awaiting the operator. Phase 3: part
   *  of the Updater's idle gate — an update never starts while an
   *  approval is parked. */
  hasPending(): boolean {
    this.sweepExpired();
    for (const r of this.requests.values()) {
      if (r.status === "pending") return true;
    }
    return false;
  }

  /**
   * The replay/forge check: an executable approval exists ONLY if a
   * request for this job+tool is in `approved` state AND its recorded
   * hash equals the hash of the arguments about to run. Anything else —
   * different arguments, a consumed approval, another job's approval —
   * returns undefined and the call must be re-requested.
   */
  findExecutable(jobId: string, tool: string, args: Record<string, unknown>): ApprovalRequest | undefined {
    this.sweepExpired();
    const hash = argsHashFor(tool, screenArgs(args));
    for (const r of this.requests.values()) {
      if (r.jobId === jobId && r.tool === tool && r.status === "approved" && r.argsHash === hash) {
        return r;
      }
    }
    return undefined;
  }

  /** Operator resolution (channel button or command ONLY — this method
   *  is reachable exclusively from the ChannelHost). */
  resolve(id: string, decision: "approved" | "denied", resolvedBy: string): ApprovalRequest {
    this.sweepExpired();
    const rec = this.requests.get(id);
    if (!rec) throw new Error(`unknown approval ${id}`);
    if (rec.status === "expired") throw new Error(`approval ${id} has expired — timeout is a denial`);
    if (rec.status !== "pending") throw new Error(`approval ${id} is already ${rec.status}`);
    return this.transition(rec, decision, resolvedBy);
  }

  /** Mark an approved request consumed. Called BEFORE execution starts,
   *  so a crash mid-execution can never make it reusable. */
  consume(id: string): ApprovalRequest {
    const rec = this.requests.get(id);
    if (!rec) throw new Error(`unknown approval ${id}`);
    if (rec.status !== "approved") throw new Error(`approval ${id} is ${rec.status}, not approved`);
    return this.transition(rec, "consumed", rec.resolvedBy);
  }

  /** Expire every pending approval past its deadline. Timeout = deny. */
  sweepExpired(now: number = Date.now()): void {
    for (const rec of this.requests.values()) {
      if (rec.status === "pending" && rec.expiresAt <= now) {
        this.transition(rec, "expired", "timeout");
        this.onExpire?.(rec);
      }
    }
  }
}
