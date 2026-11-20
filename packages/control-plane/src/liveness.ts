/**
 * Liveness beat (GUS-lead / Nova-fallback design, 2026-11-16 — Phase 0).
 *
 * NOT the install heartbeat (heartbeat.ts): that one is opt-in, daily,
 * network telemetry saying "an install exists". This one is local,
 * always on, and timely: it answers "can THIS GUS take a job NOW?" for
 * the Nova watchdog that supervises GUS-lead workloads.
 *
 * The control plane (never the model, never a job) rewrites
 * <stateDir>/liveness.json every 15 minutes:
 *
 *   { "ts": ..., "version": ..., "governorMode": "enforcing",
 *     "caps": { "daySpentUsd": 0.42, "dayCapUsd": 10 },
 *     "lastJobSettledTs": ..., "queueDepth": 0,
 *     "canary": { "lastRunTs": null, "lastOk": null } }
 *
 * Properties, by construction:
 *  - $0 cost. No model call, no cap spend, no network. A heartbeat
 *    that burned the daily cap to prove it could spend the daily cap
 *    would be self-defeating.
 *  - Local only. The file never leaves the machine; Nova reads it via
 *    the same local/bridge tooling she already uses on the state dir.
 *  - Content-minimal: version, mode, aggregate spend vs cap, queue
 *    depth, last-settled timestamp, canary status. No job content, no
 *    conversation data, no identifiers beyond what the state dir
 *    already holds.
 *  - Best-effort and silent: a failed write is dropped, never retried
 *    aggressively, and can never block or crash the control plane.
 *    (A missing/stale file is itself the signal the watchdog acts on.)
 *
 * The daily canary (design §2 deep check) is a synthetic job proving
 * the full bridge → Governor → Shield gate → model → receipt path.
 * Phase 0 ships the beat plus the canary bookkeeping below (due-check
 * + result recording into the snapshot); the job submission itself
 * wires into the ChannelHost path when the first workload moves
 * (Phase 1) — Phase 0 moves no workloads and sends no jobs.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GUS_VERSION } from "@gus/shared";
import type { JobRecord } from "@gus/shared";
import type { GovernorMode } from "./governor-mode.js";
import type { BudgetProfile } from "./budget-profile.js";

export const LIVENESS_FILE = "liveness.json";
export const LIVENESS_INTERVAL_MS = 15 * 60 * 1000;
export const CANARY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface LivenessCanaryState {
  lastRunTs: number | null;
  lastOk: boolean | null;
}

export interface LivenessSnapshot {
  ts: number;
  version: string;
  governorMode: GovernorMode;
  /** v0.14.6: the budget profile in force; caps below are the
   *  EFFECTIVE ceilings under it. */
  budgetProfile: BudgetProfile;
  caps: {
    daySpentUsd: number;
    /** null when no USD day cap is configured (token-only caps). */
    dayCapUsd: number | null;
  };
  /** updatedAt of the most recently settled job, or null if none. */
  lastJobSettledTs: number | null;
  /** Jobs not yet settled (queued, running, or parked). */
  queueDepth: number;
  canary: LivenessCanaryState;
}

/** Everything the beat needs, injected so tests never touch a real
 *  Governor/JobRunner. All reads are local and free. */
export interface LivenessSources {
  governorMode: () => GovernorMode;
  budgetProfile: () => BudgetProfile;
  daySpentUsd: () => number;
  dayCapUsd: () => number | null;
  jobs: () => readonly Pick<JobRecord, "state" | "updatedAt">[];
}

const SETTLED_STATES = new Set(["verified-done", "failed-loudly"]);

export function buildLivenessSnapshot(
  sources: LivenessSources,
  canary: LivenessCanaryState,
  now: number = Date.now(),
): LivenessSnapshot {
  let lastJobSettledTs: number | null = null;
  let queueDepth = 0;
  for (const job of sources.jobs()) {
    if (SETTLED_STATES.has(job.state)) {
      if (lastJobSettledTs === null || job.updatedAt > lastJobSettledTs) {
        lastJobSettledTs = job.updatedAt;
      }
    } else {
      queueDepth++;
    }
  }
  return {
    ts: now,
    version: GUS_VERSION,
    governorMode: sources.governorMode(),
    budgetProfile: sources.budgetProfile(),
    caps: {
      daySpentUsd: sources.daySpentUsd(),
      dayCapUsd: sources.dayCapUsd(),
    },
    lastJobSettledTs,
    queueDepth,
    canary: { ...canary },
  };
}

/** Read a liveness file back (watchdog-side helper + tests). Returns
 *  null when missing or malformed — both read as "no beat". */
export function readLivenessFile(stateDir: string): LivenessSnapshot | null {
  try {
    const p = join(stateDir, LIVENESS_FILE);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8")) as LivenessSnapshot;
    if (typeof raw.ts !== "number" || typeof raw.version !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

/** True when the daily canary is due: never run, or last run is at
 *  least CANARY_INTERVAL_MS old. Pure — the caller owns submission. */
export function canaryDue(canary: LivenessCanaryState, now: number = Date.now()): boolean {
  return canary.lastRunTs === null || now - canary.lastRunTs >= CANARY_INTERVAL_MS;
}

/**
 * Start the liveness beat: one write at boot, then every 15 minutes.
 * Returns a handle whose stop() ends the beat and whose
 * recordCanaryResult() folds a canary outcome into later snapshots.
 * The timer is unref'd — the beat never keeps a process alive.
 * Writes are atomic (tmp file + rename) so a reader never sees a
 * half-written beat. Never throws.
 */
export function startLivenessBeat(
  stateDir: string,
  sources: LivenessSources,
  intervalMs: number = LIVENESS_INTERVAL_MS,
): { stop: () => void; recordCanaryResult: (ok: boolean, ts?: number) => void; snapshot: () => LivenessSnapshot } {
  const canary: LivenessCanaryState = { lastRunTs: null, lastOk: null };
  // Carry a previous incarnation's canary state forward — a restart
  // must not make a fresh canary look never-run (or a failed one ok).
  const prior = readLivenessFile(stateDir);
  if (prior?.canary && typeof prior.canary.lastRunTs === "number") {
    canary.lastRunTs = prior.canary.lastRunTs;
    canary.lastOk = typeof prior.canary.lastOk === "boolean" ? prior.canary.lastOk : null;
  }
  let current: LivenessSnapshot = buildLivenessSnapshot(sources, canary);
  const write = (): void => {
    try {
      current = buildLivenessSnapshot(sources, canary);
      const p = join(stateDir, LIVENESS_FILE);
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n", "utf8");
      renameSync(tmp, p);
    } catch {
      /* best-effort by design: a stale file is the watchdog's signal */
    }
  };
  write();
  const timer = setInterval(write, intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    recordCanaryResult: (ok: boolean, ts: number = Date.now()) => {
      canary.lastRunTs = ts;
      canary.lastOk = ok;
      write();
    },
    snapshot: () => current,
  };
}
