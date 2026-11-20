/**
 * Record the LIVE Agent-Shield API's responses for the Phase 4 drill
 * payloads — DRILL TOOLING ONLY, run on the host by the drill scripts.
 *
 * Why this exists: the drill topology (podman, --network none) has no
 * egress, so the gate client inside the control-plane container
 * cannot reach the production Shield. The standing Phase 4 ruling:
 * capture REAL responses from the live API at host level for the
 * drill's exact payloads and replay them byte-for-byte through a
 * local stand-in (shield-standin.mjs); the gate's base URL is config,
 * so the wiring under test is identical. This script is the capture
 * half. It never fabricates a response: every scan is a real
 * POST /v2/scan against the live API, and the expected verdict class
 * of each payload (phase4-payloads.mjs) is ASSERTED — if the live API
 * answers differently than the drill assumes, recording fails and the
 * drill does not start.
 *
 * Key discipline: the zero-form signup mints a real free-tier key.
 * It is written ONLY to the --key-out file (mode 0600, outside the
 * drill dir) so the drill's final sweep can grep for it, and into the
 * recordings file (mode 0600) as part of the recorded signup response
 * — the stand-in replays that response into the drill vault, which is
 * where the key is allowed to live. The drill deletes the recordings
 * file before its hygiene sweep. The key is never printed.
 *
 * The live API rate-limits bursts from fresh keys (observed during
 * development: transient no-verdict/5xx responses under rapid fire),
 * so requests are paced and retried with backoff.
 *
 * Usage: node record-shield.mjs --out <recordings.json> --key-out <file>
 *        [--base https://agent-shield.startekenterprises.com]
 */
import { writeFileSync } from "node:fs";
import { PAYLOADS } from "./phase4-payloads.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const outPath = opt("out");
const keyOutPath = opt("key-out");
const base = (opt("base", "https://agent-shield.startekenterprises.com") ?? "").replace(/\/+$/, "");
if (!outPath || !keyOutPath) {
  console.error("usage: record-shield.mjs --out <recordings.json> --key-out <file> [--base <url>]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "gus-control-plane/0.4", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, text: await res.text() };
}

// --- signup (zero-form, the same call onboarding makes) --------------
let signup = null;
let apiKey = "";
for (let attempt = 0; attempt < 4 && !apiKey; attempt++) {
  try {
    const r = await post("/v1/signup", { label: "gus" });
    const parsed = JSON.parse(r.text);
    if (r.status === 200 && typeof parsed.api_key === "string" && parsed.api_key) {
      signup = r;
      apiKey = parsed.api_key;
    } else {
      console.error(`signup attempt ${attempt}: HTTP ${r.status}, no api_key in response`);
    }
  } catch (e) {
    console.error(`signup attempt ${attempt}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!apiKey) await sleep(8_000);
}
if (!signup || !apiKey) {
  console.error("RECORDING FAILED: could not provision a Shield key from the live API");
  process.exit(1);
}
writeFileSync(keyOutPath, apiKey + "\n", { mode: 0o600 });
console.log("signup recorded (key stored to key-out file, never printed)");

// --- scans -------------------------------------------------------------
// --signup-only: the onboarding drill provisions through the same
// signup but runs no gated channel traffic (its first job is a system
// job), so it records the signup alone.
const scans = [];
for (const p of args.includes("--signup-only") ? [] : PAYLOADS) {
  let recorded = null;
  for (let attempt = 0; attempt < 5 && !recorded; attempt++) {
    if (attempt > 0) await sleep(10_000);
    try {
      const r = await post(
        "/v2/scan",
        { content: p.content, content_type: p.contentType, mode: "enforce", nonce: "gus-phase4-drill" },
        { "x-api-key": apiKey },
      );
      const parsed = JSON.parse(r.text);
      if (r.status === 200 && typeof parsed.verdict === "string") {
        const action = parsed.action ?? (parsed.verdict === "malicious" ? "block" : "allow");
        const okClass = p.expect === "block" ? action === "block" : action === "allow";
        if (!okClass) {
          console.error(
            `RECORDING FAILED: payload ${p.name} expected ${p.expect}, live API answered verdict=${parsed.verdict} action=${action}`,
          );
          process.exit(1);
        }
        recorded = { name: p.name, contentType: p.contentType, content: p.content, status: r.status, body: r.text };
        console.log(
          `scan recorded: ${p.name} verdict=${parsed.verdict} action=${action} receipt=${parsed.receipt?.receipt_id ?? "none"}`,
        );
      } else {
        console.error(`scan ${p.name} attempt ${attempt}: HTTP ${r.status}, no verdict (transient?)`);
      }
    } catch (e) {
      console.error(`scan ${p.name} attempt ${attempt}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!recorded) {
    console.error(`RECORDING FAILED: payload ${p.name} never returned a verdict`);
    process.exit(1);
  }
  scans.push(recorded);
  await sleep(6_000);
}

writeFileSync(
  outPath,
  JSON.stringify({ recordedAt: new Date().toISOString(), baseUrl: base, signup, scans }, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(`recordings written: ${scans.length} scans + signup`);
if (scans.length === 0) console.log("signup-only recording (no scan payloads requested)");
