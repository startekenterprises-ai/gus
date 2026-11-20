/**
 * The Gmail cleanup layer (MVP chunks 1–2) — the deterministic
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
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { LocalReceiptIssuer, sha256Hex } from "@gus/gate";
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

function stringList(value: unknown, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(`${what} must be a list of strings`);
  }
  return (value as string[]).map((s) => s.trim().toLowerCase()).filter(Boolean);
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
  const raw = readFileSync(path, "utf8");
  let parsed: Partial<GmailCleanupRuleFile>;
  try {
    parsed = JSON.parse(raw) as Partial<GmailCleanupRuleFile>;
  } catch {
    fail(`${path} is not valid JSON — refusing to guess`);
  }
  if (parsed.version !== undefined && parsed.version !== 1) fail(`unsupported version ${String(parsed.version)}`);
  const cap = parsed.nightlyCap ?? GMAIL_CLEANUP_HARD_CAP;
  if (!Number.isInteger(cap) || cap < 1) fail(`nightlyCap must be a positive integer, got ${String(parsed.nightlyCap)}`);
  const rawRules = parsed.rules ?? [];
  if (!Array.isArray(rawRules)) fail("rules must be a list");
  const rules: GmailCleanupRule[] = rawRules.map((r, i) => {
    if (!r || typeof r !== "object") fail(`rule #${i + 1} is not an object`);
    const rule = r as GmailCleanupRule;
    if (typeof rule.name !== "string" || !rule.name.trim()) fail(`rule #${i + 1} has no name`);
    const from = stringList(rule.from, `rule "${rule.name}" from`)?.map(normalizeAddress);
    const fromDomain = stringList(rule.fromDomain, `rule "${rule.name}" fromDomain`)?.map((d) => d.replace(/^@/, ""));
    const labelIds = stringList(rule.labelIds, `rule "${rule.name}" labelIds`)?.map((l) => l.toUpperCase());
    if (rule.olderThanDays !== undefined && (typeof rule.olderThanDays !== "number" || rule.olderThanDays < 0)) {
      fail(`rule "${rule.name}" olderThanDays must be a number >= 0`);
    }
    if (rule.readOnly !== undefined && typeof rule.readOnly !== "boolean") fail(`rule "${rule.name}" readOnly must be a boolean`);
    if (!from?.length && !fromDomain?.length && !labelIds?.length && rule.olderThanDays === undefined) {
      fail(`rule "${rule.name}" names no criterion — a catch-all rule is exactly what the cap and exclusions exist to prevent; give it a sender, domain, label, or age`);
    }
    return {
      name: rule.name,
      ...(from?.length ? { from } : {}),
      ...(fromDomain?.length ? { fromDomain } : {}),
      ...(labelIds?.length ? { labelIds } : {}),
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

function neverSenderMatches(from: string, list: string[]): boolean {
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

/** The manifest store: <state>/gmail-cleanup/. Dry-run manifests
 *  are `dry-<batchId>.json`; run manifests are `<batchId>.json`.
 *  Files are 0600 — they enumerate the operator's mail metadata. */
export class GmailCleanupManifestStore {
  constructor(private dir: string) {}

  private write(path: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  private read<T>(path: string): T | null {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
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
    const m = this.read<CleanupDryRunManifest>(this.dryRunPath(batchId));
    return m && m.kind === "gmail-cleanup-dry-run" && m.batchId === batchId ? m : null;
  }

  saveRun(run: CleanupRunManifest): string {
    const path = this.runPath(run.batchId);
    this.write(path, run);
    return path;
  }

  loadRun(batchId: string): CleanupRunManifest | null {
    const m = this.read<CleanupRunManifest>(this.runPath(batchId));
    return m && m.kind === "gmail-cleanup-run" && m.batchId === batchId ? m : null;
  }
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
}

function defaultBatchId(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `cleanup-${stamp}-${randomBytes(2).toString("hex")}`;
}

export class GmailCleanupEngine {
  private now: () => number;
  private batchId: () => string;

  constructor(
    private transport: CleanupTransport,
    private opts: GmailCleanupEngineOpts,
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.batchId = opts.batchId ?? (() => defaultBatchId(this.now()));
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
    const summaries = await this.transport.search("", opts?.scanLimit ?? 1000);
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
        const fresh = await this.transport.get(entry.id);
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
        await this.transport.modify(entry.id, [], ["INBOX"]);
        const after = await this.transport.get(entry.id);
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
        const fresh = await this.transport.get(entry.id);
        if (!fresh) {
          entry.detail = "message vanished before its undo — could not be restored";
          failures++;
          store.saveRun(run);
          continue;
        }
        const current = new Set(fresh.labelIds);
        const prior = new Set(entry.priorLabelIds);
        const add = [...prior].filter((l) => !current.has(l));
        const remove = [...current].filter((l) => !prior.has(l));
        if (add.length > 0 || remove.length > 0) {
          await this.transport.modify(entry.id, add, remove);
        }
        const after = await this.transport.get(entry.id);
        const restored =
          after !== null &&
          after.labelIds.length === prior.size &&
          after.labelIds.every((l) => prior.has(l));
        if (!restored) {
          entry.detail = "undo could not be verified — the label set does not match the manifest's prior set";
          failures++;
        } else {
          entry.undone = true;
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
 * `node main.js gmail-admin cleanup <status|dry-run|archive|undo>`.
 * (`gmail-admin cleanup schedule <...>` is the chunk-3 arming
 * surface; main.ts routes it to gmail-cleanup-scheduler.ts.)
 * Deliberately operator-only: nothing in the agent's tool surface
 * routes here. archive/undo take an explicit --batch <id> naming a
 * manifest — there is no "archive whatever matches now" command,
 * by design.
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
        return 0;
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
        console.error("usage: gmail-admin cleanup <status|dry-run|archive --batch <id>|undo --batch <id>|schedule <status|enable|disable>>");
        return 2;
    }
  } catch (e) {
    console.error(`gmail-admin cleanup: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
