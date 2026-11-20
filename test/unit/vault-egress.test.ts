import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultBroker } from "../../packages/vault/src/index.js";
import {
  EgressProxy,
  type EgressTransport,
  type EgressTransportResponse,
} from "../../packages/egress/src/index.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";

const CANARY = "canary-7f3a9c51e8b24d06-secret-value";

function freshVault(): { dir: string; vault: VaultBroker } {
  const dir = mkdtempSync(join(tmpdir(), "gus-vault-"));
  return { dir, vault: new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key")) };
}

function freshProxy(
  transport: EgressTransport,
  policy: unknown,
): { dir: string; vault: VaultBroker; proxy: EgressProxy } {
  const { dir, vault } = freshVault();
  vault.add("test-api", CANARY);
  const policyPath = join(dir, "egress-policy.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  const proxy = new EgressProxy({
    vault,
    policyPath,
    logPath: join(dir, "egress.jsonl"),
    receiptsPath: join(dir, "egress-receipts.jsonl"),
    issuer: new LocalReceiptIssuer(join(dir, "receipt.key")),
    transport,
  });
  return { dir, vault, proxy };
}

const ALLOW_POLICY = {
  allow: [{ host: "api.test", ports: [443] }],
  injections: [{ host: "api.test", port: 443, secret: "test-api", header: "x-api-key" }],
};

// ---------------------------------------------------------------- vault

test("vault: add/list/remove round-trip; names only, never values", () => {
  const { vault } = freshVault();
  vault.add("test-api", CANARY);
  vault.add("other", "another-secret-value-123");
  assert.deepEqual(vault.listNames(), ["other", "test-api"]);
  assert.equal(vault.has("test-api"), true);
  assert.equal(vault.has("nope"), false);
  assert.ok(!JSON.stringify(vault.listNames()).includes(CANARY));
  assert.equal(vault.remove("other"), true);
  assert.equal(vault.remove("other"), false);
  assert.deepEqual(vault.listNames(), ["test-api"]);
});

test("vault: no read API — the only value surface is the withSecret callback", () => {
  const proto = VaultBroker.prototype as unknown as Record<string, unknown>;
  const methods = Object.getOwnPropertyNames(proto).filter(
    (n) => n !== "constructor" && typeof proto[n] === "function",
  );
  // Detection/redaction helpers and admin ops are fine; anything shaped
  // like a getter that returns a secret is not.
  for (const m of methods) {
    assert.ok(
      !/^(get|read|reveal|export|dump|value)/i.test(m),
      `vault exposes a suspicious read-shaped method: ${m}`,
    );
  }
  const { vault } = freshVault();
  vault.add("test-api", CANARY);
  // JSON serialization of the broker carries paths, never values.
  assert.ok(!JSON.stringify(vault).includes(CANARY));
  let seen: string | undefined;
  const ret = vault.withSecret("test-api", (v) => {
    seen = v;
    return "callback-result";
  });
  assert.equal(seen, CANARY);
  assert.equal(ret, "callback-result");
  assert.equal(vault.withSecret("missing", () => "x"), undefined);
});

test("vault: store and key files are 0600 and the store holds ciphertext only", () => {
  const { dir, vault } = freshVault();
  vault.add("test-api", CANARY);
  const storeRaw = readFileSync(join(dir, "vault.json"), "utf8");
  assert.ok(!storeRaw.includes(CANARY), "plaintext secret in the vault store");
  assert.equal(statSync(join(dir, "vault.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "vault.key")).mode & 0o777, 0o600);
  // A second broker over the same files (a "restart") reads it back.
  const reopened = new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key"));
  assert.equal(reopened.withSecret("test-api", (v) => v), CANARY);
});

test("vault: tampered ciphertext fails the auth tag instead of yielding a value", () => {
  const { dir, vault } = freshVault();
  vault.add("test-api", CANARY);
  const parsed = JSON.parse(readFileSync(join(dir, "vault.json"), "utf8")) as {
    entries: Record<string, { c: string }>;
  };
  const ct = Buffer.from(parsed.entries["test-api"].c, "base64");
  ct[0] = ct[0] ^ 0xff;
  parsed.entries["test-api"].c = ct.toString("base64");
  writeFileSync(join(dir, "vault.json"), JSON.stringify(parsed));
  assert.throws(() => vault.withSecret("test-api", (v) => v));
});

test("vault: invalid names and short values are refused at add time", () => {
  const { vault } = freshVault();
  assert.throws(() => vault.add("Bad Name!", CANARY));
  assert.throws(() => vault.add("ok-name", "short"));
  assert.deepEqual(vault.listNames(), []);
});

test("vault: findValuesIn / redactValues detect and scrub without disclosing", () => {
  const { vault } = freshVault();
  vault.add("test-api", CANARY);
  assert.deepEqual(vault.findValuesIn(`prefix ${CANARY} suffix`), ["test-api"]);
  assert.deepEqual(vault.findValuesIn("nothing here"), []);
  const { text, names } = vault.redactValues(`echo: ${CANARY}`);
  assert.deepEqual(names, ["test-api"]);
  assert.ok(!text.includes(CANARY));
  assert.ok(text.includes("[vault secret withheld: test-api]"));
});

// ---------------------------------------------------------------- egress

test("egress: non-allowlisted destination is blocked before any socket opens", async () => {
  let calls = 0;
  const { proxy } = freshProxy(async () => {
    calls++;
    return { status: 200, headers: {}, body: "ok" };
  }, ALLOW_POLICY);
  const r = await proxy.fetch({ url: "https://evil.test/steal" }, { jobId: "j1" });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "blocked:destination_not_allowlisted");
  assert.equal(calls, 0);
});

test("egress: non-http(s) schemes are blocked (file:// state scraping)", async () => {
  let calls = 0;
  const { proxy } = freshProxy(async () => {
    calls++;
    return { status: 200, headers: {}, body: "ok" };
  }, ALLOW_POLICY);
  const r = await proxy.fetch({ url: "file:///state/vault.json" }, { jobId: "j1" });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "blocked:scheme");
  assert.equal(calls, 0);
});

test("egress: injection puts the real value in the bound header only", async () => {
  let seenHeaders: Record<string, string> = {};
  const { proxy } = freshProxy(async (_url, init) => {
    seenHeaders = init.headers;
    return { status: 200, headers: {}, body: "project data" };
  }, ALLOW_POLICY);
  const r = await proxy.fetch(
    { url: "https://api.test/data", secretName: "test-api", headers: { "x-api-key": "agent-supplied-junk" } },
    { jobId: "j1" },
  );
  assert.equal(r.ok, true);
  assert.equal(seenHeaders["x-api-key"], CANARY); // proxy overwrote the agent's copy
  assert.ok(!(r.body ?? "").includes(CANARY));
  assert.deepEqual(r.secretNames, ["test-api"]);
  assert.ok(r.receiptId.startsWith("gus_rcpt_"));
});

test("egress: a secret with no binding for the destination is blocked", async () => {
  let calls = 0;
  const { proxy } = freshProxy(async () => {
    calls++;
    return { status: 200, headers: {}, body: "ok" };
  }, { allow: [{ host: "api.test", ports: [443] }], injections: [] });
  const r = await proxy.fetch(
    { url: "https://api.test/data", secretName: "test-api" },
    { jobId: "j1" },
  );
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "blocked:secret_not_bound_to_destination");
  assert.equal(calls, 0);
});

test("egress: the vault value in an outbound body is blocked (smuggling)", async () => {
  let calls = 0;
  const { dir, proxy } = freshProxy(async () => {
    calls++;
    return { status: 200, headers: {}, body: "ok" };
  }, ALLOW_POLICY);
  const r = await proxy.fetch(
    { url: "https://api.test/collect", method: "POST", body: `here it is: ${CANARY}` },
    { jobId: "j1" },
  );
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "blocked:secret_in_outbound");
  assert.equal(calls, 0);
  // …and the blocked attempt's log line is redacted too.
  const log = readFileSync(join(dir, "egress.jsonl"), "utf8");
  assert.ok(!log.includes(CANARY), "canary leaked into the egress log");
  assert.ok(log.includes("blocked:secret_in_outbound"));
});

test("egress: an S1-pattern secret in an outbound body is blocked", async () => {
  let calls = 0;
  const { proxy } = freshProxy(async () => {
    calls++;
    return { status: 200, headers: {}, body: "ok" };
  }, ALLOW_POLICY);
  // "AKIA" + exactly 16 [0-9A-Z] — the scanner's aws_key shape.
  const r = await proxy.fetch(
    { url: "https://api.test/collect", method: "POST", body: "my aws key AKIAZZTEST1234567890 ok" },
    { jobId: "j1" },
  );
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "blocked:secret_pattern_in_outbound");
  assert.equal(calls, 0);
});

test("egress: an API that echoes the credential gets its echo withheld", async () => {
  const { dir, proxy } = freshProxy(async (_url, init) => {
    return { status: 200, headers: {}, body: `you sent: ${init.headers["x-api-key"]}` };
  }, ALLOW_POLICY);
  const r = await proxy.fetch(
    { url: "https://api.test/echo", secretName: "test-api" },
    { jobId: "j1" },
  );
  assert.equal(r.ok, true);
  assert.ok(!(r.body ?? "").includes(CANARY), "echoed credential reached the result");
  assert.ok((r.body ?? "").includes("[vault secret withheld: test-api]"));
  assert.ok((r.note ?? "").includes("withheld"));
  const log = readFileSync(join(dir, "egress.jsonl"), "utf8");
  assert.ok(!log.includes(CANARY), "canary leaked into the egress log");
});

test("egress: a redirect that would move the credential is blocked", async () => {
  const visited: string[] = [];
  const { proxy } = freshProxy(async (url) => {
    visited.push(url);
    return {
      status: 302,
      headers: { location: "https://evil.test/steal" },
      body: "",
    };
  }, ALLOW_POLICY);
  const r = await proxy.fetch(
    { url: "https://api.test/redir", secretName: "test-api" },
    { jobId: "j1" },
  );
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "blocked:redirect_destination_not_allowlisted");
  assert.deepEqual(visited, ["https://api.test/redir"]); // attacker never contacted
});

test("egress: a same-host redirect is followed and the credential re-injected", async () => {
  const seen: Array<Record<string, string>> = [];
  const { proxy } = freshProxy(async (url, init): Promise<EgressTransportResponse> => {
    seen.push(init.headers);
    if (url.endsWith("/redir")) {
      return { status: 302, headers: { location: "/data" }, body: "" };
    }
    return { status: 200, headers: {}, body: "the data" };
  }, ALLOW_POLICY);
  const r = await proxy.fetch(
    { url: "https://api.test/redir", secretName: "test-api" },
    { jobId: "j1" },
  );
  assert.equal(r.ok, true);
  assert.equal(r.body, "the data");
  assert.equal(seen.length, 2);
  assert.equal(seen[1]["x-api-key"], CANARY); // re-injected on the second hop
});

test("egress: a redirect to a non-allowlisted host is blocked even without a secret", async () => {
  const { proxy } = freshProxy(async () => {
    return { status: 302, headers: { location: "https://elsewhere.test/" }, body: "" };
  }, ALLOW_POLICY);
  const r = await proxy.fetch({ url: "https://api.test/redir" }, { jobId: "j1" });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "blocked:redirect_destination_not_allowlisted");
});

test("egress: every call is logged with names, verdict, and a receipt — never values", async () => {
  const { dir, proxy } = freshProxy(async () => {
    return { status: 200, headers: {}, body: "ok" };
  }, ALLOW_POLICY);
  await proxy.fetch({ url: "https://api.test/data", secretName: "test-api" }, { jobId: "job-42" });
  await proxy.fetch({ url: "https://evil.test/" }, { jobId: "job-42" });
  const lines = readFileSync(join(dir, "egress.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const [a, b] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(a.verdict, "allowed");
  assert.deepEqual(a.secretNames, ["test-api"]);
  assert.equal(a.jobId, "job-42");
  assert.ok(String(a.receiptId).startsWith("gus_rcpt_"));
  assert.equal(b.verdict, "blocked:destination_not_allowlisted");
  const receipts = readFileSync(join(dir, "egress-receipts.jsonl"), "utf8");
  assert.equal(receipts.trim().split("\n").length, 2);
  assert.ok(!receipts.includes(CANARY));
  assert.ok(existsSync(join(dir, "egress.jsonl")));
});

test("egress: a missing policy file is deny-all, not fail-open", async () => {
  const { dir, vault } = freshVault();
  vault.add("test-api", CANARY);
  chmodSync(join(dir, "vault.json"), 0o600);
  const proxy = new EgressProxy({
    vault,
    policyPath: join(dir, "no-such-policy.json"),
    logPath: join(dir, "egress.jsonl"),
    receiptsPath: join(dir, "egress-receipts.jsonl"),
    issuer: new LocalReceiptIssuer(join(dir, "receipt.key")),
    transport: async () => ({ status: 200, headers: {}, body: "ok" }),
  });
  const r = await proxy.fetch({ url: "https://api.test/data" }, { jobId: "j1" });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "blocked:destination_not_allowlisted");
});
