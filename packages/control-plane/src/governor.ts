/**
 * Governor (foundation spec §1.2) — PHASE 2: complete.
 *
 * The Governor is the ONLY path to a model: the sandbox holds no provider
 * keys and has no network. Everything that can spend is decided HERE, in
 * the control plane, outside the model — the model is never asked to stop;
 * its calls are simply refused at the tool layer.
 *
 * Caps (all enforced BEFORE a call is issued):
 * - per-task, per-day, per-month ceilings, denominated in USD over a
 *   versioned per-model price table (cost per 1k tokens, in+out), with
 *   the Phase 0 token-denominated caps kept as a second, independent belt.
 * - Config lives in <state>/governor.json — control-plane state the
 *   sandbox cannot read, let alone write — and is re-read on every
 *   authorization, so an operator edit (panel/CLI) takes effect on the
 *   next call. A missing file means the conservative built-in defaults;
 *   a malformed file also falls back to the defaults (never to "no caps").
 * - Raising a cap is an operator action on that file. There is no
 *   runtime-facing path that can raise, bypass, or even read a cap.
 *
 * Ledger (append-only JSONL in control-plane state) — reservation model:
 *   reserve  — written BEFORE execution; holds the estimated cost
 *              against every cap, so concurrent/looping work cannot
 *              overshoot by racing settlements.
 *   settle   — written after execution with actual tokens and the exact
 *              priced cost. Reserves = settles + refunds, always.
 *   refund   — a reservation that never executed (provider failure, or
 *              a control-plane restart sweeping orphans) is refunded, so
 *              the ledger reconciles exactly: at any quiescent moment,
 *              #reserve == #settle + #refund and open reservations == 0.
 * The audit() method (and the operator CLI surface later) reports that
 * reconciliation; the Phase 2 runaway drill asserts it from the file.
 *
 * Kill switch: a persisted state file (Phase 0). While killed, every
 * authorization is refused and in-flight work is told to stop. The flag
 * is read from disk on boot and on every request; it survives restarts.
 *
 * Estimates: authorize() takes the caller's token estimate. The Phase 0
 * stub provider is deterministic, so the comm server computes the EXACT
 * tokens a call will use before authorizing (estimate == settlement,
 * which is what makes "the Governor cuts a runaway loop at the cap
 * exactly" a provable statement in the drill). Real providers (Phase 4)
 * will estimate from prompt + max_tokens budget; the interface — and the
 * guarantee that settled spend never exceeds a cap by more than one
 * in-flight reservation — is unchanged.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export interface GovernorConfig {
  /** Token-denominated hard cap per single job (Phase 0 belt, kept). */
  maxTokensPerJob: number;
  /** Token-denominated hard cap per UTC day across all jobs. */
  maxTokensPerDay: number;
  /** USD cap per single job/task. Undefined = no USD cap (Phase 0/1
   *  posture for the $0 local stub). */
  maxUsdPerTask?: number;
  /** USD cap per UTC day across all jobs. */
  maxUsdPerDay?: number;
  /** USD cap per UTC calendar month across all jobs. */
  maxUsdPerMonth?: number;
  /** Price table: USD per 1,000 tokens (in+out) by model name. */
  pricesUsdPer1k?: Record<string, number>;
  /** Fallback price for models not in the table. Default 0 (local). */
  defaultPriceUsdPer1k?: number;
}

export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  maxTokensPerJob: 20_000,
  maxTokensPerDay: 200_000,
};

/**
 * Built-in blended prices (USD per 1k tokens, in+out) for the Phase 4
 * provider classes, used only when the operator's price table doesn't
 * name the model — an operator entry always wins. Approximations of
 * the providers' published per-token prices, blended across input and
 * output; the operator can correct them in governor.json at any time
 * (the ledger prices history with the table in force at settle time).
 * Local inference (Ollama, anything "ollama/…" or "gateway/…" the
 * operator runs themselves) is $0 unless the operator prices it.
 */
export const BUILTIN_PRICES_USD_PER_1K: Record<string, number> = {
  "anthropic/claude-sonnet-5": 0.009,
  "anthropic/claude-haiku-4-5": 0.002,
  "openai/gpt-5": 0.009,
  "openai/gpt-5-mini": 0.0011,
  // Google's published paid-tier Gemini rates (ai.google.dev/gemini-api
  // /docs/pricing, checked 2026-11-03), blended in+out per 1k tokens
  // like the entries above: gemini-3.5-flash is $1.50 in / $9.00 out
  // per 1M tokens → (0.0015 + 0.009) / 2; gemini-3-flash-preview is
  // $0.50 / $3.00 per 1M → (0.0005 + 0.003) / 2. A free-tier AI Studio
  // key is charged $0 by Google within its limits — an operator on the
  // free tier can zero these in governor.json; the built-ins price the
  // paid rates so the caps stay honest if the key is ever on a paid
  // project.
  "gemini/gemini-3.5-flash": 0.00525,
  "gemini/gemini-3-flash-preview": 0.00175,
  // Meta's published Muse Spark rates (checked 2026-11-06), blended
  // in+out per 1k like the entries above: $1.25 in / $4.25 out per 1M
  // tokens → (0.00125 + 0.00425) / 2. Patch drafted by GUS himself
  // (night work, 2026-11-06) after the gap showed up as $0 metering
  // on the first Spark-powered install.
  "muse-spark-1.3": 0.00275,
};

export type LedgerEntry =
  | {
      kind: "reserve";
      id: string;
      ts: number;
      jobId: string;
      model: string;
      estTokens: number;
      estCostUsd: number;
    }
  | {
      kind: "settle";
      id: string; // reservation id
      ts: number;
      jobId: string;
      model: string;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
    }
  | {
      kind: "refund";
      id: string; // reservation id
      ts: number;
      jobId: string;
      reason: string;
    };

export type MeterDecision =
  | { ok: true; reservationId: string }
  | { ok: false; reason: "killed" | "cap_exceeded"; detail: string };

export interface LedgerAudit {
  reserves: number;
  settles: number;
  refunds: number;
  openReservations: number;
  settledUsd: number;
  /** reserves == settles + refunds && openReservations == 0 */
  reconciles: boolean;
}

let reservationCounter = 0;

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function monthStart(ts: number): number {
  const d = new Date(ts);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

export class Governor {
  /** When a config is passed explicitly (unit tests), it is used as-is.
   *  Otherwise the config is loaded from <state>/governor.json on every
   *  authorization (operator edits are live; missing/malformed = the
   *  conservative defaults). */
  private fixedConfig?: GovernorConfig;

  constructor(
    private stateDir: string,
    config?: GovernorConfig,
  ) {
    this.fixedConfig = config;
    this.sweepOrphanReservations();
  }

  // ------------------------------------------------------------ config

  private configPath(): string {
    return `${this.stateDir}/governor.json`;
  }

  config(): GovernorConfig {
    if (this.fixedConfig) return this.fixedConfig;
    try {
      if (existsSync(this.configPath())) {
        const parsed = JSON.parse(readFileSync(this.configPath(), "utf8")) as GovernorConfig;
        return { ...DEFAULT_GOVERNOR_CONFIG, ...parsed };
      }
    } catch {
      /* malformed operator config: fall through to conservative defaults */
    }
    return DEFAULT_GOVERNOR_CONFIG;
  }

  priceUsdPer1k(model: string, cfg: GovernorConfig = this.config()): number {
    return (
      cfg.pricesUsdPer1k?.[model] ??
      BUILTIN_PRICES_USD_PER_1K[model] ??
      cfg.defaultPriceUsdPer1k ??
      0
    );
  }

  costFor(model: string, tokensIn: number, tokensOut: number, cfg?: GovernorConfig): number {
    const c = cfg ?? this.config();
    return (this.priceUsdPer1k(model, c) * (tokensIn + tokensOut)) / 1000;
  }

  // ------------------------------------------------------------ kill switch

  private killPath(): string {
    return `${this.stateDir}/KILLED`;
  }

  isKilled(): boolean {
    return existsSync(this.killPath());
  }

  /** Operator action only (channel command / panel / local CLI). */
  setKilled(killed: boolean, by: string): void {
    if (killed) {
      writeFileSync(this.killPath(), `${new Date().toISOString()} by ${by}\n`);
    } else if (existsSync(this.killPath())) {
      // Keep an audit artifact of the kill period instead of deleting it.
      renameSync(this.killPath(), `${this.stateDir}/KILLED.cleared.${Date.now()}`);
    }
  }

  // ------------------------------------------------------------ ledger

  private ledgerPath(): string {
    return `${this.stateDir}/ledger.jsonl`;
  }

  private readLedger(): LedgerEntry[] {
    if (!existsSync(this.ledgerPath())) return [];
    return readFileSync(this.ledgerPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEntry);
  }

  private append(entry: LedgerEntry): void {
    appendFileSync(this.ledgerPath(), JSON.stringify(entry) + "\n");
  }

  /** Reservations with no settle/refund (in-flight spend). */
  private openReservations(entries: LedgerEntry[]): Map<string, Extract<LedgerEntry, { kind: "reserve" }>> {
    const open = new Map<string, Extract<LedgerEntry, { kind: "reserve" }>>();
    for (const e of entries) {
      if (e.kind === "reserve") open.set(e.id, e);
      else open.delete(e.id);
    }
    return open;
  }

  /** A previous control-plane incarnation may have died holding
   *  reservations. Refund them so caps are never wedged by ghosts and
   *  the ledger always reconciles. */
  private sweepOrphanReservations(): void {
    const open = this.openReservations(this.readLedger());
    for (const r of open.values()) {
      this.append({
        kind: "refund",
        id: r.id,
        ts: Date.now(),
        jobId: r.jobId,
        reason: "control_plane_restart",
      });
    }
  }

  /** Settled + reserved (open) USD inside a window [fromTs, ∞). */
  private committedUsd(entries: LedgerEntry[], fromTs: number, jobId?: string): number {
    const open = this.openReservations(entries);
    let sum = 0;
    for (const e of entries) {
      if (e.ts < fromTs) continue;
      if (jobId !== undefined && e.jobId !== jobId) continue;
      if (e.kind === "settle") sum += e.costUsd;
    }
    for (const r of open.values()) {
      if (r.ts < fromTs) continue;
      if (jobId !== undefined && r.jobId !== jobId) continue;
      sum += r.estCostUsd;
    }
    return sum;
  }

  private committedTokens(entries: LedgerEntry[], fromTs: number, jobId?: string): number {
    const open = this.openReservations(entries);
    let sum = 0;
    for (const e of entries) {
      if (e.ts < fromTs) continue;
      if (jobId !== undefined && e.jobId !== jobId) continue;
      if (e.kind === "settle") sum += e.tokensIn + e.tokensOut;
    }
    for (const r of open.values()) {
      if (r.ts < fromTs) continue;
      if (jobId !== undefined && r.jobId !== jobId) continue;
      sum += r.estTokens;
    }
    return sum;
  }

  tokensToday(): number {
    return this.committedTokens(this.readLedger(), dayStart(Date.now()));
  }

  /** Settled USD since a timestamp (Phase 4: the panel's money view). */
  settledUsdSince(fromTs: number): number {
    let sum = 0;
    for (const e of this.readLedger()) {
      if (e.kind === "settle" && e.ts >= fromTs) sum += e.costUsd;
    }
    return sum;
  }

  /** Spend vs caps for the panel's first screen: where the money went,
   *  grouped by day and month, next to the ceilings it answers to. */
  spendSummary(): {
    todayUsd: number;
    monthUsd: number;
    totalUsd: number;
    caps: GovernorConfig;
  } {
    const now = Date.now();
    return {
      todayUsd: this.settledUsdSince(dayStart(now)),
      monthUsd: this.settledUsdSince(monthStart(now)),
      totalUsd: this.settledUsdSince(0),
      caps: this.config(),
    };
  }

  /**
   * Operator-surface caps write (onboarding + panel settings): merges
   * the given fields into <state>/governor.json, preserving everything
   * else (price table included). Atomic enough for a single-operator
   * file (write-then-rename is unnecessary here; the Governor re-reads
   * per authorization and a torn read falls back to defaults, never to
   * "no caps"). Undefined fields are left untouched.
   */
  writeCaps(patch: Partial<GovernorConfig>): void {
    if (this.fixedConfig) {
      Object.assign(this.fixedConfig, patch);
      return;
    }
    let raw: Record<string, unknown> = {};
    try {
      if (existsSync(this.configPath())) {
        raw = JSON.parse(readFileSync(this.configPath(), "utf8")) as Record<string, unknown>;
      }
    } catch {
      raw = {};
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) raw[k] = v;
    }
    if (typeof raw.maxTokensPerJob !== "number") raw.maxTokensPerJob = DEFAULT_GOVERNOR_CONFIG.maxTokensPerJob;
    if (typeof raw.maxTokensPerDay !== "number") raw.maxTokensPerDay = DEFAULT_GOVERNOR_CONFIG.maxTokensPerDay;
    writeFileSync(this.configPath(), JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  }

  /** The reconciliation statement the Phase 2 gate asserts. */
  /** Phase 4 (panel): the most recent ledger entries, oldest first. */
  recentEntries(limit = 200): LedgerEntry[] {
    const all = this.readLedger();
    return all.slice(Math.max(0, all.length - limit));
  }

  audit(): LedgerAudit {
    const entries = this.readLedger();
    let reserves = 0;
    let settles = 0;
    let refunds = 0;
    let settledUsd = 0;
    for (const e of entries) {
      if (e.kind === "reserve") reserves++;
      else if (e.kind === "settle") {
        settles++;
        settledUsd += e.costUsd;
      } else refunds++;
    }
    const openReservations = this.openReservations(entries).size;
    return {
      reserves,
      settles,
      refunds,
      openReservations,
      settledUsd,
      reconciles: openReservations === 0 && reserves === settles + refunds,
    };
  }

  // ------------------------------------------------------------ metering

  /**
   * Pre-flight authorization, run BEFORE any model call is issued.
   * On success a reservation is appended to the ledger (the estimated
   * cost now counts against every cap) and its id returned; the caller
   * MUST settle or refund it exactly once.
   */
  authorize(
    jobId: string,
    estTokensIn: number,
    estTokensOut = 0,
    model = "fake/stub-v0 (Phase 0 offline provider)",
  ): MeterDecision {
    if (this.isKilled()) {
      return { ok: false, reason: "killed", detail: "kill switch is on" };
    }
    const cfg = this.config();
    const estTokens = estTokensIn + estTokensOut;
    const estCostUsd = this.costFor(model, estTokensIn, estTokensOut, cfg);
    const entries = this.readLedger();
    const now = Date.now();

    const jobTokens = this.committedTokens(entries, 0, jobId);
    if (jobTokens + estTokens > cfg.maxTokensPerJob) {
      return {
        ok: false,
        reason: "cap_exceeded",
        detail: `per-job token cap ${cfg.maxTokensPerJob} would be exceeded (${jobTokens}+${estTokens})`,
      };
    }
    const dayTokens = this.committedTokens(entries, dayStart(now));
    if (dayTokens + estTokens > cfg.maxTokensPerDay) {
      return {
        ok: false,
        reason: "cap_exceeded",
        detail: `per-day token cap ${cfg.maxTokensPerDay} would be exceeded`,
      };
    }
    if (cfg.maxUsdPerTask !== undefined) {
      const jobUsd = this.committedUsd(entries, 0, jobId);
      if (jobUsd + estCostUsd > cfg.maxUsdPerTask) {
        return {
          ok: false,
          reason: "cap_exceeded",
          detail: `per-task spend cap $${cfg.maxUsdPerTask.toFixed(2)} reached (job has spent $${jobUsd.toFixed(4)}; this call would add $${estCostUsd.toFixed(4)})`,
        };
      }
    }
    if (cfg.maxUsdPerDay !== undefined) {
      const dayUsd = this.committedUsd(entries, dayStart(now));
      if (dayUsd + estCostUsd > cfg.maxUsdPerDay) {
        return {
          ok: false,
          reason: "cap_exceeded",
          detail: `per-day spend cap $${cfg.maxUsdPerDay.toFixed(2)} reached (today: $${dayUsd.toFixed(4)})`,
        };
      }
    }
    if (cfg.maxUsdPerMonth !== undefined) {
      const monthUsd = this.committedUsd(entries, monthStart(now));
      if (monthUsd + estCostUsd > cfg.maxUsdPerMonth) {
        return {
          ok: false,
          reason: "cap_exceeded",
          detail: `per-month spend cap $${cfg.maxUsdPerMonth.toFixed(2)} reached (this month: $${monthUsd.toFixed(4)})`,
        };
      }
    }

    const id = `rsv_${Date.now().toString(36)}_${(reservationCounter++).toString(36)}${Math.floor(Math.random() * 1e4)}`;
    this.append({ kind: "reserve", id, ts: now, jobId, model, estTokens, estCostUsd });
    return { ok: true, reservationId: id };
  }

  /** Settle a reservation with the call's actual usage. Returns the
   *  priced cost. Settling an unknown/closed reservation throws — a
   *  double-settle is a bug, and the ledger must never paper over one. */
  settle(reservationId: string, tokensIn: number, tokensOut: number): number {
    const entries = this.readLedger();
    const open = this.openReservations(entries);
    const rsv = open.get(reservationId);
    if (!rsv) throw new Error(`cannot settle unknown or closed reservation ${reservationId}`);
    const costUsd = this.costFor(rsv.model, tokensIn, tokensOut);
    this.append({
      kind: "settle",
      id: reservationId,
      ts: Date.now(),
      jobId: rsv.jobId,
      model: rsv.model,
      tokensIn,
      tokensOut,
      costUsd,
    });
    return costUsd;
  }

  /** Refund a reservation that never executed (cost returns to the caps). */
  refund(reservationId: string, reason: string): void {
    const entries = this.readLedger();
    const open = this.openReservations(entries);
    const rsv = open.get(reservationId);
    if (!rsv) throw new Error(`cannot refund unknown or closed reservation ${reservationId}`);
    this.append({ kind: "refund", id: reservationId, ts: Date.now(), jobId: rsv.jobId, reason });
  }
}
