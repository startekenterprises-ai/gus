/**
 * Phase 5: egress DNS pinning.
 *
 * The allowlist matches hostnames; pinning makes the CONNECTION match
 * the name that was checked. The proxy resolves each hop once, and
 * verifies the socket's actual remote address is in the resolved set
 * before any response byte is screened or returned. A mismatch is a
 * rebinding attempt: blocked, bytes discarded. The built-in transport
 * additionally pins the socket itself (createConnection override), proven
 * end-to-end against a local server under an unresolvable name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultBroker } from "../../packages/vault/src/index.js";
import {
  EgressProxy,
  type EgressResolver,
  type EgressTransport,
  type EgressTransportResponse,
} from "../../packages/egress/src/index.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";

let lastLogPath = "";
function makeProxy(opts: {
  transport?: EgressTransport;
  resolver?: EgressResolver;
  policy: unknown;
}): EgressProxy {
  const dir = mkdtempSync(join(tmpdir(), "gus-dns-"));
  const vault = new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key"));
  const policyPath = join(dir, "egress-policy.json");
  writeFileSync(policyPath, JSON.stringify(opts.policy));
  lastLogPath = join(dir, "egress.jsonl");
  return new EgressProxy({
    vault,
    policyPath,
    logPath: join(dir, "egress.jsonl"),
    receiptsPath: join(dir, "egress-receipts.jsonl"),
    issuer: new LocalReceiptIssuer(join(dir, "receipt.key")),
    transport: opts.transport,
    resolver: opts.resolver,
  });
}

const POLICY = { allow: [{ host: "api.test", ports: [443] }], injections: [] };

test("dns: resolved address matches the connected peer — allowed, pin in the audit log", async () => {
  const proxy = makeProxy({
    policy: POLICY,
    resolver: async () => ["93.184.216.34"],
    transport: async () => ({ status: 200, headers: {}, body: "hello", remoteAddress: "93.184.216.34" }),
  });
  const r = await proxy.fetch({ url: "https://api.test/data" }, { jobId: "j1" });
  assert.equal(r.verdict, "allowed");
  assert.equal(r.body, "hello");
  // Pinning evidence belongs in the audit log, NOT in the model-facing
  // result notes — the tool-result text surface stays byte-stable.
  assert.doesNotMatch(r.note ?? "", /DNS|pinned/);
  const entry = JSON.parse(readFileSync(lastLogPath, "utf8").trim().split("\n").pop()!);
  assert.equal(entry.verdict, "allowed");
  assert.equal(entry.remoteAddress, "93.184.216.34");
});

test("dns: peer outside the resolved set is a rebinding — blocked, body discarded", async () => {
  const proxy = makeProxy({
    policy: POLICY,
    resolver: async () => ["93.184.216.34"],
    transport: async () => ({ status: 200, headers: {}, body: "internal secrets", remoteAddress: "10.0.0.9" }),
  });
  const r = await proxy.fetch({ url: "https://api.test/data" }, { jobId: "j2" });
  assert.equal(r.verdict, "blocked:dns_rebinding_detected");
  assert.equal(r.body, undefined);
});

test("dns: resolution failure blocks before any connection is attempted", async () => {
  let transportCalls = 0;
  const proxy = makeProxy({
    policy: POLICY,
    resolver: async () => {
      throw new Error("ENOTFOUND");
    },
    transport: async () => {
      transportCalls++;
      return { status: 200, headers: {}, body: "x" };
    },
  });
  const r = await proxy.fetch({ url: "https://api.test/data" }, { jobId: "j3" });
  assert.equal(r.verdict, "blocked:dns_resolution_failed");
  assert.equal(transportCalls, 0);
});

test("dns: an empty resolution blocks the same way", async () => {
  const proxy = makeProxy({
    policy: POLICY,
    resolver: async () => [],
    transport: async () => ({ status: 200, headers: {}, body: "x" }),
  });
  const r = await proxy.fetch({ url: "https://api.test/data" }, { jobId: "j4" });
  assert.equal(r.verdict, "blocked:dns_resolution_failed");
});

test("dns: IP-literal destinations never consult the resolver — the literal is the pin", async () => {
  let resolverCalls = 0;
  const proxy = makeProxy({
    policy: { allow: [{ host: "127.0.0.1", ports: [8901] }], injections: [] },
    resolver: async () => {
      resolverCalls++;
      throw new Error("resolver must not be consulted for IP literals");
    },
    transport: async () => ({ status: 200, headers: {}, body: "ok", remoteAddress: "127.0.0.1" }),
  });
  const r = await proxy.fetch({ url: "http://127.0.0.1:8901/x" }, { jobId: "j5" });
  assert.equal(r.verdict, "allowed");
  assert.equal(resolverCalls, 0);
});

test("dns: a redirect hop is re-resolved and re-verified — rebinding on hop 2 blocks", async () => {
  const policy = {
    allow: [
      { host: "a.test", ports: [443] },
      { host: "b.test", ports: [443] },
    ],
    injections: [],
  };
  const proxy = makeProxy({
    policy,
    resolver: async (host) => (host === "a.test" ? ["1.1.1.1"] : ["2.2.2.2"]),
    transport: async (url): Promise<EgressTransportResponse> => {
      if (url.startsWith("https://a.test/")) {
        return { status: 302, headers: { location: "https://b.test/landing" }, body: "", remoteAddress: "1.1.1.1" };
      }
      // b.test resolved to 2.2.2.2 but the socket landed elsewhere.
      return { status: 200, headers: {}, body: "rebound", remoteAddress: "9.9.9.9" };
    },
  });
  const r = await proxy.fetch({ url: "https://a.test/start" }, { jobId: "j6" });
  assert.equal(r.verdict, "blocked:dns_rebinding_detected");
  assert.equal(r.body, undefined);
});

test("dns: injected transport without a resolver and no reported peer stays allowed (back-compat)", async () => {
  const proxy = makeProxy({
    policy: POLICY,
    transport: async () => ({ status: 200, headers: {}, body: "fine" }),
  });
  const r = await proxy.fetch({ url: "https://api.test/data" }, { jobId: "j7" });
  assert.equal(r.verdict, "allowed");
});

test("dns: built-in pinned transport connects by resolved IP under an unresolvable name", async () => {
  let seenHost = "";
  const server = createServer((req, res) => {
    seenHost = req.headers.host ?? "";
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pinned-ok");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  try {
    const proxy = makeProxy({
      policy: { allow: [{ host: "pin.test", ports: [port] }], injections: [] },
      resolver: async (host) => {
        assert.equal(host, "pin.test"); // "pin.test" resolves nowhere publicly
        return ["127.0.0.1"];
      },
      // no transport: the built-in pinned transport must do the work
    });
    const r = await proxy.fetch({ url: `http://pin.test:${port}/hello` }, { jobId: "j8" });
    assert.equal(r.verdict, "allowed");
    assert.equal(r.body, "pinned-ok");
    assert.equal(seenHost, `pin.test:${port}`, "name preserved for Host/SNI; only the socket was pinned");
  } finally {
    server.close();
  }
});

test("dns: built-in transport falls through the resolved set until one address connects", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("second-address");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  try {
    const proxy = makeProxy({
      policy: { allow: [{ host: "pin.test", ports: [port] }], injections: [] },
      resolver: async () => ["127.0.0.2", "127.0.0.1"], // nothing listens on .2
    });
    const r = await proxy.fetch({ url: `http://pin.test:${port}/` }, { jobId: "j9" });
    assert.equal(r.verdict, "allowed");
    assert.equal(r.body, "second-address");
  } finally {
    server.close();
  }
});
