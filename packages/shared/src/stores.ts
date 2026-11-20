/**
 * Store interfaces — GUS v0.13.0, R1 groundwork (the Glennix
 * architecture's Shared Memory & Task Store seam).
 *
 * Why interfaces, and why now: until this slice, the memory files
 * and the job store each had exactly one reader/writer pair living
 * in the control plane — ContextPackStore read the context-pack
 * files for Slice A assembly, JobRunner owned jobs.jsonl. R1 turns
 * both into CONTRACTS so the code that USES them (the Memory Slice B
 * write loop, and later the hosted / cloud editions where the same
 * stores live behind a transport instead of on a local disk) depends
 * on the contract, not on the local file layout. The local
 * implementations ship in the same change (ContextPackStore
 * implements MemoryStore; JobRunner implements TaskStore) and are
 * byte-for-byte the stores v0.12.0 already ran — this is a seam,
 * not a migration: no file moves, no format changes, and a state
 * directory written by v0.12.0 opens unchanged (the migration test
 * pins exactly that).
 *
 * The two contracts are deliberately asymmetric, because the two
 * stores are:
 *
 *  - MemoryStore is a WRITE/READ contract over operator-owned
 *    content files. The files are the operator's words; the store
 *    moves text in and out and keeps the append-only candidate and
 *    event logs. It makes NO content decisions — screening,
 *    promotion rules, and forget semantics live in the Memory Write
 *    Service (control-plane/memory-write.ts), which is the only
 *    writer that goes through this contract for mutations. Keeping
 *    policy out of the store is what lets a future remote MemoryStore
 *    stay a dumb, auditable pipe.
 *
 *  - TaskStore is the JobRunner's existing public surface, typed.
 *    Jobs are control-plane state (transitions, receipts, caps
 *    accounting ride on them), so the contract is exactly the
 *    methods the runner already exposed — nothing widened, nothing
 *    renamed. Declaring it lets callers (and later, a second node
 *    coordinating over the shared task store) program against the
 *    interface while the runner keeps enforcing its transition
 *    rules underneath.
 *
 * Path safety is part of the MemoryStore contract, not an
 * implementation detail: every name/path a caller hands the store
 * is RELATIVE to the context directory, and an implementation must
 * refuse anything that would escape it (absolute paths, ".."
 * segments). The context files are operator data with standing
 * privacy weight (OPERATOR.md never crosses to delegates); a store
 * that happily resolved "../policy.json" would be a hole in that
 * boundary, so the guard is specified here where every future
 * implementation inherits the obligation.
 *
 * Candidate vocabulary note: Slice A shipped with "proposed" as the
 * initial candidate status and its tests pin that word. The R1 spec
 * draft said "pending"; the shipped vocabulary wins — the status
 * type below is "proposed" | "promoted" | "rejected", and
 * pendingCandidateCount() counts "proposed".
 */
import type {
  ContextManifest,
  JobKind,
  JobRecord,
  JobState,
} from "./jobs.js";

// ------------------------------------------------------------ memory

/** What kind of thing a memory candidate claims to be. The category
 *  drives promotion defaults (a "preference" promotes to OPERATOR.md,
 *  the rest to MEMORY.md) and panel flagging ("identity" candidates
 *  are surfaced specially — a change to who GUS is should never slip
 *  through as routine memory). Unknown categories from disk or from
 *  a caller are coerced to "fact" by implementations/services, never
 *  trusted as-is. */
export type MemoryCandidateCategory =
  | "fact"
  | "decision"
  | "preference"
  | "identity"
  | "project";

/** Candidate lifecycle: "proposed" on write, then exactly one
 *  operator decision line — "promoted" (the text landed in a core
 *  file) or "rejected". Status changes are NEW lines in
 *  candidates.jsonl; the latest line for an id wins. */
export type MemoryCandidateStatus = "proposed" | "promoted" | "rejected";

/** One memory candidate, fully resolved (latest line per id). The
 *  on-disk form is one JSON object per line in candidates.jsonl;
 *  implementations parse defensively — a torn or foreign line never
 *  produces a half-valid record here. */
export interface MemoryCandidate {
  id: string;
  /** Proposal time (ms epoch) from the candidate's first line. */
  ts: number;
  /** The job that proposed this candidate, when it came from a job. */
  jobId?: string;
  /** Who proposed it — a job origin ("operator", a delegate name)
   *  or "agent-self" for the agent's own proposals. Defaults to
   *  "agent-self" when a stored line omits it. */
  origin: string;
  category: MemoryCandidateCategory;
  /** The candidate text. Screened before it was stored — a stored
   *  candidate never carries a secret the guard would have caught. */
  text: string;
  /** Where the claim came from (a job summary, a file, a
   *  conversation) — provenance for the operator's promote/reject
   *  decision. Empty string when the proposer gave none. */
  source: string;
  status: MemoryCandidateStatus;
  /** Who decided ("operator", or "operator-forget" when a forget
   *  removed it). Present once a decision line exists. */
  decidedBy?: string;
  decidedAt?: number;
  /** For a promoted candidate: the core file the text landed in. */
  promotedTo?: string;
  /** The Shield receipt covering the proposal's scan, when the
   *  proposing surface was gated. */
  shieldReceiptId?: string;
}

/**
 * The write/read contract over the context-pack files (the files
 * under <stateDir>/context/: the five core .md files, daily notes
 * under memory/, the archive under archive/, candidates.jsonl, and
 * context-events.jsonl).
 *
 * Path rules (every implementation must enforce them):
 *  - readCoreFile / writeCoreFile / appendCoreText / fileStat take
 *    a name that is either a bare file name in the context root
 *    ("MEMORY.md") or a safe relative path under it
 *    ("memory/2026-11-17.md"). Absolute paths and any ".." segment
 *    are refused: reads answer null / a missing stat, writes throw.
 *    readCoreFile is the root-name convenience spelling;
 *    readContextFile is the explicit relative-path spelling. They
 *    resolve identically — there is one guarded resolver, not two.
 *  - appendArchiveText takes a BARE file name and always writes
 *    under archive/ — the archive is append-only by construction,
 *    so its helper accepts no path segments at all.
 */
export interface MemoryStore {
  /** Read a context file by bare name ("MEMORY.md"). Null when the
   *  file is absent or the name is unsafe. */
  readCoreFile(name: string): string | null;
  /** Read a context file by safe relative path
   *  ("memory/2026-11-17.md", "archive/forget-123.md"). Null when
   *  absent or the path would escape the context directory. */
  readContextFile(relPath: string): string | null;
  /** Append text to a context file (bare name or safe relative
   *  path), creating the file — and any parent directory — when
   *  absent. Append-only: existing bytes are never disturbed, which
   *  is what makes operator edits and the slots prefix checks safe. */
  appendCoreText(name: string, text: string): void;
  /** Replace a context file's whole content (bare name or safe
   *  relative path). Used by forget, which rewrites a file minus
   *  the removed lines; seeding and promotion never overwrite. */
  writeCoreFile(name: string, content: string): void;
  /** Append text to a file under context/archive/ (bare name only).
   *  The archive is where removed content goes to remain auditable
   *  without staying live. */
  appendArchiveText(name: string, text: string): void;
  /** All candidates, latest line per id wins, parsed defensively:
   *  a stored line counts only with a string id, a known status,
   *  and a string text; category is coerced to the enum (default
   *  "fact"), origin defaults to "agent-self", source to "". */
  listCandidates(): MemoryCandidate[];
  /** Append one raw line object to candidates.jsonl. The caller
   *  owns the shape (a full candidate, or a later status line for
   *  the same id); the store serializes and appends verbatim. */
  appendCandidateLine(line: Record<string, unknown>): void;
  /** How many candidates are still awaiting an operator decision
   *  (status "proposed"). */
  pendingCandidateCount(): number;
  /** Append one event to context-events.jsonl. The implementation
   *  stamps `ts` when the caller omits it. Events carry kinds,
   *  counts, and hashes — never content. */
  appendEvent(event: Record<string, unknown>): void;
  /** Daily-note file names currently under memory/ (names only,
   *  sorted). Content is read via readContextFile. */
  dailyNoteNames(): string[];
  /** Existence, size, and content hash for a context file (bare
   *  name or safe relative path). sha256 is present only when the
   *  file exists — the panel status surface and snapshot manifests
   *  are built from these. */
  fileStat(name: string): { name: string; exists: boolean; bytes: number; sha256?: string };
}

// ------------------------------------------------------------ tasks

/**
 * The JobRunner's public contract, typed. Signatures are the
 * runner's own (packages/control-plane/src/jobs.ts) — this interface
 * describes the store that already exists; it does not redesign it.
 * Settlement rules live in the implementation: only legal
 * transitions land, terminal jobs issue receipts, and outcome notes
 * are secret-guard screened before they persist.
 */
export interface TaskStore {
  create(
    kind: JobKind,
    conversationId: string,
    redactedInput: string,
    opts?: { deliverables?: string[]; voiceFastLane?: boolean },
  ): JobRecord;
  get(id: string): JobRecord | undefined;
  /** All jobs, newest first, capped at `limit` (default 200 in the
   *  local implementation). */
  list(limit?: number): JobRecord[];
  /** Most recent non-settled job for a conversation. */
  activeFor(conversationId: string): JobRecord | undefined;
  /** True while any job other than `exceptId` is unsettled. */
  hasActiveJobsExcept(exceptId: string): boolean;
  /** Settle jobs a previous incarnation left queued/running as
   *  failed-loudly; returns the records it settled. */
  sweepOrphanedJobs(opts?: { includeUpdateJobs?: boolean }): JobRecord[];
  /** Attach a real Agent-Shield receipt id to a job, durably. */
  noteShieldReceipt(id: string, shieldReceiptId: string): void;
  /** Record the context-pack manifest assembled for a job's latest
   *  model call (hashes/sizes/profile only — never content). */
  noteContextManifest(id: string, manifest: ContextManifest): void;
  transition(
    id: string,
    next: JobState,
    outcomeNote?: string,
    opts?: { shieldReceiptId?: string },
  ): JobRecord;
  addUsage(id: string, tokensIn: number, tokensOut: number, costUsd: number): void;
}
