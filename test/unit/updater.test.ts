import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { canonicalize } from "../../packages/control-plane/src/approvals.js";
import { verifyRelease, walkFiles, sha256File } from "../../packages/control-plane/src/release.js";
import {
  otherSlot,
  readPointer,
  restoreConfig,
  snapshotConfig,
  snapshotStores,
  storesPrefixIntact,
  writePointer,
} from "../../packages/control-plane/src/slots.js";
import { CanaryRunner } from "../../packages/control-plane/src/canary.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { PolicyStore } from "../../packages/control-plane/src/policy.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";

function freshDir(prefix = "gus-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function keypair(): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** Build a minimal signed release dir: VERSION + two payload files. */
function buildRelease(dir: string, version: string, priv: string): void {
  mkdirSync(join(dir, "runtime"), { recursive: true });
  writeFileSync(join(dir, "VERSION"), version + "\n");
  writeFileSync(join(dir, "runtime", "main.js"), "console.log('payload');\n");
  writeFileSync(join(dir, "README.txt"), "a release\n");
  const files: Record<string, string> = {};
  for (const rel of walkFiles(dir)) files[rel] = sha256File(join(dir, ...rel.split("/")));
  const manifest = { version, createdAt: 1_700_000_000_000, files };
  writeFileSync(join(dir, "manifest.json"), canonicalize(manifest) + "\n");
  const sig = sign(null, Buffer.from(canonicalize(manifest), "utf8"), priv);
  writeFileSync(join(dir, "manifest.sig"), sig.toString("base64") + "\n");
}

test("release verification: a properly signed, intact bundle verifies", () => {
  const { priv, pub } = keypair();
  const dir = freshDir();
  buildRelease(dir, "9.9.9", priv);
  const v = verifyRelease(dir, pub);
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.manifest.version, "9.9.9");
});

test("release verification: a file altered after signing is refused (hash mismatch)", () => {
  const { priv, pub } = keypair();
  const dir = freshDir();
  buildRelease(dir, "9.9.9", priv);
  appendFileSync(join(dir, "runtime", "main.js"), "// tampered\n");
  const v = verifyRelease(dir, pub);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /hash mismatch/);
});

test("release verification: a bundle signed by a different key is refused", () => {
  const signer = keypair();
  const other = keypair();
  const dir = freshDir();
  buildRelease(dir, "9.9.9", signer.priv);
  const v = verifyRelease(dir, other.pub);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /signature/);
});

test("release verification: unlisted extras and VERSION disagreement are refused", () => {
  const { priv, pub } = keypair();
  const dir = freshDir();
  buildRelease(dir, "9.9.9", priv);
  writeFileSync(join(dir, "smuggled.js"), "evil();\n");
  let v = verifyRelease(dir, pub);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /unlisted/);
  rmSync(join(dir, "smuggled.js"));

  writeFileSync(join(dir, "VERSION"), "9.9.8\n");
  // VERSION is itself a listed file, so this is a hash mismatch first.
  v = verifyRelease(dir, pub);
  assert.equal(v.ok, false);

  const dir2 = freshDir();
  buildRelease(dir2, "9.9.9", priv);
  // Rewrite VERSION *and* re-sign so only the VERSION/manifest
  // disagreement remains: build a manifest claiming another version.
  const files: Record<string, string> = {};
  writeFileSync(join(dir2, "VERSION"), "9.9.7\n");
  for (const rel of walkFiles(dir2)) {
    if (rel === "manifest.json" || rel === "manifest.sig") continue;
    files[rel] = sha256File(join(dir2, ...rel.split("/")));
  }
  // walkFiles includes the old manifest files — rebuild cleanly:
  delete files["manifest.json"];
  delete files["manifest.sig"];
  const manifest = { version: "9.9.9", createdAt: 1_700_000_000_000, files };
  writeFileSync(join(dir2, "manifest.json"), canonicalize(manifest) + "\n");
  writeFileSync(
    join(dir2, "manifest.sig"),
    sign(null, Buffer.from(canonicalize(manifest), "utf8"), priv).toString("base64") + "\n",
  );
  v = verifyRelease(dir2, pub);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /VERSION.*disagrees/);
});

test("slots: pointer round-trips atomically; otherSlot flips A<->B", () => {
  const dir = freshDir();
  assert.equal(readPointer(dir), null);
  writePointer(dir, { slot: "A", version: "0.3.0", previous: null, confirmPending: false, updatedAt: 1 });
  const p = readPointer(dir);
  assert.equal(p?.slot, "A");
  assert.equal(p?.version, "0.3.0");
  writePointer(dir, {
    slot: "B",
    version: "0.4.0",
    previous: { slot: "A", version: "0.3.0" },
    confirmPending: true,
    updatedAt: 2,
  });
  const p2 = readPointer(dir);
  assert.equal(p2?.confirmPending, true);
  assert.equal(p2?.previous?.slot, "A");
  assert.equal(otherSlot("A"), "B");
  assert.equal(otherSlot("B"), "A");
});

test("snapshot/rollback: config is restored; append-only stores are never touched", () => {
  const state = freshDir();
  const snap = join(state, "snapshots", "upd_test");
  writeFileSync(join(state, "governor.json"), '{"maxUsdPerTask": 5}\n');
  writeFileSync(join(state, "ledger.jsonl"), '{"kind":"settle","n":1}\n');
  writeFileSync(join(state, "jobs.jsonl"), '{"id":"j1"}\n');
  // policy.json + egress-policy.json intentionally absent.
  snapshotConfig(state, snap);
  const before = snapshotStores(state);

  // The "bad release window": config loosened, a new config file
  // created, and the data stores legitimately appended to.
  writeFileSync(join(state, "governor.json"), '{"maxUsdPerTask": 999}\n');
  writeFileSync(join(state, "policy.json"), '{"version": 99}\n');
  appendFileSync(join(state, "ledger.jsonl"), '{"kind":"settle","n":2}\n');
  appendFileSync(join(state, "jobs.jsonl"), '{"id":"j2"}\n');

  // Appends are fine — the prefix property holds BEFORE rollback.
  assert.equal(storesPrefixIntact(state, before), true);

  restoreConfig(state, snap);
  // Config is exactly as snapshotted (including absence).
  assert.equal(readFileSync(join(state, "governor.json"), "utf8"), '{"maxUsdPerTask": 5}\n');
  assert.equal(existsSync(join(state, "policy.json")), false);
  // Data stores keep their appends — rollback never reaches into them.
  assert.match(readFileSync(join(state, "ledger.jsonl"), "utf8"), /"n":2/);
  assert.match(readFileSync(join(state, "jobs.jsonl"), "utf8"), /j2/);
  assert.equal(storesPrefixIntact(state, before), true);
});

test("store integrity: tampering with recorded bytes breaks the prefix check", () => {
  const state = freshDir();
  writeFileSync(join(state, "ledger.jsonl"), "line-one\n");
  const before = snapshotStores(state);
  appendFileSync(join(state, "ledger.jsonl"), "line-two\n");
  assert.equal(storesPrefixIntact(state, before), true);
  writeFileSync(join(state, "ledger.jsonl"), "line-ONE\nline-two\n"); // same length, altered byte
  assert.equal(storesPrefixIntact(state, before), false);
});

// ------------------------------------------------------------ canary replay
//
// The replay runner is exercised against the REAL runtime build
// (packages/runtime/dist — `npm test` builds before testing), spawned
// as a child process on a temp socket with a temp workspace: the same
// shape the Phase 3 drill uses, minus the containers.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function spawnRuntime(entry: string, sock: string, ws: string): ChildProcess {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, GUS_COMM_SOCKET: sock, GUS_WORKSPACE: ws },
    stdio: "ignore",
  });
  return child;
}

function stubFetchGate() {
  return {
    fetch: async () => ({ ok: true, verdict: "allowed", status: 200, body: "public hello from the test api" }),
  };
}

async function runCanaryAgainst(entry: string): Promise<Awaited<ReturnType<CanaryRunner["run"]>>> {
  const state = freshDir("gus-canary-state-");
  const runtimeDir = freshDir("gus-canary-rt-");
  const sock = join(runtimeDir, "gus-canary.sock");
  const ws = join(runtimeDir, "ws");
  mkdirSync(ws, { recursive: true });
  const jobs = new JobRunner(state, new LocalReceiptIssuer(join(state, "receipt-stub.key")));
  const runner = new CanaryRunner(state, sock, jobs, new PolicyStore(join(state, "absent-policy.json")), stubFetchGate());
  const child = spawnRuntime(entry, sock, ws);
  try {
    return await runner.run("0.3.0", { healthTimeoutMs: 10_000, scenarioTimeoutMs: 10_000 });
  } finally {
    child.kill("SIGTERM");
  }
}

test("canary replay: the recorded scenarios pass against the real runtime", { timeout: 60_000 }, async () => {
  const report = await runCanaryAgainst(join(ROOT, "packages", "runtime", "dist", "main.js"));
  assert.equal(report.healthOk, true, report.healthDetail);
  assert.equal(report.pass, true, JSON.stringify(report.results, null, 2));
  assert.deepEqual(
    report.results.map((r) => r.name),
    ["chat", "write-verify", "fetch", "approval-park"],
  );
});

test("canary replay: a runtime whose write path corrupts content fails write-verify", { timeout: 60_000 }, async () => {
  // Assemble a bundle-shaped copy of the runtime with a tampered
  // write tool — the drill's case (c) in miniature.
  const bundle = freshDir("gus-canary-bundle-");
  cpSync(join(ROOT, "packages", "runtime", "dist"), join(bundle, "runtime"), { recursive: true });
  mkdirSync(join(bundle, "node_modules", "@gus"), { recursive: true });
  cpSync(join(ROOT, "packages", "shared"), join(bundle, "node_modules", "@gus", "shared"), { recursive: true });
  const toolsPath = join(bundle, "runtime", "tools.js");
  const tools = readFileSync(toolsPath, "utf8");
  assert.match(tools, /writeFileSync\(full, content\);/);
  writeFileSync(toolsPath, tools.replace("writeFileSync(full, content);", 'writeFileSync(full, content + " [tampered]");'));
  const report = await runCanaryAgainst(join(bundle, "runtime", "main.js"));
  assert.equal(report.healthOk, true, report.healthDetail);
  assert.equal(report.pass, false);
  const write = report.results.find((r) => r.name === "write-verify");
  assert.equal(write?.ok, false);
});
