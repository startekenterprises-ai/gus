/**
 * The Gmail cleanup layer (MVP chunks 1–2, hardened in chunk 5) — the deterministic
 * overnight-cleanup engine that sits on top of the Phase 6 Gmail
 * pack (gmail.ts). It is NOT a model tool: the model has no path to
 * anything in this file. The operator decrees a rule file; this
 * engine applies it to mailbox metadata, archives exactly what a
 * dry run enumerated, and can restore a batch exactly from its
 * manifest. The scheduler that arms it overnight is chunk 3
 * (gmail-cleanup-scheduler.ts) — it rides these exact code paths
 * and ships disabled.
 *
 * How this coexists with the Yue hard line in policy.ts (bulk gmail
 * actions always park for a one-time approval enumerating exact
 * IDs): the cleanup never acts on a model's say-so. It executes
 * ONLY against an exact-ID manifest produced by a dry run under the
 * operator's standing rule file — the enumeration the hard line
 * exists to force, produced before anything is touched. Ad-hoc
 * agent bulk actions still park exactly as before.
 *
 * Guardrails, all code-level (each pinned by a test):
 *
 *  - Narrowed transport: the engine's interface exposes only
 *    search + get + modify. trash / deleteForever / send /
 *    createDraft are not reachable from this code path at all —
 *    never-delete and never-send are structural, not instructional.
 *  - Single allowed archive mutation: modify(id, [], ["INBOX"]),
 *    asserted in code before every call. Undo is its exact inverse:
 *    a modify back to the entry's captured prior label set, nothing
 *    else.
 *  - Manifest-required: archive refuses unless handed a dry-run
 *    manifest whose rule-file hash matches the CURRENT rule file,
 *    whose entry count is within the cap, and whose batch has not
 *    already run.
 *  - Nightly cap: GMAIL_CLEANUP_HARD_CAP (200) is a code constant.
 *    The rule file may lower it; nothing can raise it.
 *  - Exclusions win over rules, checked twice — at selection and
 *    again per message, on freshly fetched metadata, immediately
 *    before its modify: starred, IMPORTANT, unread-and-younger-
 *    than-7-days, never-archive senders, and known correspondents
 *    (unless the matching rule names that sender exactly).
 *  - No rule, no touch: a message matching no rule is invisible to
 *    the modify path.
 *  - Write-ahead manifest: the run manifest is on disk before the
 *    first modify and is updated as each entry verifies, so a crash
 *    mid-run still leaves an exact record — and undo — of what was
 *    touched.
 *  - Receipts: a settled run (and an undo) issues a receipt through
 *    the gate's LocalReceiptIssuer — the same local-stub HMAC
 *    pattern job settlement uses (jobs.ts), appended to
 *    <state>/receipts.jsonl, with the receipt's content hash bound
 *    to the manifest. These are tamper-evident local receipts, NOT
 *    Agent-Shield Protocol receipts; nothing here claims otherwise.
 *  - Tap-through (chunk 4): a settled batch's full record — every
 *    entry's exact message ID, rule, and captured prior label set,
 *    under the batch's job and receipt IDs — is readable back
 *    through cleanupBatchRecord below, surfaced by
 *    `gmail-admin cleanup show --batch <id>` and the panel's
 *    read-only GET /api/gmail-cleanup/batches/<id>. Read-only:
 *    neither surface can mutate anything.
 *
 * Chunk 5 (hardening) adds, without widening any surface above:
 *
 *  - Adversarial inputs fail closed, loudly: the rule file is
 *    size- and count-capped and must be finite throughout; a
 *    manifest that is unparseable, mislabelled, oversized, or
 *    names a message twice is CORRUPT — loads throw a named error
 *    instead of guessing, and the file is left untouched.
 *  - Manifest writes are atomic (tmp + rename, the scheduler-state
 *    pattern): a crash mid-save leaves the previous complete
 *    manifest — the write-ahead record is never torn.
 *  - Transient transport failures (Gmail 429/5xx, network errors)
 *    are retried with backoff. The archive modify is idempotent
 *    under retry: if a modify landed but its response was lost,
 *    the retry's fresh read sees INBOX already gone and stands
 *    down — a message is never archived twice, and the run
 *    manifest stays the single record of the batch.
 *  - Receipt integrity is checkable after the fact:
 *    verifyCleanupBatchReceipts re-verifies a batch's receipts
 *    against the local issuer's HMAC and the manifest-bound
 *    content hash (`gmail-admin cleanup verify --batch <id>`).
 *  - buildWeeklyCleanupSummary rolls the trailing 7 days of run
 *    manifests into the report's weekly line (chunk 5).
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { LocalReceiptIssuer, sha256Hex, type Receipt } from "@gus/gate";
import {
  gmailCredentialHealth,
  HttpGmailTransport,
  normalizeAddress,
  GMAIL_OAUTH_SECRET,
  type GmailDirectory,
  type GmailHttpFetch,
  type GmailMessage,
  type GmailMessageSummary,
  type GmailShieldScanner,
  type GmailTransport,
} from "./gmail.js";
import type { VaultBroker } from "@gus/vault";

// ------------------------------------------------------------------ rules

export interface GmailCleanupRule {
  name: string;
  /** Exact sender addresses (bare, lowercased). Naming a sender
   *  here is also what lifts the known-correspondent exclusion for
   *  that sender — and only for that sender. */
  from?: string[];
  /** Sender domains (lowercased, no "@"). */
  fromDomain?: string[];
  /** Labels the message must ALL carry (e.g. CATEGORY_PROMOTIONS). */
  labelIds?: string[];
  /** Message must be at least this many days old. */
  olderThanDays?: number;
  /** Default true: only read mail matches. false lets the rule take
   *  old unread mail too — the unread-and-recent exclusion still
   *  applies either way. */
  readOnly?: boolean;
}

export interface GmailCleanupRuleFile {
  version: 1;
  /** Operator-set nightly cap. The effective cap is
   *  min(this, GMAIL_CLEANUP_HARD_CAP) — code wins. */
  nightlyCap: number;
  /** Bare addresses or domains that are never archived, rule or no
   *  rule. */
  neverArchiveSenders: string[];
  rules: GmailCleanupRule[];
}

/** The code-level nightly cap. A runaway rule file can ask for
 *  more; it will never get it. */
export const GMAIL_CLEANUP_HARD_CAP = 200;

export const DEFAULT_CLEANUP_RULES: GmailCleanupRuleFile = {
  version: 1,
  nightlyCap: GMAIL_CLEANUP_HARD_CAP,
  neverArchiveSenders: [],
  rules: [],
};

export function effectiveCleanupCap(rules: GmailCleanupRuleFile): number {
  return Math.min(rules.nightlyCap, GMAIL_CLEANUP_HARD_CAP);
}

function fail(msg: string): never {
  throw new Error(`gmail cleanup rules: ${msg}`);
}

/** Adversarial-input limits for the rule file (chunk 5). The rule
 *  file is operator-authored, but it is also the one input that
 *  decides what gets archived — a bloated or pathological file
 *  must fail closed at load, not exhaust memory or quietly widen
 *  selection. The limits sit far above any sane hand-written file. */
export const MAX_CLEANUP_RULE_FILE_BYTES = 1_048_576;
export const MAX_CLEANUP_RULES = 256;
export const MAX_CLEANUP_LIST_ENTRIES = 1_000;
export const MAX_CLEANUP_RULE_STRING_CHARS = 512;

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function stringList(value: unknown, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(`${what} must be a list of strings`);
  }
  if (value.length > MAX_CLEANUP_LIST_ENTRIES) {
    fail(`${what} has ${value.length} entries — over the ${MAX_CLEANUP_LIST_ENTRIES}-entry limit; refusing to load an oversized rule file`);
  }
  for (const s of value as string[]) {
    if (s.length > MAX_CLEANUP_RULE_STRING_CHARS) {
      fail(`${what} holds a ${s.length}-character entry — over the ${MAX_CLEANUP_RULE_STRING_CHARS}-character limit`);
    }
  }
  // Duplicates carry no meaning for matching; collapse them so a
  // deeply duplicated list loads as its canonical self.
  return dedupe((value as string[]).map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** Load + validate the operator's rule file. A missing file is the
 *  empty default (no rules → nothing is ever selected). A malformed
 *  file throws loudly: a broken rule file must fail closed, never
 *  silently widen. The returned hash is over the file's exact bytes
 *  (or the canonical default), so ANY edit — even whitespace —
 *  invalidates manifests a dry run produced under it. */
export function loadCleanupRules(path: string): { rules: GmailCleanupRuleFile; hash: string; existed: boolean } {
  if (!existsSync(path)) {
    return { rules: structuredClone(DEFAULT_CLEANUP_RULES), hash: sha256Hex(JSON.stringify(DEFAULT_CLEANUP_RULES)), existed: false };
  }
  const size = statSync(path).size;
  if (size > MAX_CLEANUP_RULE_FILE_BYTES) {
    fail(`${path} is ${size} bytes — over the ${MAX_CLEANUP_RULE_FILE_BYTES}-byte limit; refusing to load an oversized rule file`);
  }
  const raw = readFileSync(path, "utf8");
  let parsed: Partial<GmailCleanupRuleFile>;
  try {
    parsed = JSON.parse(raw) as Partial<GmailCleanupRuleFile>;
  } catch {
    fail(`${path} is not valid JSON — refusing to guess`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${path} must hold a JSON object — refusing to guess`);
  }
  if (parsed.version !== undefined && parsed.version !== 1) fail(`unsupported version ${String(parsed.version)}`);
  const cap = parsed.nightlyCap ?? GMAIL_CLEANUP_HARD_CAP;
  if (!Number.isInteger(cap) || cap < 1) fail(`nightlyCap must be a positive integer, got ${String(parsed.nightlyCap)}`);
  const rawRules = parsed.rules ?? [];
  if (!Array.isArray(rawRules)) fail("rules must be a list");
  if (rawRules.length > MAX_CLEANUP_RULES) {
    fail(`${rawRules.length} rules — over the ${MAX_CLEANUP_RULES}-rule limit; refusing to load an oversized rule file`);
  }
  const rules: GmailCleanupRule[] = rawRules.map((r, i) => {
    if (!r || typeof r !== "object") fail(`rule #${i + 1} is not an object`);
    const rule = r as GmailCleanupRule;
    if (typeof rule.name !== "string" || !rule.name.trim()) fail(`rule #${i + 1} has no name`);
    const from = stringList(rule.from, `rule "${rule.name}" from`)?.map(normalizeAddress);
    const fromDomain = stringList(rule.fromDomain, `rule "${rule.name}" fromDomain`)?.map((d) => d.replace(/^@/, ""));
    const labelIds = stringList(rule.labelIds, `rule "${rule.name}" labelIds`)?.map((l) => l.toUpperCase());
    // Normalization can collapse distinct spellings into one
    // entry ("@x.com" and "x.com"); dedupe again after mapping.
    const fromD = from ? dedupe(from) : undefined;
    const fromDomainD = fromDomain ? dedupe(fromDomain) : undefined;
    const labelIdsD = labelIds ? dedupe(labelIds) : undefined;
    // JSON has no NaN/Infinity literals, but 1e999 parses to
    // Infinity — an age that can never (or always) match is a
    // broken rule, not a wide one: refuse it.
    if (rule.olderThanDays !== undefined && (typeof rule.olderThanDays !== "number" || !Number.isFinite(rule.olderThanDays) || rule.olderThanDays < 0)) {
      fail(`rule "${rule.name}" olderThanDays must be a finite number >= 0`);
    }
    if (rule.readOnly !== undefined && typeof rule.readOnly !== "boolean") fail(`rule "${rule.name}" readOnly must be a boolean`);
    if (!from?.length && !fromDomain?.length && !labelIds?.length && rule.olderThanDays === undefined) {
      fail(`rule "${rule.name}" names no criterion — a catch-all rule is exactly what the cap and exclusions exist to prevent; give it a sender, domain, label, or age`);
    }
    return {
      name: rule.name,
      ...(fromD?.length ? { from: fromD } : {}),
      ...(fromDomainD?.length ? { fromDomain: fromDomainD } : {}),
      ...(labelIdsD?.length ? { labelIds: labelIdsD } : {}),
      ...(rule.olderThanDays !== undefined ? { olderThanDays: rule.olderThanDays } : {}),
      ...(rule.readOnly !== undefined ? { readOnly: rule.readOnly } : {}),
    };
  });
  const names = new Set<string>();
  for (const r of rules) {
    if (names.has(r.name)) fail(`duplicate rule name "${r.name}" — per-rule counts and manifests key on names`);
    names.add(r.name);
  }
  return {
    rules: {
      version: 1,
      nightlyCap: cap,
      neverArchiveSenders: stringList(parsed.neverArchiveSenders, "neverArchiveSenders") ?? [],
      rules,
    },
    hash: sha256Hex(raw),
    existed: true,
  };
}

// ------------------------------------------------------------- matching

const DAY_MS = 86_400_000;
/** Unread mail younger than this is never archived, whatever the
 *  rules say. */
export const UNREAD_RECENT_DAYS = 7;

/** Milliseconds since the message's date, or null when the date
 *  header can't be parsed. Age-based checks treat null as "cannot
 *  prove it is old" and refuse the match/exclusion-lift. */
export function messageAgeMs(msg: { date: string }, now: number): number | null {
  const t = Date.parse(msg.date);
  return Number.isNaN(t) ? null : now - t;
}

/** Does this rule match this message's metadata? Pure and
 *  deterministic — the same function runs at selection and at the
 *  per-message re-verification before a modify. */
export function cleanupRuleMatches(rule: GmailCleanupRule, msg: GmailMessageSummary, now: number): boolean {
  if (rule.from?.length && !rule.from.includes(msg.from)) return false;
  if (rule.fromDomain?.length) {
    const domain = msg.from.split("@")[1] ?? "";
    if (!rule.fromDomain.includes(domain)) return false;
  }
  if (rule.labelIds?.length) {
    for (const l of rule.labelIds) if (!msg.labelIds.includes(l)) return false;
  }
  if (rule.olderThanDays !== undefined) {
    const age = messageAgeMs(msg, now);
    if (age === null || age < rule.olderThanDays * DAY_MS) return false;
  }
  if (rule.readOnly !== false && msg.labelIds.includes("UNREAD")) return false;
  return true;
}

export type CleanupExclusion = "starred" | "important" | "unread-recent" | "never-sender" | "known-correspondent";

/** Exported for the chunk-4 proposals scan (gmail-cleanup-
 *  proposals.ts), which applies the same never-archive test to
 *  messages no rule matched. */
export function neverSenderMatches(from: string, list: string[]): boolean {
  const domain = from.split("@")[1] ?? "";
  return list.some((entry) => entry === from || entry.replace(/^@/, "") === domain);
}

/** The code-level exclusions. They win over every rule; the only
 *  lift is the known-correspondent one, and only when the matching
 *  rule names that exact sender in its `from` list. */
export function cleanupExclusion(
  msg: GmailMessageSummary,
  ctx: { rules: GmailCleanupRuleFile; directory: GmailDirectory; matchingRule: GmailCleanupRule; now: number },
): CleanupExclusion | null {
  if (msg.labelIds.includes("STARRED")) return "starred";
  if (msg.labelIds.includes("IMPORTANT")) return "important";
  if (msg.labelIds.includes("UNREAD")) {
    const age = messageAgeMs(msg, ctx.now);
    if (age === null || age < UNREAD_RECENT_DAYS * DAY_MS) return "unread-recent";
  }
  if (neverSenderMatches(msg.from, ctx.rules.neverArchiveSenders)) return "never-sender";
  if (ctx.directory.isKnown(msg.from) && !(ctx.matchingRule.from ?? []).includes(msg.from)) {
    return "known-correspondent";
  }
  return null;
}

// ------------------------------------------------------- narrowed transport

/**
 * The ONLY mailbox surface the cleanup engine can see: search, get,
 * modify. There is no trash, no delete, no send, no draft on this
 * interface — a cleanup build physically cannot reach them through
 * here. GmailTransport satisfies this structurally; tests drive it
 * with the pack's mock behind a call recorder.
 */
export interface CleanupTransport {
  search(query: string, maxResults: number): Promise<GmailMessageSummary[]>;
  get(id: string): Promise<GmailMessage | null>;
  modify(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void>;
}

// ------------------------------------------------- transient failures

/**
 * Is this transport failure worth retrying? (Chunk 5.) Transient
 * means: Gmail rate-limit / server statuses (429, 500, 502, 503,
 * 504 — the HTTP transport names the status in its error text),
 * and network-layer failures (undici surfaces them as TypeError;
 * socket resets/timeouts carry a code). Everything else — a 400,
 * a 404-shaped refusal, a credential error — is final and fails
 * exactly as it did before retries existed.
 */
const TRANSIENT_HTTP_RE = /HTTP (429|500|502|503|504)\b/;
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN"]);

export function isTransientGmailError(e: unknown): boolean {
  if (e instanceof TypeError) return true; // fetch/network failure shape
  if (e instanceof Error) {
    if (TRANSIENT_HTTP_RE.test(e.message)) return true;
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  }
  return false;
}

// ------------------------------------------------------------------- plan

export interface CleanupPlanEntry {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  /** The message's label set as the dry run saw it. The archive
   *  pass re-captures it from a fresh fetch immediately before the
   *  modify — that fresh set is what undo restores. */
  priorLabelIds: string[];
  /** Name of the rule that selected this message. */
  rule: string;
}

export interface CleanupPlan {
  batchId: string;
  createdAt: number;
  ruleFileHash: string;
  cap: number;
  entries: CleanupPlanEntry[];
  byRule: Record<string, number>;
  /** Inbox messages examined. */
  scanned: number;
  /** Inbox messages matching no rule. */
  noRule: number;
  excluded: Record<CleanupExclusion, number>;
  /** Candidates the Shield gate blocked on their snippet — never
   *  selected, never shown. */
  withheld: number;
  /** Selected candidates beyond the cap — left for another night. */
  overCap: number;
  /** True when no Shield scanner was wired and snippets crossed
   *  unscanned (the GmailService precedent: noted, never silent). */
  shieldUnscanned: boolean;
}

// -------------------------------------------------------------- manifests

export interface CleanupDryRunManifest extends CleanupPlan {
  kind: "gmail-cleanup-dry-run";
}

export interface CleanupRunEntry extends CleanupPlanEntry {
  state: "pending" | "done" | "skipped-stale" | "failed";
  detail?: string;
  undone?: boolean;
}

export interface CleanupRunManifest {
  kind: "gmail-cleanup-run";
  batchId: string;
  jobId: string;
  receiptId?: string;
  startedAt: number;
  finishedAt?: number;
  ruleFileHash: string;
  cap: number;
  status: "running" | "verified-done" | "failed-loudly" | "undone";
  entries: CleanupRunEntry[];
  undoneAt?: number;
  undoJobId?: string;
  undoReceiptId?: string;
}

const BATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertBatchId(batchId: string): void {
  if (!BATCH_ID_RE.test(batchId) || batchId.includes("..")) {
    throw new Error(`invalid cleanup batch id "${batchId}"`);
  }
}

const RUN_ENTRY_STATES: ReadonlySet<string> = new Set(["pending", "done", "skipped-stale", "failed"]);

/** The manifest store: <state>/gmail-cleanup/. Dry-run manifests
 *  are `dry-<batchId>.json`; run manifests are `<batchId>.json`.
 *  Files are 0600 — they enumerate the operator's mail metadata.
 *
 *  Chunk 5 hardening: writes are atomic (tmp + rename, the
 *  scheduler-state pattern), so a crash mid-save leaves the
 *  previous complete manifest — the write-ahead record the whole
 *  design leans on is never torn. (A leftover `.tmp` is never
 *  promoted: it may itself be the torn one.) Reads validate: an
 *  absent file is null, but a present file that is unparseable,
 *  mislabelled, oversized, or names a message twice is CORRUPT
 *  and throws a named error — every consumer of a manifest is
 *  deciding what may be archived or restored, and none of them
 *  may guess. The corrupt file is left exactly as found. */
export class GmailCleanupManifestStore {
  constructor(private dir: string) {}

  private write(path: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  }

  private readManifest<T>(path: string, kind: "gmail-cleanup-dry-run" | "gmail-cleanup-run", batchId: string): T | null {
    if (!existsSync(path)) return null;
    const corrupt = (why: string): never => {
      throw new Error(`gmail cleanup: manifest at ${path} is corrupt (${why}) — refusing to guess; the file was left untouched`);
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      corrupt("not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) corrupt("top level is not an object");
    const m = parsed as Record<string, unknown>;
    if (m.kind !== kind) corrupt(`kind is ${JSON.stringify(m.kind)}, expected "${kind}"`);
    if (m.batchId !== batchId) corrupt(`it names batch ${JSON.stringify(m.batchId)}, not "${batchId}"`);
    if (typeof m.ruleFileHash !== "string" || !m.ruleFileHash) corrupt("ruleFileHash is missing");
    if (!Array.isArray(m.entries)) corrupt("entries is not a list");
    const entries: unknown[] = m.entries as unknown[];
    if (entries.length > GMAIL_CLEANUP_HARD_CAP) {
      corrupt(`${entries.length} entries exceeds the nightly hard cap of ${GMAIL_CLEANUP_HARD_CAP} — no cleanup run can have produced this`);
    }
    const seen = new Set<string>();
    entries.forEach((e, i) => {
      if (!e || typeof e !== "object" || Array.isArray(e)) corrupt(`entry #${i + 1} is not an object`);
      const entry = e as Record<string, unknown>;
      const id: unknown = entry.id;
      if (typeof id !== "string" || !id) corrupt(`entry #${i + 1} has no message id`);
      if (seen.has(id as string)) corrupt(`message id "${id as string}" appears twice — a real selection names each message once`);
      seen.add(id as string);
      if (kind === "gmail-cleanup-run" && (typeof entry.state !== "string" || !RUN_ENTRY_STATES.has(entry.state))) {
        corrupt(`entry "${id as string}" has unknown state ${JSON.stringify(entry.state)}`);
      }
    });
    return parsed as T;
  }

  dryRunPath(batchId: string): string {
    assertBatchId(batchId);
    return join(this.dir, `dry-${batchId}.json`);
  }

  runPath(batchId: string): string {
    assertBatchId(batchId);
    return join(this.dir, `${batchId}.json`);
  }

  saveDryRun(plan: CleanupPlan): string {
    const manifest: CleanupDryRunManifest = { kind: "gmail-cleanup-dry-run", ...plan };
    const path = this.dryRunPath(plan.batchId);
    this.write(path, manifest);
    return path;
  }

  loadDryRun(batchId: string): CleanupDryRunManifest | null {
    return this.readManifest<CleanupDryRunManifest>(this.dryRunPath(batchId), "gmail-cleanup-dry-run", batchId);
  }

  saveRun(run: CleanupRunManifest): string {
    const path = this.runPath(run.batchId);
    this.write(path, run);
    return path;
  }

  loadRun(batchId: string): CleanupRunManifest | null {
    return this.readManifest<CleanupRunManifest>(this.runPath(batchId), "gmail-cleanup-run", batchId);
  }

  /** Every run manifest in the store, for aggregate readers (the
   *  weekly summary). Per-file corruption is reported, not thrown:
   *  an aggregate must not let one bad file silence the rest, and
   *  the caller surfaces the corrupt names loudly. */
  listRuns(): { runs: CleanupRunManifest[]; corrupt: string[] } {
    const runs: CleanupRunManifest[] = [];
    const corrupt: string[] = [];
    if (!existsSync(this.dir)) return { runs, corrupt };
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith(".json") || name.startsWith("dry-")) continue;
      try {
        const run = this.loadRun(name.slice(0, -".json".length));
        if (run) runs.push(run);
      } catch {
        corrupt.push(name);
      }
    }
    return { runs, corrupt };
  }
}

// ------------------------------------------------- tap-through (chunk 4)

/**
 * One batch's full record — everything the morning report's batch
 * + receipt line stands for, resolved back to its evidence: the
 * run manifest's entries verbatim (exact message IDs, the rule
 * that took each one, the prior label set its archive captured,
 * the per-entry outcome), the batch's job and receipt IDs, and —
 * when the dry-run manifest is still on disk — the selection
 * context (what was scanned, left alone, excluded, withheld).
 * Built ONLY from the manifest store: a batch with no run
 * manifest has no record (null), and a missing dry-run manifest
 * reads as plan: null, reported as such rather than reconstructed.
 */
export interface CleanupBatchRecord {
  batchId: string;
  jobId: string;
  receiptId?: string;
  undoJobId?: string;
  undoReceiptId?: string;
  status: CleanupRunManifest["status"];
  startedAt: number;
  finishedAt?: number;
  undoneAt?: number;
  ruleFileHash: string;
  cap: number;
  counts: { total: number; done: number; failed: number; skippedStale: number; undone: number };
  plan: {
    createdAt: number;
    scanned: number;
    noRule: number;
    excluded: Record<CleanupExclusion, number>;
    withheld: number;
    overCap: number;
    byRule: Record<string, number>;
    shieldUnscanned: boolean;
  } | null;
  entries: CleanupRunEntry[];
}

export function cleanupBatchRecord(store: GmailCleanupManifestStore, batchId: string): CleanupBatchRecord | null {
  const run = store.loadRun(batchId);
  if (!run) return null;
  const plan = store.loadDryRun(batchId);
  return {
    batchId: run.batchId,
    jobId: run.jobId,
    ...(run.receiptId ? { receiptId: run.receiptId } : {}),
    ...(run.undoJobId ? { undoJobId: run.undoJobId } : {}),
    ...(run.undoReceiptId ? { undoReceiptId: run.undoReceiptId } : {}),
    status: run.status,
    startedAt: run.startedAt,
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.undoneAt !== undefined ? { undoneAt: run.undoneAt } : {}),
    ruleFileHash: run.ruleFileHash,
    cap: run.cap,
    counts: {
      total: run.entries.length,
      done: run.entries.filter((e) => e.state === "done").length,
      failed: run.entries.filter((e) => e.state === "failed").length,
      skippedStale: run.entries.filter((e) => e.state === "skipped-stale").length,
      undone: run.entries.filter((e) => e.undone).length,
    },
    plan: plan
      ? {
          createdAt: plan.createdAt,
          scanned: plan.scanned,
          noRule: plan.noRule,
          excluded: plan.excluded,
          withheld: plan.withheld,
          overCap: plan.overCap,
          byRule: plan.byRule,
          shieldUnscanned: plan.shieldUnscanned,
        }
      : null,
    entries: run.entries,
  };
}

/** The `cleanup show` rendering of a batch record. Deterministic:
 *  manifest order, ISO timestamps, no locale anywhere — the same
 *  record always prints the same text. */
export function formatCleanupBatchRecord(record: CleanupBatchRecord): string[] {
  const iso = (ts: number): string => new Date(ts).toISOString();
  const lines: string[] = [];
  lines.push(`gmail cleanup batch ${record.batchId}`);
  lines.push(`job: ${record.jobId}`);
  lines.push(`receipt: ${record.receiptId ?? "(none issued)"}`);
  lines.push(`status: ${record.status}`);
  lines.push(`started: ${iso(record.startedAt)}`);
  lines.push(`finished: ${record.finishedAt !== undefined ? iso(record.finishedAt) : "(not settled)"}`);
  lines.push(`rule file hash: ${record.ruleFileHash}`);
  lines.push(`nightly cap: ${record.cap}`);
  if (record.plan) {
    const ex = record.plan.excluded;
    const excludedTotal = Object.values(ex).reduce((a, b) => a + b, 0);
    lines.push(
      `selection: scanned ${record.plan.scanned} inbox messages; ${record.plan.noRule} matched no rule; ` +
        `${excludedTotal} excluded (starred ${ex.starred}, important ${ex.important}, unread<${UNREAD_RECENT_DAYS}d ${ex["unread-recent"]}, ` +
        `never-sender ${ex["never-sender"]}, known correspondent ${ex["known-correspondent"]})` +
        (record.plan.withheld ? `; ${record.plan.withheld} withheld by the Shield gate` : "") +
        (record.plan.overCap ? `; ${record.plan.overCap} over the cap` : "") +
        (record.plan.shieldUnscanned ? "; snippets crossed unscanned (no Shield scanner was wired)" : ""),
    );
  } else {
    lines.push("selection: (the dry-run manifest for this batch is not on disk — the run manifest below is the full record)");
  }
  const c = record.counts;
  lines.push(`outcome: ${c.done} archived, ${c.failed} failed, ${c.skippedStale} skipped-stale, ${c.undone} restored by undo — ${c.total} entries`);
  lines.push("entries:");
  if (record.entries.length === 0) lines.push("  (none)");
  for (const e of record.entries) {
    lines.push(
      `  ${e.id} | ${e.rule} | ${e.from} | ${e.subject} | ${e.date} | labels before: ${e.priorLabelIds.join(", ") || "(none)"} | ${e.state}` +
        `${e.undone ? " (undone)" : ""}${e.detail ? ` — ${e.detail}` : ""}`,
    );
  }
  if (record.undoneAt !== undefined) {
    lines.push(`undo: job ${record.undoJobId ?? "(unknown)"} • receipt ${record.undoReceiptId ?? "(none issued)"} • at ${iso(record.undoneAt)}`);
  }
  return lines;
}

// ------------------------------------------- receipt integrity (chunk 5)

export type CleanupReceiptCheckStatus =
  | "ok" // recorded receipt found in the log, signature valid, hash matches the manifest
  | "not-recorded" // the run issued no receipt (no sink was wired) — nothing claimed, nothing to check
  | "not-run" // undo only: the batch has not been undone
  | "missing" // the manifest names a receipt the log does not hold
  | "bad-signature" // the log's receipt fails the issuer's HMAC check
  | "hash-mismatch"; // the receipt verifies but is not bound to THIS manifest

export interface CleanupReceiptCheck {
  status: CleanupReceiptCheckStatus;
  receiptId?: string;
  detail: string;
}

export interface CleanupReceiptVerification {
  batchId: string;
  ok: boolean;
  archive: CleanupReceiptCheck;
  undo: CleanupReceiptCheck;
  /** Non-fatal observations (e.g. torn lines elsewhere in the
   *  shared receipts log) — reported, never silently dropped. */
  warnings: string[];
}

/** The exact content hash the archive path bound into its
 *  receipt — recomputed here from the settled manifest. Undo
 *  mutates entries (undone flags, details) but never the id /
 *  rule / state triple this hash covers, so it stays checkable
 *  for the batch's whole life. */
function archiveReceiptContentHash(run: CleanupRunManifest): string {
  return sha256Hex(
    JSON.stringify({
      batchId: run.batchId,
      jobId: run.jobId,
      ruleFileHash: run.ruleFileHash,
      entries: run.entries.map((e) => ({ id: e.id, rule: e.rule, state: e.state })),
    }),
  );
}

/** The undo receipt's content hash, as the undo path computed it
 *  at issue time. Checkable against the LATEST undo receipt (the
 *  one the manifest records): a resumed undo restores more
 *  entries and re-issues, superseding the earlier receipt. */
function undoReceiptContentHash(run: CleanupRunManifest): string {
  return sha256Hex(
    JSON.stringify({
      batchId: run.batchId,
      undoOfReceiptId: run.receiptId ?? null,
      restoredIds: run.entries.filter((e) => e.undone).map((e) => e.id),
    }),
  );
}

/**
 * Verify a settled batch's receipts after the fact: each receipt
 * the manifest names must be present in the receipts log, carry a
 * valid HMAC from the local issuer, and be bound by its content
 * hash to this exact manifest. This is the integrity check the
 * local-stub receipt pattern supports — per-receipt HMAC plus
 * manifest binding (the stub scheme has no cross-receipt chain;
 * when the gate's real receipts land, this is the seam they plug
 * into). Read-only: nothing here touches the mailbox or the log.
 */
export function verifyCleanupBatchReceipts(
  store: GmailCleanupManifestStore,
  batchId: string,
  sink: CleanupReceiptSink,
): CleanupReceiptVerification | null {
  const run = store.loadRun(batchId);
  if (!run) return null;

  const warnings: string[] = [];
  const byId = new Map<string, Receipt>();
  if (existsSync(sink.logPath)) {
    const lines = readFileSync(sink.logPath, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const r = JSON.parse(line) as Receipt;
        if (r && typeof r.receiptId === "string") byId.set(r.receiptId, r);
      } catch {
        warnings.push(
          `receipts log line ${i + 1} is not valid JSON (a torn append?) — it names no batch, so it cannot be attributed; the log wants a look`,
        );
      }
    });
  }

  const check = (
    role: "archive" | "undo",
    recordedId: string | undefined,
    jobId: string,
    expectedHash: string,
  ): CleanupReceiptCheck => {
    if (!recordedId) {
      return role === "undo" && run.status !== "undone" && !run.undoReceiptId
        ? { status: "not-run", detail: "the batch has not been undone — no undo receipt exists to check" }
        : { status: "not-recorded", detail: `no ${role} receipt was recorded for this batch (the run settled without a receipt sink)` };
    }
    const receipt = byId.get(recordedId);
    if (!receipt) {
      return {
        status: "missing",
        receiptId: recordedId,
        detail: `the manifest names ${role} receipt ${recordedId}, but the receipts log does not hold it — the log was truncated, or the receipt was never appended`,
      };
    }
    if (!sink.issuer.verify(receipt)) {
      return {
        status: "bad-signature",
        receiptId: recordedId,
        detail: `${role} receipt ${recordedId} fails the issuer's signature check — the log entry was altered after issue`,
      };
    }
    if (receipt.jobId !== jobId || receipt.contentHash !== expectedHash) {
      return {
        status: "hash-mismatch",
        receiptId: recordedId,
        detail: `${role} receipt ${recordedId} verifies as a genuine receipt but is not bound to this manifest (job or content hash differs) — the manifest was altered after the run settled`,
      };
    }
    return { status: "ok", receiptId: recordedId, detail: `${role} receipt ${recordedId} verifies and is bound to this manifest` };
  };

  const archive = check("archive", run.receiptId, run.jobId, archiveReceiptContentHash(run));
  const undo = check("undo", run.undoReceiptId, `gmail-cleanup-undo-${batchId}`, undoReceiptContentHash(run));
  const okStatus = (s: CleanupReceiptCheckStatus): boolean => s === "ok" || s === "not-recorded" || s === "not-run";
  return { batchId, ok: okStatus(archive.status) && okStatus(undo.status), archive, undo, warnings };
}

/** The `cleanup verify` rendering. Deterministic, like the batch
 *  record's: the same store + log always print the same lines. */
export function formatCleanupReceiptVerification(v: CleanupReceiptVerification): string[] {
  const lines: string[] = [];
  lines.push(`gmail cleanup verify — batch ${v.batchId}: ${v.ok ? "OK" : "FAILED"}`);
  lines.push(`  archive: [${v.archive.status}] ${v.archive.detail}`);
  lines.push(`  undo: [${v.undo.status}] ${v.undo.detail}`);
  for (const w of v.warnings) lines.push(`  warning: ${w}`);
  return lines;
}

// --------------------------------------------- weekly summary (chunk 5)

export interface CleanupWeeklySummary {
  /** Run manifests settled in the trailing 7 days. */
  batches: number;
  /** Entries those batches archived and have not since restored. */
  archived: number;
  /** Of those batches, how many have been undone. */
  undoneBatches: number;
  /** Entries across those batches that failed to archive. */
  failedEntries: number;
  /** Manifest files in the store that would not load — named in
   *  the store's corrupt list, counted here, never hidden. */
  corruptManifests: number;
  line: string;
}

/** Roll the trailing 7 days of run manifests into the morning
 *  report's weekly summary line (the plan's chunk 5). Built only
 *  from the manifest store, like every other report number. */
export function buildWeeklyCleanupSummary(store: GmailCleanupManifestStore, now: number): CleanupWeeklySummary {
  const { runs, corrupt } = store.listRuns();
  const since = now - 7 * DAY_MS;
  const week = runs.filter((r) => r.startedAt >= since && r.startedAt <= now);
  const archived = week.reduce((n, r) => n + r.entries.filter((e) => e.state === "done" && !e.undone).length, 0);
  const failedEntries = week.reduce((n, r) => n + r.entries.filter((e) => e.state === "failed").length, 0);
  const undoneBatches = week.filter((r) => r.status === "undone").length;
  const parts = [
    `${week.length} cleanup batch${week.length === 1 ? "" : "es"}`,
    `${archived} archived`,
  ];
  if (undoneBatches > 0) parts.push(`${undoneBatches} undone`);
  if (failedEntries > 0) parts.push(`${failedEntries} failed`);
  if (corrupt.length > 0) parts.push(`${corrupt.length} corrupt manifest${corrupt.length === 1 ? "" : "s"} skipped`);
  return {
    batches: week.length,
    archived,
    undoneBatches,
    failedEntries,
    corruptManifests: corrupt.length,
    line: `This week: ${parts.join(", ")}.`,
  };
}

// ------------------------------------------------------------------ engine

export interface CleanupReceiptSink {
  issuer: LocalReceiptIssuer;
  /** Appended to exactly like job settlement appends to
   *  <state>/receipts.jsonl (jobs.ts). */
  logPath: string;
}

export interface GmailCleanupEngineOpts {
  directory: GmailDirectory;
  shield?: GmailShieldScanner;
  now?: () => number;
  /** Injected in tests; production uses the clock + randomness. */
  batchId?: () => string;
  /** Chunk 5 retry plumbing: injected in tests so backoff costs
   *  no wall-clock; production sleeps for real. */
  sleep?: (ms: number) => Promise<void>;
  /** Total attempts per transport call before a transient failure
   *  is final. Default 4. */
  transientAttempts?: number;
  /** First backoff delay; doubles per attempt, capped at 8s.
   *  Default 250ms. */
  retryBaseMs?: number;
}

function defaultBatchId(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `cleanup-${stamp}-${randomBytes(2).toString("hex")}`;
}

export class GmailCleanupEngine {
  private now: () => number;
  private batchId: () => string;
  private sleep: (ms: number) => Promise<void>;
  private transientAttempts: number;
  private retryBaseMs: number;

  constructor(
    private transport: CleanupTransport,
    private opts: GmailCleanupEngineOpts,
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.batchId = opts.batchId ?? (() => defaultBatchId(this.now()));
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.transientAttempts = Math.max(1, opts.transientAttempts ?? 4);
    this.retryBaseMs = Math.max(0, opts.retryBaseMs ?? 250);
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.retryBaseMs * 2 ** (attempt - 1), 8_000);
  }

  /** Run a transport call, retrying transient failures with
   *  backoff. Non-transient failures throw on first sight, exactly
   *  as they did before retries existed. */
  private async withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!isTransientGmailError(e) || attempt >= this.transientAttempts) throw e;
        await this.sleep(this.backoffMs(attempt));
      }
    }
  }

  /** A fresh metadata read with transient retries — the only way
   *  the archive/undo paths read, so a rate-limited verify never
   *  masquerades as a vanished or unmoved message. */
  private async getFresh(id: string): Promise<GmailMessage | null> {
    return this.withTransientRetry(() => this.transport.get(id));
  }

  // ---------------------------------------------------------- chunk 1

  /**
   * Dry-run selection over real mailbox metadata. Reads only —
   * search is the sole transport call, so a dry run CANNOT change
   * the mailbox. Snippets pass the Shield inbound scan exactly as
   * gmail_search's do; a blocked message is withheld from selection.
   */
  async select(
    rules: GmailCleanupRuleFile,
    ruleFileHash: string,
    opts?: { scanLimit?: number },
  ): Promise<CleanupPlan> {
    const now = this.now();
    const batchId = this.batchId();
    const cap = effectiveCleanupCap(rules);
    const summaries = await this.withTransientRetry(() => this.transport.search("", opts?.scanLimit ?? 1000));
    const inbox = summaries.filter((m) => m.labelIds.includes("INBOX"));
    // Deterministic: oldest first (unparseable dates last), id as
    // the tiebreak — the cap then keeps the newest overflow, which
    // is the order a human cleaning by hand would choose.
    const sorted = [...inbox].sort((a, b) => {
      const ta = Date.parse(a.date);
      const tb = Date.parse(b.date);
      const ka = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
      const kb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
      return ka - kb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });

    const plan: CleanupPlan = {
      batchId,
      createdAt: now,
      ruleFileHash,
      cap,
      entries: [],
      byRule: {},
      scanned: sorted.length,
      noRule: 0,
      excluded: { starred: 0, important: 0, "unread-recent": 0, "never-sender": 0, "known-correspondent": 0 },
      withheld: 0,
      overCap: 0,
      shieldUnscanned: !this.opts.shield,
    };

    for (const msg of sorted) {
      const rule = rules.rules.find((r) => cleanupRuleMatches(r, msg, now));
      if (!rule) {
        plan.noRule++;
        continue;
      }
      const exclusion = cleanupExclusion(msg, { rules, directory: this.opts.directory, matchingRule: rule, now });
      if (exclusion) {
        plan.excluded[exclusion]++;
        continue;
      }
      if (plan.entries.length >= cap) {
        plan.overCap++;
        continue;
      }
      if (this.opts.shield) {
        const d = await this.opts.shield.scanSurface(
          "tool-result",
          `gmail-cleanup-${batchId}`,
          `From: ${msg.from}\nSubject: ${msg.subject}\n${msg.snippet}`,
        );
        if (d.action === "block") {
          plan.withheld++;
          continue;
        }
      }
      plan.entries.push({
        id: msg.id,
        threadId: msg.threadId,
        from: msg.from,
        subject: msg.subject,
        date: msg.date,
        priorLabelIds: [...msg.labelIds],
        rule: rule.name,
      });
      plan.byRule[rule.name] = (plan.byRule[rule.name] ?? 0) + 1;
    }
    return plan;
  }

  // ---------------------------------------------------------- chunk 2

  /** The single allowed archive mutation, asserted in code:
   *  archive is exactly "remove INBOX, add nothing". */
  private assertArchiveDelta(addLabelIds: string[], removeLabelIds: string[]): void {
    if (addLabelIds.length !== 0 || removeLabelIds.length !== 1 || removeLabelIds[0] !== "INBOX") {
      throw new Error(
        `gmail cleanup: refused a non-archive label delta (+[${addLabelIds.join(",")}] -[${removeLabelIds.join(",")}]) — the engine may only remove INBOX`,
      );
    }
  }

  private issueReceipt(sink: CleanupReceiptSink, jobId: string, state: string, contentHash: string): string {
    const receipt = sink.issuer.issue({ jobId, state, contentHash, costUsd: 0 });
    appendFileSync(sink.logPath, JSON.stringify(receipt) + "\n");
    return receipt.receiptId;
  }

  /**
   * The archive modify, retried on transient failures — and
   * idempotent under retry (chunk 5): the delta is remove-INBOX
   * only, so if a modify landed but its response was lost, the
   * retry's fresh read sees INBOX already gone and stands down
   * instead of modifying a second time. The run manifest stays
   * the single record of what the batch did; there is no path
   * here that archives a message twice.
   */
  private async modifyArchive(id: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.transport.modify(id, [], ["INBOX"]);
        return;
      } catch (e) {
        if (!isTransientGmailError(e) || attempt >= this.transientAttempts) throw e;
        const now = await this.getFresh(id);
        if (!now) throw new Error(`message ${id} vanished while its archive was being retried`);
        if (!now.labelIds.includes("INBOX")) return; // the modify landed; only its response was lost
        await this.sleep(this.backoffMs(attempt));
      }
    }
  }

  /**
   * Execute a batch — ONLY from the dry-run manifest named by
   * batchId. Refuses loudly, touching nothing, when: the manifest
   * doesn't exist, the rule file changed since the dry run, the
   * manifest holds more entries than the cap allows, or the batch
   * already ran. The run manifest is written BEFORE the first
   * modify (write-ahead) and re-saved as each entry verifies.
   */
  async archive(
    batchId: string,
    store: GmailCleanupManifestStore,
    current: { rules: GmailCleanupRuleFile; hash: string },
    receipts?: CleanupReceiptSink,
  ): Promise<CleanupRunManifest> {
    const plan = store.loadDryRun(batchId);
    if (!plan) {
      throw new Error(`gmail cleanup: no dry-run manifest for batch "${batchId}" — run a dry run first; the archive path executes only against one`);
    }
    if (plan.ruleFileHash !== current.hash) {
      throw new Error("gmail cleanup: the rule file changed since this dry run — the manifest no longer enumerates what current rules would select; re-run the dry run");
    }
    const cap = effectiveCleanupCap(current.rules);
    if (plan.entries.length > cap) {
      throw new Error(`gmail cleanup: manifest holds ${plan.entries.length} entries, over the nightly cap of ${cap} — refusing; this manifest was not produced under these rules`);
    }
    if (store.loadRun(batchId)) {
      throw new Error(`gmail cleanup: batch "${batchId}" has already been executed — refusing to run it twice (undo it, or dry-run a new batch)`);
    }

    const jobId = `gmail-cleanup-${batchId}`;
    const run: CleanupRunManifest = {
      kind: "gmail-cleanup-run",
      batchId,
      jobId,
      startedAt: this.now(),
      ruleFileHash: current.hash,
      cap,
      status: "running",
      entries: plan.entries.map((e) => ({ ...e, state: "pending" as const })),
    };
    store.saveRun(run); // write-ahead: on disk before anything is touched

    let failures = 0;
    for (const entry of run.entries) {
      try {
        const fresh = await this.getFresh(entry.id);
        if (!fresh) {
          entry.state = "failed";
          entry.detail = "message vanished before its archive — nothing was done to it";
          failures++;
          store.saveRun(run);
          continue;
        }
        // Exclusions and rule match are re-checked on the FRESH
        // metadata — no stale decisions cross the modify.
        const rule = current.rules.rules.find((r) => r.name === entry.rule);
        const stillSelected =
          rule !== undefined &&
          fresh.labelIds.includes("INBOX") &&
          cleanupRuleMatches(rule, fresh, this.now()) &&
          cleanupExclusion(fresh, { rules: current.rules, directory: this.opts.directory, matchingRule: rule, now: this.now() }) === null;
        if (!stillSelected) {
          entry.state = "skipped-stale";
          entry.detail = "no longer selected on fresh metadata (rule/exclusion state changed since the dry run) — left alone";
          store.saveRun(run);
          continue;
        }
        this.assertArchiveDelta([], ["INBOX"]);
        await this.modifyArchive(entry.id);
        const after = await this.getFresh(entry.id);
        if (!after || after.labelIds.includes("INBOX")) {
          entry.state = "failed";
          entry.detail = "archive could not be verified — INBOX still present after the modify";
          failures++;
        } else {
          entry.state = "done";
          // The label set captured immediately before THIS modify
          // is the exact set undo restores.
          entry.priorLabelIds = [...fresh.labelIds];
        }
      } catch (e) {
        entry.state = "failed";
        entry.detail = e instanceof Error ? e.message : String(e);
        failures++;
      }
      store.saveRun(run);
    }

    run.status = failures > 0 ? "failed-loudly" : "verified-done";
    run.finishedAt = this.now();
    if (receipts) {
      run.receiptId = this.issueReceipt(
        receipts,
        jobId,
        run.status,
        sha256Hex(
          JSON.stringify({
            batchId: run.batchId,
            jobId: run.jobId,
            ruleFileHash: run.ruleFileHash,
            entries: run.entries.map((e) => ({ id: e.id, rule: e.rule, state: e.state })),
          }),
        ),
      );
    }
    store.saveRun(run);
    return run;
  }

  /**
   * Restore one entry to its captured prior label set, retrying
   * transient failures (chunk 5). The label delta is recomputed
   * from a FRESH read on every attempt, which is what makes the
   * retry idempotent: if a modify landed but its response was
   * lost, the next attempt computes an empty delta and goes
   * straight to verification — the message is never modified
   * twice toward the same set, and never overshoots it.
   */
  private async restoreEntry(entry: CleanupRunEntry): Promise<"restored" | "vanished" | "unverified"> {
    const prior = new Set(entry.priorLabelIds);
    for (let attempt = 1; ; attempt++) {
      const fresh = await this.getFresh(entry.id);
      if (!fresh) return "vanished";
      const current = new Set(fresh.labelIds);
      const add = [...prior].filter((l) => !current.has(l));
      const remove = [...current].filter((l) => !prior.has(l));
      if (add.length > 0 || remove.length > 0) {
        try {
          await this.transport.modify(entry.id, add, remove);
        } catch (e) {
          if (!isTransientGmailError(e) || attempt >= this.transientAttempts) throw e;
          await this.sleep(this.backoffMs(attempt));
          continue; // recompute the delta from fresh state
        }
      }
      const after = await this.getFresh(entry.id);
      const restored =
        after !== null &&
        after.labelIds.length === prior.size &&
        after.labelIds.every((l) => prior.has(l));
      return restored ? "restored" : "unverified";
    }
  }

  /**
   * Restore a batch exactly: every done entry's label set is set
   * back to the prior set its archive captured — not merely "back
   * to inbox" (a message a Gmail filter had labelled keeps those
   * labels). Idempotent per entry and resumable: a partially
   * failed undo keeps its state and can be run again; a completed
   * undo refuses a second run.
   */
  async undo(
    batchId: string,
    store: GmailCleanupManifestStore,
    receipts?: CleanupReceiptSink,
  ): Promise<CleanupRunManifest> {
    const run = store.loadRun(batchId);
    if (!run) throw new Error(`gmail cleanup: no run manifest for batch "${batchId}" — nothing to undo`);
    if (run.status === "undone") throw new Error(`gmail cleanup: batch "${batchId}" is already undone`);
    if (run.status === "running") throw new Error(`gmail cleanup: batch "${batchId}" is still marked running — refusing to undo a batch whose run has not settled`);

    let failures = 0;
    for (const entry of [...run.entries].reverse()) {
      if (entry.state !== "done" || entry.undone) continue;
      try {
        const outcome = await this.restoreEntry(entry);
        if (outcome === "restored") {
          entry.undone = true;
        } else {
          entry.detail =
            outcome === "vanished"
              ? "message vanished before its undo — could not be restored"
              : "undo could not be verified — the label set does not match the manifest's prior set";
          failures++;
        }
      } catch (e) {
        entry.detail = e instanceof Error ? e.message : String(e);
        failures++;
      }
      store.saveRun(run);
    }

    if (failures === 0) {
      run.status = "undone";
      run.undoneAt = this.now();
    }
    if (receipts) {
      const undoJobId = `gmail-cleanup-undo-${batchId}`;
      run.undoJobId = undoJobId;
      run.undoReceiptId = this.issueReceipt(
        receipts,
        undoJobId,
        failures > 0 ? "failed-loudly" : "verified-done",
        sha256Hex(
          JSON.stringify({
            batchId,
            undoOfReceiptId: run.receiptId ?? null,
            restoredIds: run.entries.filter((e) => e.undone).map((e) => e.id),
          }),
        ),
      );
    }
    store.saveRun(run);
    return run;
  }
}

// ------------------------------------------------------------- operator CLI

export interface GmailCleanupAdminDeps {
  vault: VaultBroker;
  directory: GmailDirectory;
  stateDir: string;
  /** Injected in tests (the mock); production builds the live
   *  transport from the vault. */
  transport?: GmailTransport;
  shield?: GmailShieldScanner;
  http?: GmailHttpFetch;
  now?: () => number;
}

/** Display-only read of the chunk-3 scheduler's armed state for
 *  the status surface. The authoritative parser/validator lives
 *  in gmail-cleanup-scheduler.ts (which imports this module — the
 *  read here stays local to avoid the cycle); any problem reading
 *  the file reads as "off", which is also how the scheduler's own
 *  tick treats an unreadable config. */
function schedulerStatusLine(stateDir: string): string {
  const path = join(stateDir, "gmail-cleanup-scheduler.json");
  if (!existsSync(path)) {
    return "cleanup scheduler: off (default) — nothing runs overnight; arm it with: gmail-admin cleanup schedule enable --conversation <telegram chat id>";
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { enabled?: unknown; runAt?: unknown; reportAt?: unknown; conversationId?: unknown };
    if (raw.enabled === true) {
      return (
        `cleanup scheduler: ARMED — nightly run at ${typeof raw.runAt === "string" ? raw.runAt : "02:30"}, ` +
        `report at ${typeof raw.reportAt === "string" ? raw.reportAt : "07:00"}` +
        (typeof raw.conversationId === "string" && raw.conversationId ? ` to Telegram chat ${raw.conversationId}` : " — WARNING: no report conversation set")
      );
    }
    return "cleanup scheduler: off — nothing runs overnight; arm it with: gmail-admin cleanup schedule enable --conversation <telegram chat id>";
  } catch {
    return `cleanup scheduler: config at ${path} is unreadable — treated as off; see: gmail-admin cleanup schedule status`;
  }
}

/** Display-only read of the chunk-4 proposals file for the status
 *  surface. The authoritative store lives in gmail-cleanup-
 *  proposals.ts (which imports this module — the read here stays
 *  local to avoid the cycle, the schedulerStatusLine precedent);
 *  any problem reading the file surfaces as a pointer to the
 *  proposals surface, never as a guessed count. */
function pendingProposalsLine(stateDir: string): string {
  const path = join(stateDir, "gmail-cleanup-proposals.json");
  if (!existsSync(path)) {
    return "cleanup rule proposals: none pending — proposals appear after a cleanup cycle observes unmatched bulk senders";
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { proposals?: { status?: unknown }[] };
    const pending = Array.isArray(raw.proposals) ? raw.proposals.filter((p) => p?.status === "pending").length : 0;
    return `cleanup rule proposals: ${pending} pending — review with: gmail-admin cleanup proposals list`;
  } catch {
    return `cleanup rule proposals: the proposals file at ${path} is unreadable — see: gmail-admin cleanup proposals list`;
  }
}

function formatPlan(plan: CleanupPlan): string[] {
  const lines: string[] = [];
  lines.push(`would archive ${plan.entries.length}, by rule:`);
  const names = Object.keys(plan.byRule).sort();
  if (names.length === 0) lines.push("  (no rule matched anything)");
  for (const name of names) lines.push(`  • ${name} — ${plan.byRule[name]}`);
  const ex = plan.excluded;
  const excludedTotal = Object.values(ex).reduce((a, b) => a + b, 0);
  lines.push(
    `left alone: ${plan.noRule} matched no rule, ${excludedTotal} excluded ` +
      `(starred ${ex.starred}, important ${ex.important}, unread<${UNREAD_RECENT_DAYS}d ${ex["unread-recent"]}, ` +
      `never-sender ${ex["never-sender"]}, known correspondent ${ex["known-correspondent"]})` +
      (plan.withheld ? `, ${plan.withheld} withheld by the Shield gate` : "") +
      (plan.overCap ? `, ${plan.overCap} over the nightly cap of ${plan.cap}` : ""),
  );
  if (plan.shieldUnscanned) lines.push("note: no Shield scanner is wired in this process — snippets crossed unscanned");
  const sample = plan.entries.slice(0, 10).map((e) => e.id);
  if (sample.length) lines.push(`sample ids: ${sample.join(", ")}${plan.entries.length > sample.length ? ` … (+${plan.entries.length - sample.length} more in the manifest)` : ""}`);
  return lines;
}

/**
 * The cleanup operator surface, reached as
 * `node main.js gmail-admin cleanup <status|dry-run|archive|undo|show|verify>`.
 * (`gmail-admin cleanup schedule <...>` is the chunk-3 arming
 * surface and `gmail-admin cleanup proposals <...>` the chunk-4
 * proposals surface; main.ts routes those two to
 * gmail-cleanup-scheduler.ts and gmail-cleanup-proposals.ts.)
 * Deliberately operator-only: nothing in the agent's tool surface
 * routes here. archive/undo/show take an explicit --batch <id>
 * naming a manifest — there is no "archive whatever matches now"
 * command, by design.
 */
export async function runGmailCleanupAdmin(argv: string[], deps: GmailCleanupAdminDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const stateDir = deps.stateDir;
  const rulesPath = join(stateDir, "gmail-cleanup-rules.json");
  const store = new GmailCleanupManifestStore(join(stateDir, "gmail-cleanup"));
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  const buildEngine = (): GmailCleanupEngine | null => {
    if (!deps.transport && !deps.vault.has(GMAIL_OAUTH_SECRET)) {
      console.error("gmail cleanup: the Gmail pack is not set up — no gmail-oauth credential in the vault (see docs/gmail-pack.md)");
      return null;
    }
    // The full GmailTransport is narrowed to CleanupTransport at
    // this boundary — the engine never sees the wider surface.
    const transport: CleanupTransport = deps.transport ?? new HttpGmailTransport(deps.vault, deps.http);
    return new GmailCleanupEngine(transport, {
      directory: deps.directory,
      shield: deps.shield,
      now: deps.now,
    });
  };

  try {
    switch (cmd) {
      case "status": {
        const health = await gmailCredentialHealth(deps.vault, deps.http);
        console.log(`gmail pack: ${health.configured ? "configured (OAuth credential in the vault)" : "NOT configured — no gmail-oauth secret in the vault"}`);
        console.log(`OAuth health: ${health.healthy ? "OK — token exchange succeeded" : health.detail}`);
        const { rules, existed } = loadCleanupRules(rulesPath);
        console.log(
          `cleanup rules: ${existed ? `${rules.rules.length} rule(s) in ${rulesPath}` : `no rule file at ${rulesPath} — the empty default applies (nothing would be archived)`}; nightly cap ${effectiveCleanupCap(rules)} (hard cap ${GMAIL_CLEANUP_HARD_CAP})`,
        );
        console.log(schedulerStatusLine(stateDir));
        console.log(pendingProposalsLine(stateDir));
        return 0;
      }
      case "show": {
        // Chunk 4 tap-through: a pure manifest-store read — no
        // engine, no transport, no mailbox contact at all.
        const batchId = flag("--batch");
        if (!batchId) {
          console.error("usage: gmail-admin cleanup show --batch <batchId>");
          return 2;
        }
        const record = cleanupBatchRecord(store, batchId);
        if (!record) {
          console.error(`gmail cleanup: no run manifest for batch "${batchId}" — a batch record exists only once a dry run has been archived`);
          return 1;
        }
        for (const line of formatCleanupBatchRecord(record)) console.log(line);
        return 0;
      }
      case "verify": {
        // Chunk 5 receipt integrity: also a pure local read (the
        // manifest store + the receipts log + the issuer's key).
        // The key is only READ — a verify must never mint one, so
        // a missing key is a loud "nothing to verify against".
        const batchId = flag("--batch");
        if (!batchId) {
          console.error("usage: gmail-admin cleanup verify --batch <batchId>");
          return 2;
        }
        const keyPath = join(stateDir, "receipt-stub.key");
        if (!existsSync(keyPath)) {
          console.error("gmail cleanup: no receipt key in this state dir — no receipts were ever issued from it, so there is nothing to verify against");
          return 1;
        }
        const verification = verifyCleanupBatchReceipts(store, batchId, {
          issuer: new LocalReceiptIssuer(keyPath),
          logPath: join(stateDir, "receipts.jsonl"),
        });
        if (!verification) {
          console.error(`gmail cleanup: no run manifest for batch "${batchId}" — receipts exist only for batches that have been archived`);
          return 1;
        }
        for (const line of formatCleanupReceiptVerification(verification)) console.log(line);
        return verification.ok ? 0 : 1;
      }
      case "dry-run": {
        const engine = buildEngine();
        if (!engine) return 1;
        const { rules, hash } = loadCleanupRules(rulesPath);
        const plan = await engine.select(rules, hash);
        const path = store.saveDryRun(plan);
        console.log(`gmail cleanup dry-run — batch ${plan.batchId}`);
        for (const line of formatPlan(plan)) console.log(line);
        console.log(`manifest: ${path}`);
        console.log("nothing was changed in the mailbox");
        return 0;
      }
      case "archive": {
        const batchId = flag("--batch");
        if (!batchId) {
          console.error("usage: gmail-admin cleanup archive --batch <batchId> (from a dry run's manifest)");
          return 2;
        }
        const engine = buildEngine();
        if (!engine) return 1;
        const current = loadCleanupRules(rulesPath);
        const receipts: CleanupReceiptSink = {
          issuer: new LocalReceiptIssuer(join(stateDir, "receipt-stub.key")),
          logPath: join(stateDir, "receipts.jsonl"),
        };
        const run = await engine.archive(batchId, store, { rules: current.rules, hash: current.hash }, receipts);
        const done = run.entries.filter((e) => e.state === "done").length;
        const skipped = run.entries.filter((e) => e.state === "skipped-stale").length;
        const failed = run.entries.filter((e) => e.state === "failed").length;
        console.log(`gmail cleanup archive — batch ${run.batchId}: ${run.status}`);
        console.log(`archived ${done}, skipped-stale ${skipped}, failed ${failed}; receipt ${run.receiptId ?? "(none)"}`);
        console.log(`run manifest: ${store.runPath(run.batchId)}`);
        return run.status === "verified-done" ? 0 : 1;
      }
      case "undo": {
        const batchId = flag("--batch");
        if (!batchId) {
          console.error("usage: gmail-admin cleanup undo --batch <batchId>");
          return 2;
        }
        const engine = buildEngine();
        if (!engine) return 1;
        const receipts: CleanupReceiptSink = {
          issuer: new LocalReceiptIssuer(join(stateDir, "receipt-stub.key")),
          logPath: join(stateDir, "receipts.jsonl"),
        };
        const run = await engine.undo(batchId, store, receipts);
        const restored = run.entries.filter((e) => e.undone).length;
        console.log(`gmail cleanup undo — batch ${run.batchId}: ${run.status}`);
        console.log(`restored ${restored} message(s); undo receipt ${run.undoReceiptId ?? "(none)"}`);
        return run.status === "undone" ? 0 : 1;
      }
      default:
        console.error("usage: gmail-admin cleanup <status|dry-run|archive --batch <id>|undo --batch <id>|show --batch <id>|verify --batch <id>|schedule <status|enable|disable>|proposals <list|generate|accept <id>|reject <id>>>");
        return 2;
    }
  } catch (e) {
    console.error(`gmail-admin cleanup: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
