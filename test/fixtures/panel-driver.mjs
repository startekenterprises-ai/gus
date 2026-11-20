/**
 * Panel driver — DRILL FIXTURE ONLY (Phase 4 drills).
 *
 * `podman exec` cannot setns into containers in this VM, so the drill
 * harness cannot curl the operator panel (127.0.0.1:8731 inside the
 * control plane's container) from the host. This driver runs INSIDE
 * the control-plane container (started by drill4-entry.mjs) and plays
 * the operator: it tails a script file on the shared run volume —
 * one JSON object per line: {id, method, path, body} — executes each
 * request against the real panel with the real operator token, in
 * order, and appends one result line per request:
 * {id, startedAt, endedAt, status, body}. The harness writes steps
 * and reads results through the volume; timestamps are the driver's,
 * so step timing measured from them is the panel's real round-trip
 * time, not an exec artifact.
 *
 * The driver holds the panel token (read from control-plane state,
 * the same file the operator uses) and nothing else. Request bodies
 * are never logged — some of them carry secrets on their way to the
 * vault (the onboarding wizard's whole point); results' bodies are
 * the panel's own responses, which are secret-free by design.
 */
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";

const SCRIPT = process.env.GUS_PANEL_SCRIPT ?? "/run/gus/panel-script.jsonl";
const RESULTS = process.env.GUS_PANEL_RESULTS ?? "/run/gus/panel-results.jsonl";
const TOKEN_FILE = process.env.GUS_PANEL_TOKEN_FILE ?? "/state/panel-token";
const BASE = process.env.GUS_PANEL_BASE ?? "http://127.0.0.1:8731";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function result(obj) {
  try {
    appendFileSync(RESULTS, JSON.stringify(obj) + "\n");
  } catch {
    /* the harness notices missing results as a drill failure */
  }
}

async function panelUp() {
  try {
    const token = readFileSync(TOKEN_FILE, "utf8").trim();
    if (!token) return false;
    const res = await fetch(`${BASE}/api/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export function startPanelDriver() {
  void (async () => {
    // Announce readiness only once the panel actually answers with
    // the operator token — the harness gates its first step on this.
    for (;;) {
      if (await panelUp()) break;
      await sleep(250);
    }
    result({ id: "__ready", startedAt: Date.now(), endedAt: Date.now(), status: 200, body: null });

    let offset = 0;
    let partial = "";
    for (;;) {
      try {
        if (existsSync(SCRIPT)) {
          const size = statSync(SCRIPT).size;
          if (size > offset) {
            const text = readFileSync(SCRIPT, "utf8").slice(offset);
            offset = size;
            const lines = (partial + text).split("\n");
            partial = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              let step;
              try {
                step = JSON.parse(line);
              } catch {
                continue;
              }
              const startedAt = Date.now();
              let status = 0;
              let body = null;
              try {
                const token = readFileSync(TOKEN_FILE, "utf8").trim();
                const res = await fetch(`${BASE}${step.path}`, {
                  method: step.method ?? "GET",
                  headers: {
                    authorization: `Bearer ${token}`,
                    ...(step.body ? { "content-type": "application/json" } : {}),
                  },
                  body: step.body ? JSON.stringify(step.body) : undefined,
                  signal: AbortSignal.timeout(20_000),
                });
                status = res.status;
                const text = await res.text();
                try {
                  body = JSON.parse(text);
                } catch {
                  body = text.slice(0, 500);
                }
              } catch (e) {
                body = `driver error: ${e instanceof Error ? e.message : String(e)}`;
              }
              result({ id: step.id, startedAt, endedAt: Date.now(), status, body });
            }
          }
        }
      } catch {
        /* transient read races with the harness appending — retry */
      }
      await sleep(150);
    }
  })();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startPanelDriver();
}
