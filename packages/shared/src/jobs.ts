/**
 * Job model (foundation spec §1.5). Every unit of work is a durable job in
 * the control plane. A job can only END in exactly one of three states —
 * verified-done, failed-loudly, needs-approval (parked). There is no fourth
 * outcome and no silent one; the type system enforces the terminal set and
 * the Job Runner enforces the transitions.
 */

export type JobState =
  | "queued"
  | "running"
  | "needs-approval"
  | "verified-done"
  | "failed-loudly";

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  "verified-done",
  "failed-loudly",
  // needs-approval is NOT terminal — it is a parked state that must resolve
  // to verified-done or failed-loudly. It is listed separately below.
]);

export const PARKED_STATES: ReadonlySet<JobState> = new Set(["needs-approval"]);

export function isSettled(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

export type JobKind =
  | "chat" // free-form operator message (Phase 0 surface)
  | "digest" // v1 job type 1 (Phase 1+)
  | "fetch-summarize" // v1 job type 2
  | "workspace-file" // v1 job type 3
  | "reminder" // v1 job type 4
  | "slow-demo" // Phase 0 drill vehicle: a long-running job for the kill test
  | "loop-demo" // Phase 2 drill vehicle: an unbounded paid-call loop for the runaway-cap test
  | "canary"
  | "update";

export interface JobRecord {
  id: string;
  kind: JobKind;
  state: JobState;
  /** sha256 of the (secret-guard-redacted) job input. Receipts carry this
   *  hash, never the content — the Agent-Shield Protocol discipline. */
  inputHash: string;
  /** v0.5: who submitted this job — the delegate's name when the
   *  ChannelHost stamped the input with its "[from <name>] " origin
   *  prefix, else "operator" (the operator, a legacy conversation,
   *  or a control-plane system job). Drives approval-delegation
   *  routing (approver-policy.ts). Absent on pre-v0.5 records,
   *  which read as "operator". */
  origin?: string;
  conversationId: string;
  createdAt: number;
  updatedAt: number;
  /** Plain-language outcome/reason. Screened before it is written. */
  outcomeNote?: string;
  /** Governor-metered cost in USD (0 for local/fake inference in Phase 0). */
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  receiptId?: string;
  /** Phase 4: real Agent-Shield receipt ids issued for this job's
   *  gated surfaces (inbound message, tool calls, tool results), in
   *  scan order. The full receipts live in gate.jsonl; these ids are
   *  the job's link to them. Absent when no scan applied. */
  shieldReceiptIds?: string[];
}
