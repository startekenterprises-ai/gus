/**
 * Phase 4 "outside world" fixtures — DRILL ONLY.
 *
 * Two more loopback servers that share the control plane's container
 * (same vehicle constraint as the Phase 1 test world: no second
 * container can join the namespace here):
 *
 *   ARTICLE  gus-drill:8903 — one page, /article, whose body is
 *            ARTICLE_BODY (phase4-payloads.mjs): a news item carrying
 *            an embedded exfiltration directive. Served verbatim; the
 *            Shield gate — not this fixture — is what must stop it
 *            reaching the model.
 *
 *   MODEL    127.0.0.1:8905 — an OpenAI-compatible chat-completions
 *            stand-in for the onboarding drill's provider step. The
 *            vehicle has no egress to a real provider and no real
 *            provider key may be used, so the gateway provider CLASS
 *            (the real code path: vault key → Authorization header →
 *            completions call → Governor metering → verified
 *            settlement) is exercised against this deterministic
 *            endpoint. Its log records keyOk booleans — never the key.
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { ARTICLE_BODY } from "./phase4-payloads.mjs";

export const MODEL_REPLY =
  "Here is your daily digest: no urgent email, two calendar headlines, nothing that needs a reply.";

const ARTICLE_PORT = Number(process.env.GUS_ARTICLE_PORT ?? "8903");
const MODEL_PORT = Number(process.env.GUS_MODEL_PORT ?? "8905");
const MODEL_LOG = process.env.MODEL_LOG ?? "/apilog/model.jsonl";
const ARTICLE_LOG = process.env.ARTICLE_LOG ?? "/apilog/article.jsonl";
const MODEL_EXPECTED_KEY = process.env.MODEL_EXPECTED_KEY ?? "";

function logLine(path, obj) {
  try {
    appendFileSync(path, JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
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

export function startPhase4World() {
  const article = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", `http://gus-drill:${ARTICLE_PORT}`).pathname;
    logLine(ARTICLE_LOG, { method: req.method, path });
    if (req.method === "GET" && path === "/article") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(ARTICLE_BODY);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no such route");
  });
  article.listen(ARTICLE_PORT, "127.0.0.1", () =>
    console.log(`phase4 article server listening on 127.0.0.1:${ARTICLE_PORT}`),
  );

  const model = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", `http://127.0.0.1:${MODEL_PORT}`).pathname;
    if (req.method === "POST" && path === "/v1/chat/completions") {
      await readBody(req);
      const auth = req.headers["authorization"];
      const keyOk =
        MODEL_EXPECTED_KEY !== "" && auth === `Bearer ${MODEL_EXPECTED_KEY}`;
      logLine(MODEL_LOG, { path, keyOk });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-gus-drill",
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: MODEL_REPLY }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "model stand-in: no such route" }));
  });
  model.listen(MODEL_PORT, "127.0.0.1", () =>
    console.log(`phase4 model stand-in listening on 127.0.0.1:${MODEL_PORT}`),
  );
  return { article, model };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startPhase4World();
}
