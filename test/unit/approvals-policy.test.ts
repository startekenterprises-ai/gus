import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PolicyStore,
  DEFAULT_POLICY,
  type PolicyData,
} from "../../packages/control-plane/src/policy.js";
import {
  ApprovalEngine,
  argsHashFor,
  canonicalize,
} from "../../packages/control-plane/src/approvals.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-test-"));
}

function storeWith(policy: Partial<PolicyData>): PolicyStore {
  const dir = freshDir();
  const path = join(dir, "policy.json");
  writeFileSync(path, JSON.stringify({ ...DEFAULT_POLICY, ...policy }));
  return new PolicyStore(path);
}

const noFileStore = () => new PolicyStore(join(freshDir(), "policy.json"));

// ------------------------------------------------------------- classifier

test("classifier: read and in-workspace write proceed without approval", () => {
  const s = noFileStore();
  assert.equal(s.classify({ tool: "workspace_read", declaredClass: "read", args: { path: "a.txt" } }).action, "allow");
  assert.equal(
    s.classify({ tool: "workspace_write", declaredClass: "write", args: { path: "notes/a.txt", content: "x" } }).action,
    "allow",
  );
  assert.equal(s.classify({ tool: "fetch", declaredClass: "read", args: { url: "http://x.test/" } }).action, "allow");
});

test("classifier: destructive class always parks, whatever the tool claims to be doing", () => {
  const s = noFileStore();
  const c = s.classify({ tool: "bulk_delete", declaredClass: "destructive", args: { paths: ["a.txt"] } });
  assert.equal(c.action, "needs-approval");
  assert.equal(c.effectiveClass, "destructive");
  assert.equal(
    s.classify({ tool: "send_email", declaredClass: "external-send", args: {} }).action,
    "needs-approval",
  );
  assert.equal(s.classify({ tool: "charge_card", declaredClass: "pay", args: {} }).action, "needs-approval");
});

test("classifier: the declared class is a floor, never a downgrade — and bulk hides nowhere", () => {
  const s = noFileStore();
  // A destructive call mislabeled "read" still parks: classification is
  // recomputed from tool + arguments, and bulk_delete is destructive by
  // name via the bulk rule even under a lying label.
  const c = s.classify({
    tool: "bulk_delete",
    declaredClass: "read",
    args: { paths: ["1", "2", "3", "4", "5", "6"] },
  });
  assert.equal(c.action, "needs-approval");
  // Bulk threshold from policy: 6 items >= default threshold 5.
  const bulk = s.classify({
    tool: "bulk_move",
    declaredClass: "write",
    args: { count: 6 },
  });
  assert.equal(bulk.action, "needs-approval");
  const small = s.classify({ tool: "bulk_move", declaredClass: "write", args: { count: 2 } });
  assert.equal(small.action, "allow");
});

test("classifier: credential use parks; the same fetch without a secret proceeds", () => {
  const s = noFileStore();
  const withSecret = s.classify({
    tool: "fetch",
    declaredClass: "read",
    args: { url: "http://api.test/data", secretName: "test-api" },
  });
  assert.equal(withSecret.action, "needs-approval");
  assert.match(withSecret.reason, /credential use/);
  assert.equal(
    s.classify({ tool: "fetch", declaredClass: "read", args: { url: "http://api.test/data" } }).action,
    "allow",
  );
});

test("classifier: a write escaping the workspace parks (and the jail would refuse it anyway)", () => {
  const s = noFileStore();
  const esc = s.classify({
    tool: "workspace_write",
    declaredClass: "write",
    args: { path: "../escape.txt", content: "x" },
  });
  assert.equal(esc.action, "needs-approval");
  assert.equal(esc.effectiveClass, "destructive");
  const sneaky = s.classify({
    tool: "workspace_write",
    declaredClass: "write",
    args: { path: "a/../../escape.txt", content: "x" },
  });
  assert.equal(sneaky.action, "needs-approval");
  const legit = s.classify({
    tool: "workspace_write",
    declaredClass: "write",
    args: { path: "a/../b.txt", content: "x" },
  });
  assert.equal(legit.action, "allow"); // resolves inside the workspace
});

test("classifier: vault_read is hard-denied in code — no policy rule can allow it", () => {
  const s = storeWith({ rules: [{ tool: "vault_read", action: "allow" }] });
  const c = s.classify({ tool: "vault_read", declaredClass: "read", args: { name: "test-api" } });
  assert.equal(c.action, "deny");
});

test("classifier: policy rules can deny, and can park an otherwise-allowed tool", () => {
  const s = storeWith({
    rules: [
      { tool: "send_email", action: "deny", reason: "mail sending is disabled by the operator" },
      { tool: "fetch", usesSecret: false, action: "needs-approval", reason: "operator wants to see every fetch" },
    ],
  });
  // deny rule beats the external-send approval floor (deny is stronger).
  assert.equal(s.classify({ tool: "send_email", declaredClass: "external-send", args: {} }).action, "deny");
  assert.equal(
    s.classify({ tool: "fetch", declaredClass: "read", args: { url: "http://x.test/" } }).action,
    "needs-approval",
  );
});

test("classifier: a policy rule can NEVER lower a destructive call below approval", () => {
  const s = storeWith({ rules: [{ tool: "bulk_delete", action: "allow" }] });
  assert.equal(
    s.classify({ tool: "bulk_delete", declaredClass: "destructive", args: { paths: ["a"] } }).action,
    "needs-approval",
  );
});

test("classifier: a missing or malformed policy file still enforces the built-ins", () => {
  const missing = noFileStore();
  assert.equal(
    missing.classify({ tool: "bulk_delete", declaredClass: "destructive", args: { paths: ["a"] } }).action,
    "needs-approval",
  );
  const dir = freshDir();
  const path = join(dir, "policy.json");
  writeFileSync(path, "{not json");
  const malformed = new PolicyStore(path);
  assert.equal(
    malformed.classify({ tool: "fetch", declaredClass: "read", args: { url: "u", secretName: "k" } }).action,
    "needs-approval",
  );
});

// ------------------------------------------------------------- hash binding

test("args hash: canonical — key order is irrelevant, any value change voids it", () => {
  const a = argsHashFor("bulk_delete", { paths: ["x.txt", "y.txt"], count: 2 });
  const b = argsHashFor("bulk_delete", { count: 2, paths: ["x.txt", "y.txt"] });
  assert.equal(a, b);
  assert.notEqual(a, argsHashFor("bulk_delete", { paths: ["x.txt", "z.txt"], count: 2 }));
  assert.notEqual(a, argsHashFor("bulk_delete", { paths: ["x.txt", "y.txt"], count: 3 }));
  assert.notEqual(a, argsHashFor("workspace_write", { paths: ["x.txt", "y.txt"], count: 2 }));
  assert.equal(canonicalize({ b: 1, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":1}');
});

// ------------------------------------------------------------- engine

test("approvals: create → approve → consume is single-use and hash-bound", () => {
  const engine = new ApprovalEngine(freshDir(), () => 60_000);
  const req = engine.create({
    jobId: "j1",
    conversationId: "c1",
    tool: "bulk_delete",
    args: { paths: ["a.txt"] },
    reason: "test",
  });
  assert.equal(req.status, "pending");
  assert.equal(req.argsHash, argsHashFor("bulk_delete", { paths: ["a.txt"] }));
  // Not executable before approval; wrong args never match.
  assert.equal(engine.findExecutable("j1", "bulk_delete", { paths: ["a.txt"] }), undefined);
  engine.resolve(req.id, "approved", "channel-button");
  assert.equal(engine.findExecutable("j1", "bulk_delete", { paths: ["a.txt"] })?.id, req.id);
  assert.equal(engine.findExecutable("j1", "bulk_delete", { paths: ["b.txt"] }), undefined); // replay w/ different args
  assert.equal(engine.findExecutable("j2", "bulk_delete", { paths: ["a.txt"] }), undefined); // another job's approval
  engine.consume(req.id);
  assert.equal(engine.findExecutable("j1", "bulk_delete", { paths: ["a.txt"] }), undefined); // consumed = gone
  assert.throws(() => engine.resolve(req.id, "approved", "channel-button")); // no double resolution
  engine.stop();
});

test("approvals: denial is terminal and recorded", () => {
  const engine = new ApprovalEngine(freshDir(), () => 60_000);
  const req = engine.create({ jobId: "j1", conversationId: "c1", tool: "bulk_delete", args: { paths: ["a"] }, reason: "t" });
  const denied = engine.resolve(req.id, "denied", "channel-command");
  assert.equal(denied.status, "denied");
  assert.equal(denied.resolvedBy, "channel-command");
  assert.throws(() => engine.consume(req.id));
  engine.stop();
});

test("approvals: timeout = deny — expiry fires the callback and blocks late resolution", () => {
  const engine = new ApprovalEngine(freshDir(), () => 50);
  const expired: string[] = [];
  engine.onExpire = (r) => expired.push(r.id);
  const req = engine.create({ jobId: "j1", conversationId: "c1", tool: "bulk_delete", args: { paths: ["a"] }, reason: "t" });
  engine.sweepExpired(Date.now() + 10_000); // clock past the deadline
  assert.equal(engine.get(req.id)?.status, "expired");
  assert.deepEqual(expired, [req.id]);
  assert.throws(() => engine.resolve(req.id, "approved", "channel-button"), /expired/);
  engine.stop();
});

test("approvals: durable across engine instances (restart-safe by construction)", () => {
  const dir = freshDir();
  const e1 = new ApprovalEngine(dir, () => 60_000);
  const req = e1.create({ jobId: "j1", conversationId: "c1", tool: "fetch", args: { url: "http://x/", secretName: "k" }, reason: "t" });
  e1.resolve(req.id, "approved", "channel-button");
  e1.stop();
  const e2 = new ApprovalEngine(dir, () => 60_000);
  const loaded = e2.get(req.id);
  assert.equal(loaded?.status, "approved");
  assert.equal(loaded?.argsHash, req.argsHash);
  assert.equal(e2.findExecutable("j1", "fetch", { url: "http://x/", secretName: "k" })?.id, req.id);
  e2.stop();
});

test("approvals: one pending approval per job; parked args are secret-screened", () => {
  const engine = new ApprovalEngine(freshDir(), () => 60_000);
  engine.create({ jobId: "j1", conversationId: "c1", tool: "bulk_delete", args: { paths: ["a"] }, reason: "t" });
  assert.throws(() =>
    engine.create({ jobId: "j1", conversationId: "c1", tool: "bulk_delete", args: { paths: ["b"] }, reason: "t" }),
  );
  const withSecret = engine.create({
    jobId: "j2",
    conversationId: "c1",
    tool: "workspace_write",
    args: { path: "x.txt", content: "key is AKIAGUSTEST123456789 ok" },
    reason: "t",
  });
  assert.ok(!JSON.stringify(withSecret.args).includes("AKIAGUSTEST123456789"));
  engine.stop();
});
