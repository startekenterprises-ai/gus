/**
 * The budget profile (v0.14.6) — one operator setting that scales
 * the Governor's budget caps, SELinux-mode-style in spirit: a
 * named posture in a state file, re-read at every decision point,
 * never settable by the agent whose budget it governs.
 *
 * One state file, `<stateDir>/budget-profile.json`:
 *   { "profile": "standard" | "generous" | "max" | "unlimited",
 *     "setBy": "...", "ts": ... }
 *
 * STANDARD (the default, and the answer whenever the file is
 * missing or malformed): the caps in governor.json exactly as
 * configured — on a paid provider a runaway agent is a real
 * wallet harm, and the caps are a feature there.
 *
 * GENEROUS = 10× every cap. MAX = 100× every cap — the posture
 * for a free-credit route, where the per-job token cap was the
 * binding constraint that kept cutting self-build jobs at the
 * knees (Cycle 0, receipt gus_rcpt_dd1a613422ad751d).
 *
 * UNLIMITED: no budget enforcement at all. The natural pairing
 * for local models (Ollama and friends), where the marginal
 * cost of a token is ~zero. Enforcement stops; ACCOUNTING DOES
 * NOT — the Governor still counts and receipts every call under
 * every profile, and approvals + the kill switch still bind.
 *
 * The profile scales CAPS ONLY — never the price table (prices
 * are facts about the world, not a posture). The write path is
 * the panel's operator route and nothing else: no job, delegate,
 * or model output can reach it, so the loop cannot raise its
 * own budget (Protected Path discipline, unchanged).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GovernorConfig } from "./governor.js";

export type BudgetProfile = "standard" | "generous" | "max" | "unlimited";

export const BUDGET_PROFILES: readonly BudgetProfile[] = [
  "standard",
  "generous",
  "max",
  "unlimited",
] as const;

const PROFILE_FILE = "budget-profile.json";

/** Cap multiplier per profile; unlimited is handled separately
 *  (caps removed, not multiplied). */
export const BUDGET_PROFILE_MULTIPLIERS: Record<Exclude<BudgetProfile, "unlimited">, number> = {
  standard: 1,
  generous: 10,
  max: 100,
};

export function loadBudgetProfile(stateDir: string): BudgetProfile {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, PROFILE_FILE), "utf8")) as {
      profile?: unknown;
    };
    return BUDGET_PROFILES.includes(raw.profile as BudgetProfile)
      ? (raw.profile as BudgetProfile)
      : "standard";
  } catch {
    return "standard";
  }
}

export function writeBudgetProfile(stateDir: string, profile: BudgetProfile, setBy: string): void {
  writeFileSync(
    join(stateDir, PROFILE_FILE),
    JSON.stringify({ profile, setBy, ts: Date.now() }, null, 2) + "\n",
    { mode: 0o600 },
  );
}

/**
 * The caps the Governor actually enforces under `profile`,
 * derived from the operator's configured base caps. Token caps
 * are always defined (defaults exist), so they scale directly;
 * USD caps scale only where the operator configured them.
 * Unlimited removes every cap (fields set to +Infinity /
 * undefined — the authorize checks treat both as "no ceiling").
 * Prices and any other config fields pass through untouched.
 */
export function applyBudgetProfile(base: GovernorConfig, profile: BudgetProfile): GovernorConfig {
  if (profile === "standard") return base;
  if (profile === "unlimited") {
    return {
      ...base,
      maxTokensPerJob: Number.POSITIVE_INFINITY,
      maxTokensPerDay: Number.POSITIVE_INFINITY,
      maxUsdPerTask: undefined,
      maxUsdPerDay: undefined,
      maxUsdPerMonth: undefined,
    };
  }
  const m = BUDGET_PROFILE_MULTIPLIERS[profile];
  const usd = (v: number | undefined): number | undefined => (v === undefined ? undefined : v * m);
  return {
    ...base,
    maxTokensPerJob: base.maxTokensPerJob * m,
    maxTokensPerDay: base.maxTokensPerDay * m,
    maxUsdPerTask: usd(base.maxUsdPerTask),
    maxUsdPerDay: usd(base.maxUsdPerDay),
    maxUsdPerMonth: usd(base.maxUsdPerMonth),
  };
}
