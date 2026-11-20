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
  const a = g.authorize("j1", 60);
  assert.equal(a.ok, true);
  if (a.ok) g.settle(a.reservationId, 40, 30); // 70 tokens settled
  const d = g.authorize("j1", 40);
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, "cap_exceeded");
  const other = g.authorize("j2", 40); // other jobs unaffected
  assert.equal(other.ok, true);
  if (other.ok) g.settle(other.reservationId, 40, 0);
});

test("governor: an open reservation holds against the cap until settled or refunded", () => {
  const g = new Governor(freshDir(), { maxTokensPerJob: 100, maxTokensPerDay: 10_000 });
  const a = g.authorize("j1", 80);
  assert.equal(a.ok, true);
  // 80 tokens are RESERVED: a second call for 30 must refuse even though
  // nothing has settled yet — this is what stops racing/looping spend.
  assert.equal(g.authorize("j1", 30).ok, false);
  if (a.ok) g.refund(a.reservationId, "provider_error");
  const b = g.authorize("j1", 30); // refund freed the budget
  assert.equal(b.ok, true);
  if (b.ok) g.settle(b.reservationId, 30, 0);
});

test("governor: USD caps price through the table and cut at the cap", () => {
  // $10 per 1k tokens => 10 tokens = $0.10 exactly.
  const g = new Governor(freshDir(), {
    maxTokensPerJob: 1_000_000,
    maxTokensPerDay: 1_000_000,
    maxUsdPerTask: 0.25,
    pricesUsdPer1k: { "priced-model": 10 },
  });
  const call = () => g.authorize("job", 10, 0, "priced-model");
  const c1 = call();
  assert.equal(c1.ok, true);
  if (c1.ok) assert.equal(g.settle(c1.reservationId, 10, 0), 0.1);
  const c2 = call();
  assert.equal(c2.ok, true);
  if (c2.ok) g.settle(c2.reservationId, 10, 0);
  const c3 = call(); // $0.20 settled + $0.10 estimate > $0.25 cap
  assert.equal(c3.ok, false);
  if (!c3.ok) {
    assert.equal(c3.reason, "cap_exceeded");
    assert.match(c3.detail, /per-task spend cap/);
  }
  // A different job has its own per-task budget.
  const other = g.authorize("other-job", 10, 0, "priced-model");
  assert.equal(other.ok, true);
  if (other.ok) g.settle(other.reservationId, 10, 0);
});

test("governor: per-day USD cap binds across jobs", () => {
  const g = new Governor(freshDir(), {
    maxTokensPerJob: 1_000_000,
    maxTokensPerDay: 1_000_000,
    maxUsdPerDay: 0.15,
    pricesUsdPer1k: { "priced-model": 10 },
  });
  const a = g.authorize("j1", 10, 0, "priced-model");
  assert.equal(a.ok, true);
  if (a.ok) g.settle(a.reservationId, 10, 0);
  const b = g.authorize("j2", 10, 0, "priced-model"); // would make $0.20 > $0.15
  assert.equal(b.ok, false);
  if (!b.ok) assert.match(b.detail, /per-day spend cap/);
});

test("governor: ledger reconciles — reserves = settles + refunds, nothing left open", () => {
  const g = new Governor(freshDir(), {
    maxTokensPerJob: 1_000_000,
    maxTokensPerDay: 1_000_000,
    pricesUsdPer1k: { "priced-model": 10 },
  });
  const a = g.authorize("j1", 10, 0, "priced-model");
  const b = g.authorize("j1", 10, 0, "priced-model");
  assert.equal(a.ok && b.ok, true);
  if (a.ok) g.settle(a.reservationId, 10, 0);
  if (b.ok) g.refund(b.reservationId, "provider_error");
  const audit = g.audit();
  assert.deepEqual(
    { r: audit.reserves, s: audit.settles, f: audit.refunds, open: audit.openReservations },
    { r: 2, s: 1, f: 1, open: 0 },
  );
  assert.equal(audit.reconciles, true);
  assert.equal(audit.settledUsd, 0.1);
  // Double-settle / double-refund are bugs and must throw, not paper over.
  if (a.ok) assert.throws(() => g.settle(a.reservationId, 1, 1));
  if (b.ok) assert.throws(() => g.refund(b.reservationId, "again"));
});

test("governor: a restart refunds orphan reservations instead of wedging the caps", () => {
  const dir = freshDir();
  const cfg = { maxTokensPerJob: 100, maxTokensPerDay: 10_000 };
  const g1 = new Governor(dir, cfg);
  const a = g1.authorize("j1", 90);
  assert.equal(a.ok, true);
  // "Crash" with the reservation open; a fresh Governor on the same
  // state dir sweeps it to a refund, so the budget is usable again and
  // the ledger still reconciles.
  const g2 = new Governor(dir, cfg);
  assert.equal(g2.audit().reconciles, true);
  assert.equal(g2.audit().refunds, 1);
  assert.equal(g2.authorize("j1", 90).ok, true);
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
