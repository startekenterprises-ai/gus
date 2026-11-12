/**
 * Approval Engine (foundation spec §1.4) — Phase 2.
 *
 * Approvals are CONTROL-PLANE STATE: a durable append-only store in
 * <state>/approvals.jsonl, loaded on boot. They survive sandbox
 * restarts, control-plane restarts, and any amount of conversation
 * compaction BY CONSTRUCTION — the agent's context is not an input to
 * anything in this file. The runtime has no message type that can
 * create, resolve, extend, or forge an approval (see comm.ts); the
 * resolution inputs are channel events handled by the ChannelHost
 * (inline buttons, or /approve /deny commands from the operator) —
 * plus, since v0.5, agent approvers acting under the operator's
 * approver policy (approver-policy.ts): GUS's control-plane decision
 * in the CommServer, and named delegates through the same ChannelHost
 * path. Every such resolution is stamped on the record (resolvedBy +
 * agentResolution) so the audit trail never hides who answered.
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
import type { ApproverPolicy, ParkScopeClass } from "./approver-policy.js";

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
  /** How it was resolved: "channel-button" | "channel-command" | "timeout"
   *  for operator resolutions; "gus" or "delegate:<name>" when an agent
   *  approver resolved it under the approver policy (v0.5). */
  resolvedBy?: string;
  /** v0.5: stamped at creation when this park was routed to agent
   *  approvers under the approver policy (Permissive mode): the
   *  scope class that qualified it, and the delegate that submitted
   *  the job, if any. Absent = an operator-only park, as always
   *  before v0.5. The ChannelHost consults it (plus a fresh policy
   *  read) before letting a delegate resolve. */
  delegation?: { scopeClass: ParkScopeClass; originDelegate?: string };
  /** v0.5: set when an agent approver resolved this request — the
   *  approver-policy snapshot in force at the decision, and the
   *  approver's stated reason (for GUS, the decision model's own
   *  words). Operator resolutions never set it. */
  agentResolution?: { policy: ApproverPolicy; reason: string };
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
    // v0.9.5 (GitHub publish pack): the summary enumerates the exact
    // tag and both files — the publish equivalent of the Yue rule.
    case "github_publish_release":
      return (
        `Publish GUS release ${String(args.tag ?? "?")} to GitHub: upload ${String(args.dmgPath ?? "?")} ` +
        `and ${String(args.shaPath ?? "?")} to the ${String(args.tag ?? "?")} draft release and publish it ` +
        `(the vaulted "github" token is used inside the control plane — the agent never sees the value)`
      );
    case "gmail_draft": {
      const to = gmailRecipients(args);
      return `Create a Gmail draft to ${to.join(", ") || "(no recipients named)"} — subject "${String(args.subject ?? "")}" (draft only, not sent)`;
    }
    // Phase 7 (Mac pack): summaries name the exact app, target,
    // path, or command — an operator approving from a phone must be
    // able to see precisely what their tap will do on the Mac.
    case "mac.observe":
      return "Observe the Mac desktop (front app, window, focused element, accessibility text) — read-only";
    case "mac.click": {
      const target =
        typeof args.element === "string" && args.element
          ? `element "${args.element}"`
          : `point (${String(args.x ?? "?")}, ${String(args.y ?? "?")})`;
      return `Click ${target} on the Mac`;
    }
    case "mac.type": {
      const text = String(args.text ?? "");
      const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      return `Type ${text.length} chars into the focused Mac app: ${JSON.stringify(preview)}`;
    }
    case "mac.key":
      return `Press key "${String(args.combo ?? args.key ?? "?")}" on the Mac`;
    case "mac.scroll":
      return `Scroll ${String(args.direction ?? "?")} by ${String(args.amount ?? "?")} on the Mac`;
    case "mac.open_app":
      return `Open the app "${String(args.app ?? "?")}" on the Mac`;
    case "mac.focus_window":
      return `Focus ${typeof args.title === "string" && args.title ? `the window "${args.title}"` : `the app "${String(args.app ?? "?")}"`} on the Mac`;
    case "mac.fs.read":
      return `Read the Mac file "${String(args.path ?? "?")}"`;
    case "mac.fs.write":
      return `Write the Mac file "${String(args.path ?? "?")}" (${String(args.content ?? "").length} chars)`;
    case "mac.shell.run":
      return `Run a shell command on the Mac in ${String(args.cwd ?? "(default work dir)")}: ${String(args.command ?? "?")}`;
    case "mac.picker.select":
      return `Select "${String(args.path ?? "?")}" in the Mac file picker`;
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
    /** v0.5: the delegation routing facts, when this park was
     *  routed to agent approvers (approver-policy.ts). */
    delegation?: { scopeClass: ParkScopeClass; originDelegate?: string };
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
      ...(input.delegation ? { delegation: input.delegation } : {}),
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

  /** Recently-resolved approvals, newest first (v0.7: the desktop
   *  app's Approvals history — the same durable records, read back).
   *  Pending records are excluded; expiry is swept first so a record
   *  whose time ran out reads as expired, never as still waiting. */
  recentResolved(limit = 25): ApprovalRequest[] {
    this.sweepExpired();
    return [...this.requests.values()]
      .filter((r) => r.status !== "pending")
      .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt))
      .slice(0, Math.max(0, limit));
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

  /** Resolution. Operator resolutions arrive exclusively from the
   *  ChannelHost (channel button/command or the panel, which
   *  delegates to the host). Agent resolutions (v0.5) arrive from
   *  the two approver-policy paths — the CommServer's GUS decision
   *  and the ChannelHost's delegate gate — and MUST carry the
   *  agentResolution stamp (policy snapshot + reason), so an agent
   *  approval is never indistinguishable from the operator's. */
  resolve(
    id: string,
    decision: "approved" | "denied",
    resolvedBy: string,
    agentResolution?: { policy: ApproverPolicy; reason: string },
  ): ApprovalRequest {
    this.sweepExpired();
    const rec = this.requests.get(id);
    if (!rec) throw new Error(`unknown approval ${id}`);
    if (rec.status === "expired") throw new Error(`approval ${id} has expired — timeout is a denial`);
    if (rec.status !== "pending") throw new Error(`approval ${id} is already ${rec.status}`);
    if (agentResolution) rec.agentResolution = agentResolution;
    return this.transition(rec, decision, resolvedBy);
  }

  /** v0.5: how many approvals agent approvers have resolved since
   *  `sinceMs` — the approver policy's hourly rate budget is spent
   *  against this count, across GUS and delegates alike. */
  agentApprovalCountSince(sinceMs: number): number {
    let n = 0;
    for (const r of this.requests.values()) {
      if (r.agentResolution && typeof r.resolvedAt === "number" && r.resolvedAt >= sinceMs) n++;
    }
    return n;
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
