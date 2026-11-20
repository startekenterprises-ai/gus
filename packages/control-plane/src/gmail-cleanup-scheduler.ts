/**
 * The Gmail cleanup scheduler (MVP chunk 3) — the overnight arm of
 * the cleanup engine in gmail-cleanup.ts. It adds exactly three
 * things to chunks 1–2 and nothing else:
 *
 *  1. A timer (the startHeartbeat / startLivenessBeat precedent:
 *     unref'd interval, boot check, never throws) that re-reads its
 *     config on every tick — arming or disarming lands without a
 *     restart, the delegates.json convention.
 *  2. The nightly cycle, which rides the chunks 1–2 code paths
 *     exactly: a FRESH dry-run selection (engine.select + the
 *     dry-run manifest it produces), then engine.archive against
 *     that run's own manifest, receipts through the same sink the
 *     operator CLI uses. There is no second archive implementation
 *     here and no new mailbox surface: the engine's narrowed
 *     transport (search/get/modify) is the only way this file can
 *     touch mail.
 *  3. The morning report: plain text built ONLY from the batch's
 *     manifests (the run manifest, plus its dry-run manifest for
 *     the left-alone counts), delivered through the channel host's
 *     notifyOperator — the existing Telegram send path. A failed
 *     cycle reports its failure plainly at report time instead of
 *     staying silent.
 *
 * Chunk 4 adds one rider to the cycle: after it settles, rule
 * proposals are generated from the senders it left unmatched
 * (gmail-cleanup-proposals.ts) — data for the operator to accept
 * or reject, never applied by the cycle itself.
 *
 * DEFAULT OFF. The config file (<state>/gmail-cleanup-scheduler
 * .json) ships absent, which means disabled; the timer ticks and
 * does nothing. Arming is an explicit operator action —
 * `gmail-admin cleanup schedule enable --conversation <chat id>` —
 * and the chunk-1 status surface reports the armed state. Nothing
 * in this file can archive a real mailbox without that enable step
 * plus the manifest flow: a tick with enabled:false makes no
 * transport calls at all (pinned by a test).
 *
 * Catch-up (the plan's "late beats never"): the tick compares
 * local wall-clock times against persisted state, not elapsed
 * intervals. A Mac that slept through 02:30 runs the cycle at its
 * first tick after wake; a report left undelivered by a sleep is
 * delivered before the next cycle overwrites it.
 *
 * Chunk 5 (hardening): the config save is atomic (tmp + rename),
 * the state load shape-checks every field, the multi-day-off
 * catch-up is pinned by tests (one combined cycle on wake, still
 * capped — never one run per missed day), and the morning report
 * gains the trailing-7-days weekly summary line, computed from
 * the manifest store like every other number in it.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { LocalReceiptIssuer } from "@gus/gate";
import {
  buildWeeklyCleanupSummary,
  GmailCleanupEngine,
  GmailCleanupManifestStore,
  loadCleanupRules,
  UNREAD_RECENT_DAYS,
  type CleanupPlan,
  type CleanupReceiptSink,
  type CleanupRunManifest,
  type CleanupTransport,
} from "./gmail-cleanup.js";
import {
  cleanupProposalsPath,
  generateCleanupProposals,
  GmailCleanupProposalStore,
} from "./gmail-cleanup-proposals.js";
import {
  HttpGmailTransport,
  GMAIL_OAUTH_SECRET,
  type GmailDirectory,
  type GmailHttpFetch,
  type GmailShieldScanner,
  type GmailTransport,
} from "./gmail.js";
import type { VaultBroker } from "@gus/vault";

// ------------------------------------------------------------------ config

export interface GmailCleanupSchedulerConfig {
  version: 1;
  /** The arming switch. Absent config = false. */
  enabled: boolean;
  /** Local "HH:MM" the nightly cycle starts at/after. */
  runAt: string;
  /** Local "HH:MM" the morning report goes out at/after. */
  reportAt: string;
  /** The operator's Telegram conversation the report is delivered
   *  to (via the channel host). Required to enable. */
  conversationId?: string;
}

export const DEFAULT_SCHEDULER_CONFIG: GmailCleanupSchedulerConfig = {
  version: 1,
  enabled: false,
  runAt: "02:30",
  reportAt: "07:00",
};

export function schedulerConfigPath(stateDir: string): string {
  return join(stateDir, "gmail-cleanup-scheduler.json");
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function assertHhMm(value: unknown, what: string): string {
  if (typeof value !== "string" || !HHMM_RE.test(value)) {
    throw new Error(`gmail cleanup scheduler: ${what} must be a 24h "HH:MM" time, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Load + validate the scheduler config. A missing file is the
 *  disabled default. A malformed file throws loudly — fail closed:
 *  the tick treats an unreadable config as OFF, and the operator
 *  surface surfaces the error instead of guessing an armed state. */
export function loadCleanupSchedulerConfig(stateDir: string): { config: GmailCleanupSchedulerConfig; existed: boolean } {
  const path = schedulerConfigPath(stateDir);
  if (!existsSync(path)) return { config: structuredClone(DEFAULT_SCHEDULER_CONFIG), existed: false };
  let parsed: Partial<GmailCleanupSchedulerConfig>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GmailCleanupSchedulerConfig>;
  } catch {
    throw new Error(`gmail cleanup scheduler: ${path} is not valid JSON — refusing to guess its armed state`);
  }
  if (parsed.version !== undefined && parsed.version !== 1) {
    throw new Error(`gmail cleanup scheduler: unsupported config version ${String(parsed.version)}`);
  }
  if (parsed.enabled !== undefined && typeof parsed.enabled !== "boolean") {
    throw new Error("gmail cleanup scheduler: enabled must be a boolean");
  }
  const config: GmailCleanupSchedulerConfig = {
    version: 1,
    enabled: parsed.enabled === true,
    runAt: assertHhMm(parsed.runAt ?? DEFAULT_SCHEDULER_CONFIG.runAt, "runAt"),
    reportAt: assertHhMm(parsed.reportAt ?? DEFAULT_SCHEDULER_CONFIG.reportAt, "reportAt"),
    ...(typeof parsed.conversationId === "string" && parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
  };
  return { config, existed: true };
}

export function saveCleanupSchedulerConfig(stateDir: string, config: GmailCleanupSchedulerConfig): string {
  const path = schedulerConfigPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  // Atomic (tmp + rename, the state pattern below): a crash mid-
  // save leaves the previous complete config, never a torn one
  // the next tick would have to treat as unreadable (chunk 5).
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return path;
}

// ------------------------------------------------------------------- state

export interface GmailCleanupPendingReport {
  /** Local YYYY-MM-DD the cycle belongs to. */
  date: string;
  /** Set when a run manifest exists for the batch. */
  batchId?: string;
  /** Set when the cycle failed before a run manifest could settle
   *  (or the pack was never set up): the plain failure detail the
   *  morning report carries. */
  failure?: string;
}

export interface GmailCleanupSchedulerState {
  version: 1;
  lastRunDate?: string;
  lastReportDate?: string;
  pendingReport?: GmailCleanupPendingReport;
}

function schedulerStatePath(stateDir: string): string {
  return join(stateDir, "gmail-cleanup-scheduler-state.json");
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** State is bookkeeping, not authority: a missing or malformed
 *  file reads as empty (worst case a cycle re-runs — and the
 *  engine itself refuses to execute the same batch twice).
 *  Chunk 5: the fields are shape-checked, not merely type-checked
 *  — dates must be real YYYY-MM-DD keys, and a pending report's
 *  fields are kept only when each is individually well-formed (a
 *  corrupt batchId is dropped, degrading that report to the plain
 *  failure shape rather than crashing its delivery). */
export function loadCleanupSchedulerState(stateDir: string): GmailCleanupSchedulerState {
  try {
    const raw = JSON.parse(readFileSync(schedulerStatePath(stateDir), "utf8")) as Partial<GmailCleanupSchedulerState>;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const state: GmailCleanupSchedulerState = { version: 1 };
      if (typeof raw.lastRunDate === "string" && DATE_KEY_RE.test(raw.lastRunDate)) state.lastRunDate = raw.lastRunDate;
      if (typeof raw.lastReportDate === "string" && DATE_KEY_RE.test(raw.lastReportDate)) state.lastReportDate = raw.lastReportDate;
      const pending = raw.pendingReport;
      if (pending && typeof pending === "object" && typeof pending.date === "string" && DATE_KEY_RE.test(pending.date)) {
        state.pendingReport = {
          date: pending.date,
          ...(typeof pending.batchId === "string" && pending.batchId ? { batchId: pending.batchId } : {}),
          ...(typeof pending.failure === "string" && pending.failure ? { failure: pending.failure } : {}),
        };
      }
      return state;
    }
  } catch {
    /* absent or malformed → empty state */
  }
  return { version: 1 };
}

export function saveCleanupSchedulerState(stateDir: string, state: GmailCleanupSchedulerState): void {
  const path = schedulerStatePath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path); // atomic, the liveness-beat pattern: no half-written state
}

// -------------------------------------------------------------- time helpers

/** Local YYYY-MM-DD — the "today" the run/report dates key on. */
export function localDateKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function dateFromKey(key: string): Date {
  const [y, m, d] = key.split("-").map((n) => Number(n));
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function parseHhMm(s: string): number {
  const [h, m] = s.split(":").map((n) => Number(n));
  return (h || 0) * 60 + (m || 0);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Fri Nov 21" — the report header's date, formatted by hand so
 *  it never depends on the host's locale data. */
export function formatReportDate(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// ------------------------------------------------------------ morning report

export interface CleanupReportInput {
  /** The report's date (the cycle's local day). */
  date: Date;
  /** The batch's run manifest, when one exists. */
  run?: CleanupRunManifest | null;
  /** The batch's dry-run manifest (left-alone counts), when one
   *  exists. */
  plan?: CleanupPlan | null;
  /** The cycle's failure detail, when it failed before a run
   *  manifest could settle. */
  failure?: string | null;
  /** Chunk 5: the trailing-7-days summary line
   *  (buildWeeklyCleanupSummary over the manifest store), when
   *  the caller computed one. Appended to the full report only —
   *  the one-line "nothing to archive" report keeps its shape. */
  weeklySummary?: string | null;
}

function leftAloneLine(plan: CleanupPlan): string {
  const ex = plan.excluded;
  const excludedTotal = Object.values(ex).reduce((a, b) => a + b, 0);
  return (
    `Left alone: ${plan.noRule} matched no rule, ${excludedTotal} excluded ` +
    `(starred ${ex.starred}, important ${ex.important}, unread<${UNREAD_RECENT_DAYS}d ${ex["unread-recent"]}, ` +
    `never-sender ${ex["never-sender"]}, known correspondent ${ex["known-correspondent"]})` +
    (plan.overCap ? `, ${plan.overCap} over the nightly cap of ${plan.cap}` : "")
  );
}

/**
 * Build the morning report from the batch's manifests — and only
 * from them: every number here is a manifest field or a count of
 * manifest entries, so the report can never claim more than the
 * run recorded. (Receipts named here are the gate's local-stub
 * HMAC receipts, hash-bound to the manifest — the honesty note in
 * docs/gmail-pack.md applies to this text too.)
 */
export function buildCleanupReport(input: CleanupReportInput): string {
  const header = `GUS overnight cleanup — ${formatReportDate(input.date)}`;
  const run = input.run ?? null;
  const plan = input.plan ?? null;

  if (!run) {
    // The cycle failed before a run manifest settled (pack not set
    // up, selection threw, …). Plain, loud, and explicit that
    // nothing was archived.
    return [
      header,
      `⚠️ The overnight cleanup FAILED: ${input.failure ?? "unknown error — see the control plane's runtime log"}`,
      "Nothing was archived. The next night retries on its own once the cause is fixed; a manual check is: gmail-admin cleanup status",
    ].join("\n");
  }

  const done = run.entries.filter((e) => e.state === "done");
  const failed = run.entries.filter((e) => e.state === "failed");
  const receipt = run.receiptId ?? "(none issued)";

  if (done.length === 0 && failed.length === 0) {
    // Nothing to archive — the whole report is one line.
    const left = plan ? ` — ${plan.scanned} in the inbox left alone` : "";
    return `${header}: nothing to archive${left}. Batch ${run.batchId} • Receipt ${receipt}`;
  }

  const lines: string[] = [header];
  if (done.length > 0) {
    const byRule = new Map<string, number>();
    for (const e of done) byRule.set(e.rule, (byRule.get(e.rule) ?? 0) + 1);
    const names = [...byRule.keys()].sort((a, b) => (byRule.get(b) ?? 0) - (byRule.get(a) ?? 0) || (a < b ? -1 : 1));
    lines.push(`Archived ${done.length} message${done.length === 1 ? "" : "s"} (${names.length} rule${names.length === 1 ? "" : "s"}):`);
    for (const name of names) lines.push(`• ${name} — ${byRule.get(name)}`);
  } else {
    lines.push("Archived 0 messages.");
  }
  if (plan) lines.push(leftAloneLine(plan));
  if (plan && plan.withheld > 0) {
    lines.push(`Shield: ${plan.withheld} message${plan.withheld === 1 ? "" : "s"} withheld from selection (injection patterns in their snippets)`);
  }
  if (failed.length > 0) {
    lines.push(`⚠️ ${failed.length} message${failed.length === 1 ? "" : "s"} could not be archived — the batch settled failed-loudly; details are in its manifest.`);
  }
  if (run.status === "undone") lines.push("Note: this batch has since been undone.");
  lines.push(`Batch ${run.batchId} • Receipt ${receipt}`);
  if (input.weeklySummary) lines.push(input.weeklySummary);
  if (done.length > 0) lines.push(`Undo: gmail-admin cleanup undo --batch ${run.batchId}`);
  return lines.join("\n");
}

// -------------------------------------------------------------------- cycle

export interface GmailCleanupSchedulerDeps {
  stateDir: string;
  vault: VaultBroker;
  directory: GmailDirectory;
  /** The existing Telegram send path: main.ts binds this to the
   *  channel host's notifyOperator. */
  notify: (conversationId: string, text: string) => Promise<void>;
  /** Injected in tests (the pack's mock); production builds the
   *  live transport from the vault. */
  transport?: GmailTransport;
  shield?: GmailShieldScanner;
  http?: GmailHttpFetch;
  now?: () => number;
  /** Tick interval; the production default is 15 minutes. */
  tickMs?: number;
  log?: (text: string) => void;
}

export interface CleanupCycleOutcome {
  batchId: string;
  run: CleanupRunManifest;
}

/** One nightly cycle, riding chunks 1–2 exactly: fresh dry-run
 *  selection → save its manifest → archive from that manifest.
 *  Throws (loudly) when the pack is not set up or selection fails;
 *  the tick turns a throw into the failure report. */
export async function runGmailCleanupCycle(deps: GmailCleanupSchedulerDeps): Promise<CleanupCycleOutcome> {
  const stateDir = deps.stateDir;
  if (!deps.transport && !deps.vault.has(GMAIL_OAUTH_SECRET)) {
    throw new Error("the Gmail pack is not set up — no gmail-oauth credential in the vault (see docs/gmail-pack.md)");
  }
  // The full GmailTransport is narrowed to CleanupTransport at
  // this boundary, exactly as the operator CLI narrows it — the
  // engine never sees the wider surface.
  const transport: CleanupTransport = deps.transport ?? new HttpGmailTransport(deps.vault, deps.http);
  const engine = new GmailCleanupEngine(transport, {
    directory: deps.directory,
    shield: deps.shield,
    now: deps.now,
  });
  const store = new GmailCleanupManifestStore(join(stateDir, "gmail-cleanup"));
  const { rules, hash } = loadCleanupRules(join(stateDir, "gmail-cleanup-rules.json"));
  const plan = await engine.select(rules, hash);
  store.saveDryRun(plan);
  const receipts: CleanupReceiptSink = {
    issuer: new LocalReceiptIssuer(join(stateDir, "receipt-stub.key")),
    logPath: join(stateDir, "receipts.jsonl"),
  };
  const run = await engine.archive(plan.batchId, store, { rules, hash }, receipts);
  // Chunk 4: rule proposals from what the cycle left unmatched.
  // Best-effort by design — the batch has already settled and
  // receipted, so a proposal failure logs loudly but never fails
  // the cycle; and a proposal itself changes nothing until the
  // operator accepts it (gmail-cleanup-proposals.ts).
  try {
    const pending = await generateCleanupProposals(
      transport,
      rules,
      new GmailCleanupProposalStore(cleanupProposalsPath(stateDir)),
      { directory: deps.directory, shield: deps.shield, now: deps.now },
    );
    if (pending.length > 0) {
      deps.log?.(
        `gmail cleanup scheduler: ${pending.length} cleanup rule proposal(s) pending — review with: gmail-admin cleanup proposals list`,
      );
    }
  } catch (e) {
    deps.log?.(`gmail cleanup scheduler: rule proposal generation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { batchId: plan.batchId, run };
}

async function deliverReport(
  deps: GmailCleanupSchedulerDeps,
  config: GmailCleanupSchedulerConfig,
  state: GmailCleanupSchedulerState,
  pending: GmailCleanupPendingReport,
): Promise<boolean> {
  const store = new GmailCleanupManifestStore(join(deps.stateDir, "gmail-cleanup"));
  const run = pending.batchId ? store.loadRun(pending.batchId) : null;
  const plan = pending.batchId ? store.loadDryRun(pending.batchId) : null;
  const text = buildCleanupReport({
    date: dateFromKey(pending.date),
    run,
    plan,
    failure: pending.failure ?? (pending.batchId && !run ? "the run manifest for this batch is missing" : null),
    weeklySummary: buildWeeklyCleanupSummary(store, (deps.now ?? (() => Date.now()))()).line,
  });
  if (!config.conversationId) {
    // Enabled without a destination can only happen via a hand
    // edit (enable requires one). Log loudly once and mark the
    // report handled — re-logging every tick would spam the log
    // without ever delivering anything.
    deps.log?.(`gmail cleanup scheduler: report for ${pending.date} NOT delivered — no conversation configured in ${schedulerConfigPath(deps.stateDir)}`);
    state.lastReportDate = pending.date;
    delete state.pendingReport;
    saveCleanupSchedulerState(deps.stateDir, state);
    return false;
  }
  await deps.notify(config.conversationId, text);
  state.lastReportDate = pending.date;
  delete state.pendingReport;
  saveCleanupSchedulerState(deps.stateDir, state);
  return true;
}

export interface SchedulerTickResult {
  ran: boolean;
  reported: boolean;
  detail: string;
}

/** One scheduler tick: deliver any stale pending report, run the
 *  cycle if it is due, deliver the fresh report if its window has
 *  come. Never throws — a broken config reads as OFF and a failed
 *  cycle becomes its failure report. Exported for tests. */
export async function gmailCleanupSchedulerTick(deps: GmailCleanupSchedulerDeps): Promise<SchedulerTickResult> {
  const now = new Date((deps.now ?? (() => Date.now()))());
  let config: GmailCleanupSchedulerConfig;
  try {
    config = loadCleanupSchedulerConfig(deps.stateDir).config;
  } catch (e) {
    return { ran: false, reported: false, detail: `scheduler config unreadable (${e instanceof Error ? e.message : String(e)}) — treated as off` };
  }
  if (!config.enabled) return { ran: false, reported: false, detail: "scheduler off" };

  const state = loadCleanupSchedulerState(deps.stateDir);
  const today = localDateKey(now);
  const nowMin = minutesOfDay(now);
  let ran = false;
  let reported = false;

  // 1. A report left undelivered (the Mac slept through its
  //    window) goes out before anything can overwrite it. A
  //    delivery failure leaves the report pending for the next
  //    tick — it is never marked sent on a failed send.
  if (state.pendingReport && state.lastReportDate !== state.pendingReport.date && nowMin >= parseHhMm(config.reportAt)) {
    try {
      reported = (await deliverReport(deps, config, state, state.pendingReport)) || reported;
    } catch (e) {
      deps.log?.(`gmail cleanup scheduler: report delivery failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. The nightly cycle, if today's hasn't run and its window
  //    has come (catch-up: any first tick at/after runAt).
  if (state.lastRunDate !== today && nowMin >= parseHhMm(config.runAt)) {
    try {
      const outcome = await runGmailCleanupCycle(deps);
      state.pendingReport = { date: today, batchId: outcome.batchId };
      deps.log?.(`gmail cleanup scheduler: cycle for ${today} settled ${outcome.run.status} (batch ${outcome.batchId})`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      state.pendingReport = { date: today, failure: detail };
      deps.log?.(`gmail cleanup scheduler: cycle for ${today} FAILED: ${detail}`);
    }
    state.lastRunDate = today;
    saveCleanupSchedulerState(deps.stateDir, state);
    ran = true;
  }

  // 3. The fresh report, if its window has come (a catch-up cycle
  //    that ran after reportAt reports in the same tick).
  if (state.pendingReport && state.lastReportDate !== state.pendingReport.date && nowMin >= parseHhMm(config.reportAt)) {
    try {
      reported = (await deliverReport(deps, config, state, state.pendingReport)) || reported;
    } catch (e) {
      deps.log?.(`gmail cleanup scheduler: report delivery failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { ran, reported, detail: ran || reported ? "cycle/report processed" : "enabled; nothing due" };
}

/** Start the cleanup scheduler: one tick at boot (the catch-up
 *  check), then every tickMs (default 15 min). The timer is
 *  unref'd — the scheduler never keeps a process alive. Ticks are
 *  serialized: a cycle that outlives the interval skips the next
 *  tick rather than overlapping itself. Returns a stop function. */
export function startGmailCleanupScheduler(deps: GmailCleanupSchedulerDeps): () => void {
  let inFlight = false;
  const tick = (): void => {
    if (inFlight) return;
    inFlight = true;
    gmailCleanupSchedulerTick(deps)
      .catch((e) => deps.log?.(`gmail cleanup scheduler: tick failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        inFlight = false;
      });
  };
  const boot = setTimeout(tick, 1_000);
  boot.unref();
  const timer = setInterval(tick, deps.tickMs ?? 15 * 60 * 1000);
  timer.unref();
  return () => {
    clearTimeout(boot);
    clearInterval(timer);
  };
}

// ------------------------------------------------------------- operator CLI

/**
 * The arming surface, reached as
 * `node main.js gmail-admin cleanup schedule <status|enable|disable>`.
 * Operator-only, like the rest of the cleanup CLI. Enable requires
 * a report conversation (the operator's Telegram chat id) — an
 * armed scheduler with nowhere to send the morning report would
 * fail silently every night, which is the one thing this design
 * refuses to do.
 */
export async function runGmailCleanupScheduleAdmin(argv: string[], deps: { stateDir: string }): Promise<number> {
  const [cmd, ...rest] = argv;
  const stateDir = deps.stateDir;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  try {
    switch (cmd) {
      case "status": {
        const { config, existed } = loadCleanupSchedulerConfig(stateDir);
        const state = loadCleanupSchedulerState(stateDir);
        console.log(
          config.enabled
            ? `cleanup scheduler: ARMED — nightly run at ${config.runAt}, report at ${config.reportAt} to Telegram chat ${config.conversationId ?? "(none set!)"}`
            : `cleanup scheduler: off${existed ? "" : " (no config file — the default)"} — nothing runs overnight`,
        );
        console.log(
          `last run: ${state.lastRunDate ?? "never"}; last report: ${state.lastReportDate ?? "never"}` +
            (state.pendingReport ? `; a report for ${state.pendingReport.date} is pending delivery` : ""),
        );
        return 0;
      }
      case "enable": {
        const { config } = loadCleanupSchedulerConfig(stateDir);
        const conversationId = flag("--conversation") ?? config.conversationId;
        if (!conversationId) {
          console.error("usage: gmail-admin cleanup schedule enable --conversation <telegram chat id> [--run-at HH:MM] [--report-at HH:MM]");
          console.error("the morning report needs a destination chat; the id is the conversation the operator talks to GUS in");
          return 2;
        }
        const next: GmailCleanupSchedulerConfig = {
          version: 1,
          enabled: true,
          runAt: assertHhMm(flag("--run-at") ?? config.runAt, "--run-at"),
          reportAt: assertHhMm(flag("--report-at") ?? config.reportAt, "--report-at"),
          conversationId,
        };
        const path = saveCleanupSchedulerConfig(stateDir, next);
        console.log(`cleanup scheduler: ARMED — nightly run at ${next.runAt}, report at ${next.reportAt} to Telegram chat ${conversationId}`);
        console.log(`config: ${path} (the running control plane picks this up on its next tick — no restart needed)`);
        return 0;
      }
      case "disable": {
        const { config } = loadCleanupSchedulerConfig(stateDir);
        const path = saveCleanupSchedulerConfig(stateDir, { ...config, enabled: false });
        console.log(`cleanup scheduler: off — nothing will run overnight (config kept at ${path})`);
        return 0;
      }
      default:
        console.error("usage: gmail-admin cleanup schedule <status|enable|disable>");
        return 2;
    }
  } catch (e) {
    console.error(`gmail-admin cleanup schedule: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
