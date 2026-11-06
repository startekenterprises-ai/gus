/**
 * The Governor mode (v0.4) — SELinux-style enforcement modes.
 *
 * One state file, `<stateDir>/governor-mode.json`:
 *   { "mode": "enforcing" | "permissive", "setBy": "...", "ts": ... }
 *
 * ENFORCING (the default, and the answer whenever the file is
 * missing or malformed): Shield verdicts bind, classifier parks
 * and denies bind.
 *
 * PERMISSIVE: everything is still scanned and classified, but a
 * would-be block / park / deny proceeds instead — stamped in the
 * gate log (Shield side) and in permissive.jsonl (classifier side)
 * with what enforcing mode would have done, so the operator can
 * review exactly what the relaxed mode let through and harden
 * again. It is the firewall-disable troubleshooting loop, with
 * receipts.
 *
 * The floors permissive mode can NEVER cross, by construction:
 *  - vault_read stays denied (a secret in model context is an
 *    irreversible disclosure, not a reversible action — the
 *    comm-server floors it before the mode is consulted);
 *  - the spend caps still settle and stop at the ceiling, and the
 *    kill switch still halts everything (Governor mechanics, not
 *    content policy — the mode never reaches them);
 *  - scanning and receipting themselves never turn off.
 *
 * The file is re-read at every decision point, so a flip from the
 * panel, the app menu, or the /mode chat command is live on the
 * next action — no restart.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type GovernorMode = "enforcing" | "permissive";

const MODE_FILE = "governor-mode.json";
const PERMISSIVE_LOG = "permissive.jsonl";
const GATE_LOG = "gate.jsonl";

export function loadGovernorMode(stateDir: string): GovernorMode {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, MODE_FILE), "utf8")) as {
      mode?: unknown;
    };
    return raw.mode === "permissive" ? "permissive" : "enforcing";
  } catch {
    return "enforcing";
  }
}

export function writeGovernorMode(stateDir: string, mode: GovernorMode, setBy: string): void {
  writeFileSync(
    join(stateDir, MODE_FILE),
    JSON.stringify({ mode, setBy, ts: Date.now() }, null, 2) + "\n",
  );
}

export interface PermissiveAction {
  ts: number;
  jobId?: string;
  /** "shield" = a Shield verdict that would have blocked;
   *  "policy" = a classifier park/deny that proceeded anyway. */
  kind: "shield" | "policy";
  detail: string;
}

/** Append one classifier-side permissive action (the Shield side
 *  already lands in gate.jsonl via the gate's own log). */
export function appendPermissiveAction(stateDir: string, a: PermissiveAction): void {
  try {
    appendFileSync(join(stateDir, PERMISSIVE_LOG), JSON.stringify(a) + "\n");
  } catch {
    /* the report is a courtesy surface; a logging failure must
       never change an enforcement outcome */
  }
}

/** The permissive report: every let-through since `sinceMs`,
 *  merged from both logs, oldest first. */
export function readPermissiveActions(stateDir: string, sinceMs: number): PermissiveAction[] {
  const out: PermissiveAction[] = [];
  const pushLines = (file: string, map: (e: Record<string, unknown>) => PermissiveAction | null) => {
    const path = join(stateDir, file);
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const mapped = map(JSON.parse(line) as Record<string, unknown>);
        if (mapped && mapped.ts >= sinceMs) out.push(mapped);
      } catch {
        /* a torn last line is not a reason to lose the report */
      }
    }
  };
  pushLines(PERMISSIVE_LOG, (e) =>
    typeof e.ts === "number"
      ? { ts: e.ts, jobId: e.jobId as string | undefined, kind: "policy", detail: String(e.detail ?? "") }
      : null,
  );
  pushLines(GATE_LOG, (e) =>
    e.wouldBe && typeof e.ts === "number"
      ? {
          ts: e.ts,
          jobId: e.jobId as string | undefined,
          kind: "shield",
          detail: String(e.detail ?? ""),
        }
      : null,
  );
  return out.sort((a, b) => a.ts - b.ts);
}
