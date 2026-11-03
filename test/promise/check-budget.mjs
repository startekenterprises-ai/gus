#!/usr/bin/env node
/**
 * Resource-budget check (spec §0 rule 4 / §7): steady-state ≤ 1 GB RAM
 * for control plane + one sandbox, model excluded.
 *
 * Two layers:
 *  1. Static (always): the compose mem_limits for the two services must
 *     sum to ≤ 1024 MB — a config regression cannot silently raise the
 *     footprint.
 *  2. Measured (when drill/phase0/metrics.json exists): the RSS summed
 *     by the Phase 0 drill must be ≤ 1 GB.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUDGET_MB = 1024;
let failed = false;

const compose = readFileSync(join(root, "packages/sandbox/docker-compose.yml"), "utf8");
const limits = [...compose.matchAll(/mem_limit:\s*(\d+)m/g)].map((m) => Number(m[1]));
const declared = limits.reduce((a, b) => a + b, 0);
console.log(`compose mem_limits: [${limits.join(", ")}] MB → ${declared} MB (budget ${BUDGET_MB} MB)`);
if (limits.length < 2 || declared > BUDGET_MB) {
  console.error("FAIL: declared container memory exceeds the 1 GB budget");
  failed = true;
}

for (const phase of ["phase0", "phase1"]) {
  const metricsPath = join(root, "drill", phase, "metrics.json");
  if (existsSync(metricsPath)) {
    const m = JSON.parse(readFileSync(metricsPath, "utf8"));
    const totalMb = (m.controlRssKb + m.sandboxRssKb) / 1024;
    console.log(
      `${phase} drill-measured RSS: control ${(m.controlRssKb / 1024).toFixed(1)} MB + sandbox ${(m.sandboxRssKb / 1024).toFixed(1)} MB = ${totalMb.toFixed(1)} MB`,
    );
    if (totalMb > BUDGET_MB) {
      console.error(`FAIL: ${phase} measured RSS exceeds the 1 GB budget`);
      failed = true;
    }
  }
}
if (!existsSync(join(root, "drill/phase0/metrics.json"))) {
  console.log("no drill metrics found (run the promise drills) — static check only");
}

process.exit(failed ? 1 : 0);
