/**
 * Agent-Shield stand-in — DRILL FIXTURE ONLY (Phase 4 gate drill).
 *
 * Replays, byte-for-byte, the responses that
 * test/fixtures/record-shield.mjs captured from the LIVE Agent-Shield
 * API for the drill's exact payloads (phase4-payloads.mjs). It exists
 * because the drill topology has no egress (podman --network none in
 * this VM); the gate client's base URL is config, so the control
 * plane's wiring — signup → vault, scan → verdict → receipt — is the
 * production code path either way. What this fixture must NEVER do is
 * invent a verdict: a scan whose (content_type, content) pair has no
 * recording gets an HTTP 500, which the gate treats as "unavailable"
 * and fails closed on — the drill then fails loudly instead of
 * passing on fabricated evidence.
 *
 * Outage simulation: while the down-flag file exists, scan sockets
 * are destroyed before any response — the client sees a dead API,
 * which is what the fail-closed staging needs. (Signup is not gated
 * by the flag; the outage staging starts after provisioning.)
 *
 * Logging: route + sha256 of the scanned content + whether a
 * recording matched. Never bodies, never the API key.
 */
import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const PORT = Number(process.env.GUS_SHIELD_STANDIN_PORT ?? "8910");
const RECORDINGS = process.env.GUS_SHIELD_RECORDINGS ?? "";
const DOWN_FLAG = process.env.GUS_SHIELD_DOWN_FLAG ?? "/run/gus/shield-down";
const LOG = process.env.SHIELD_LOG ?? "/apilog/shield.jsonl";

function logLine(obj) {
  try {
    appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
  } catch {
    /* fixture logging must never crash the fixture */
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
  });
}

let recordings = null;
try {
  recordings = JSON.parse(readFileSync(RECORDINGS, "utf8"));
} catch {
  recordings = null;
}

export function startShieldStandin() {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`).pathname;
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(recordings ? "ok" : "no-recordings");
      return;
    }
    if (!recordings) {
      logLine({ route: path, error: "recordings file missing/unreadable" });
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "stand-in has no recordings" }));
      return;
    }
    if (req.method === "POST" && path === "/v1/signup") {
      await readBody(req);
      logLine({ route: "signup", matched: true });
      res.writeHead(recordings.signup.status, { "content-type": "application/json" });
      res.end(recordings.signup.text);
      return;
    }
    if (req.method === "POST" && path === "/v2/scan") {
      if (existsSync(DOWN_FLAG)) {
        logLine({ route: "scan", down: true });
        req.socket.destroy();
        return;
      }
      const raw = await readBody(req);
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* fall through to no-match */
      }
      const content = typeof parsed?.content === "string" ? parsed.content : "";
      const contentType = typeof parsed?.content_type === "string" ? parsed.content_type : "";
      const sha = createHash("sha256").update(content, "utf8").digest("hex");
      const hit = recordings.scans.find((s) => s.contentType === contentType && s.content === content);
      if (!hit) {
        logLine({ route: "scan", contentType, contentSha256: sha, matched: false });
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no recording for this payload" }));
        return;
      }
      logLine({ route: "scan", contentType, contentSha256: sha, matched: true, name: hit.name });
      res.writeHead(hit.status, { "content-type": "application/json" });
      res.end(hit.body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "stand-in: no such route" }));
  });
  server.listen(PORT, "127.0.0.1", () =>
    console.log(
      `shield stand-in listening on 127.0.0.1:${PORT} (recorded-replay mode); recordings: ${
        recordings ? `${recordings.scans.length} scans + signup` : "NONE (file missing/unreadable)"
      }`,
    ),
  );
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startShieldStandin();
}
