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
  | "task" // v0.14.1: an execution task — carry the request OUT with tools, step by step, instead of answering it. Declared by the requester (Bridge Inbox `kind` field); a routing label that buys execution framing on the runtime prompt, never an authority grant — sender gate, classifier, Governor and approvals treat it exactly like the same sender's chat job.
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
  /** v0.5.1: artifact post-conditions declared at submission
   *  (Bridge Inbox `deliverables`): absolute paths the job must
   *  create. At completion the control plane checks each one exists
   *  on disk; a missing deliverable settles the job failed-loudly
   *  with the path named, however convincing the reply text was.
   *  Absent = no artifact post-condition (the pre-v0.5.1 behavior). */
  deliverables?: string[];
  /** v0.9.8: this job is a live voice call's spoken turn AND its
   *  kind is plain chat — it runs in the voice fast lane (brevity
   *  note on the prompt, a clamped reply token budget at the
   *  provider, a steered primary + one-continuation shape in the
   *  runtime; a turn that actually invokes tools past that leaves
   *  the lane and takes the normal path). Stamped by the
   *  ChannelHost from the channel message's voiceTurn flag —
   *  never from message text. Absent = the ordinary lane. */
  voiceFastLane?: boolean;
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
  /** v0.10 (Memory Slice A): the context-pack manifest for this job
   *  — which pack profile was assembled, which sections went in
   *  (hashes and sizes, NEVER content), the estimated token cost,
   *  and the Shield scan receipt for the pack surface. Written by
   *  the control plane at injection time (context-pack.ts); absent
   *  when no pack applied (profile "none", or no pack wired). The
   *  manifest is the audit surface that replaces content logging:
   *  pack content itself is never written to any log. */
  contextManifest?: ContextManifest;
}

/** v0.10: which context-pack profile a job received (Context Pack
 *  spec §5). Selected by the control plane from the job's recorded
 *  origin and kind — never from anything the model or a message
 *  says. "none" is structural: approver-decision calls, canary and
 *  update jobs never carry a pack. */
export type ContextProfile =
  | "operator-full"
  | "delegate-limited"
  | "voice-compact"
  | "none";

/** v0.10: one section's entry in a job's context manifest. Hash +
 *  size only — the section's content never appears here. */
export interface ContextManifestSection {
  /** Section id: "identity" | "soul" | "operator" | "memory" |
   *  "projects" | "digest-pointers" (Slice C adds retrieved ids). */
  name: string;
  sha256: string;
  chars: number;
  /** False when the section was screened out before inclusion
   *  (secret-guard quarantine) or dropped by the budget. */
  included: boolean;
  /** The section's screened text tripped the secret-guard and was
   *  quarantined — excluded from the pack, warned in panel status. */
  quarantined?: boolean;
  /** The section was dropped whole to fit the pack budget
   *  (truncation happens at section boundaries, never mid-file). */
  truncated?: boolean;
}

/** v0.10: a job's context-pack manifest (Context Pack spec §6).
 *  Persisted on the job record; hashes/sizes/profile only. */
export interface ContextManifest {
  profile: ContextProfile;
  /** True when this assembly was the compact digest (hop ≥ 2)
   *  rather than the job's full pack. */
  digest: boolean;
  sections: ContextManifestSection[];
  /** Estimated tokens of the assembled pack (the same estimate the
   *  Governor reserved against — caps stay honest). */
  estTokens: number;
  /** Shield receipt ids for the pack's section scans, when the
   *  gate issued them. */
  scanReceiptIds: string[];
  assembledAt: number;
}
