import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Governor } from "../../packages/control-plane/src/governor.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-test-"));
}

test("governor authorizes, meters, and enforces the per-job cap", () => {
  const g = new Governor(freshDir(), { maxTokensPerJob: 100, maxTokensPerDay: 10_000 });
  assert.deepEqual(g.authorize("j1", 60), { ok: true });
  g.record({ ts: Date.now(), jobId: "j1", model: "fake", tokensIn: 40, tokensOut: 30, costUsd: 0 });
  const d = g.authorize("j1", 40);
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, "cap_exceeded");
  assert.deepEqual(g.authorize("j2", 40), { ok: true }); // other jobs unaffected
});

test("kill switch persists across Governor instances and blocks all spend", () => {
  const dir = freshDir();
  const g1 = new Governor(dir);
  assert.equal(g1.isKilled(), false);
  g1.setKilled(true, "test");
  const g2 = new Governor(dir); // "restart"
  assert.equal(g2.isKilled(), true);
  const d = g2.authorize("j1", 1);
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, "killed");
  g2.setKilled(false, "test");
  assert.equal(new Governor(dir).isKilled(), false);
});

test("job lifecycle: only legal transitions; settlement issues a verifiable receipt", () => {
  const dir = freshDir();
  const issuer = new LocalReceiptIssuer(join(dir, "key"));
  const jobs = new JobRunner(dir, issuer);
  const job = jobs.create("chat", "conv1", "hello");
  assert.throws(() => jobs.transition(job.id, "verified-done")); // queued -> done illegal
  jobs.transition(job.id, "running");
  const settled = jobs.transition(job.id, "verified-done", "post-condition ok");
  assert.ok(settled.receiptId);
  assert.throws(() => jobs.transition(job.id, "running")); // terminal is terminal
});

test("needs-approval parks and can still fail loudly", () => {
  const dir = freshDir();
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "key")));
  const job = jobs.create("workspace-file", "conv1", "delete 3 files");
  jobs.transition(job.id, "running");
  jobs.transition(job.id, "needs-approval");
  const settled = jobs.transition(job.id, "failed-loudly", "denied by operator");
  assert.equal(settled.state, "failed-loudly");
  assert.ok(settled.receiptId);
});

test("outcome notes are secret-guard screened before persisting", () => {
  const dir = freshDir();
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "key")));
  const job = jobs.create("chat", "conv1", "hi");
  jobs.transition(job.id, "running");
  const settled = jobs.transition(job.id, "failed-loudly", "boom near AKIAGUSTEST123456789 oops");
  assert.ok(!settled.outcomeNote?.includes("AKIAGUSTEST123456789"));
  assert.ok(settled.outcomeNote?.includes("[secret refused: aws_key]"));
});
