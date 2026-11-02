/**
 * Governor (foundation spec §1.2) — PHASE 0 STUB with real enforcement
 * points.
 *
 * Real in Phase 0:
 * - Kill switch: a persisted state file. While killed, every model request
 *   is refused and in-flight work is told to stop. Survives restarts —
 *   the flag is read from disk on boot and on every request, never just
 *   held in memory. This is the phone kill switch from the Yue incident.
 * - Spend caps: per-job / per-day ceilings checked BEFORE a model call is
 *   issued, against an append-only JSONL ledger. Phase 0's fake/local
 *   provider meters tokens at $0; the cap machinery is fully exercised by
 *   the token-denominated caps here and in the unit tests. USD price-table
 *   metering lands with priced providers (gateway, Phase 4).
 * - Metering: every issued call appends {jobId, model, tokens, cost} to
 *   the ledger, which lives in control-plane state — never in the sandbox.
 *
 * The Governor is the ONLY path to a model: the sandbox holds no provider
 * keys and has no network. There is deliberately no runtime-facing control
 * path — the sandbox cannot flip the kill switch or raise a cap.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export interface GovernorConfig {
  /** Token-denominated hard cap per single job (Phase 0 metering unit). */
  maxTokensPerJob: number;
  /** Token-denominated hard cap per UTC day across all jobs. */
  maxTokensPerDay: number;
  /** USD caps arrive with priced providers; shape reserved. */
  maxUsdPerMonth?: number;
}

export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  maxTokensPerJob: 20_000,
  maxTokensPerDay: 200_000,
};

export interface LedgerEntry {
  ts: number;
  jobId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export type MeterDecision =
  | { ok: true }
  | { ok: false; reason: "killed" | "cap_exceeded"; detail: string };

export class Governor {
  private jobTokens = new Map<string, number>();

  constructor(
    private stateDir: string,
    private config: GovernorConfig = DEFAULT_GOVERNOR_CONFIG,
  ) {}

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

  tokensToday(): number {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    return this.readLedger()
      .filter((e) => e.ts >= dayStart.getTime())
      .reduce((sum, e) => sum + e.tokensIn + e.tokensOut, 0);
  }

  /** Pre-flight check, run BEFORE any model call is issued. */
  authorize(jobId: string, estimatedTokens: number): MeterDecision {
    if (this.isKilled()) {
      return { ok: false, reason: "killed", detail: "kill switch is on" };
    }
    const used = this.jobTokens.get(jobId) ?? 0;
    if (used + estimatedTokens > this.config.maxTokensPerJob) {
      return {
        ok: false,
        reason: "cap_exceeded",
        detail: `per-job token cap ${this.config.maxTokensPerJob} would be exceeded (${used}+${estimatedTokens})`,
      };
    }
    if (this.tokensToday() + estimatedTokens > this.config.maxTokensPerDay) {
      return {
        ok: false,
        reason: "cap_exceeded",
        detail: `per-day token cap ${this.config.maxTokensPerDay} would be exceeded`,
      };
    }
    return { ok: true };
  }

  /** Record an issued call. Called exactly once per model response. */
  record(entry: LedgerEntry): void {
    appendFileSync(this.ledgerPath(), JSON.stringify(entry) + "\n");
    this.jobTokens.set(
      entry.jobId,
      (this.jobTokens.get(entry.jobId) ?? 0) + entry.tokensIn + entry.tokensOut,
    );
  }
}
