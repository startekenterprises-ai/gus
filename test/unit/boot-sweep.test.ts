/**
 * Phase 5: the Job Runner boot sweep.
 *
 * A job left queued/running by a control-plane incarnation that died
 * has no driver in the next one. The sweep settles it failed-loudly
 * with a receipt at boot (spec §1.5 — no silent failure), the job-side
 * twin of the Governor's orphan-reservation sweep. Parked
 * (needs-approval) jobs are NOT swept: approvals are durable state
 * that survives restarts by design. Update jobs are swept only on
 * request — the Updater's bootReconcile owns them while an update
 * record is in flight (promotion works by exiting the process).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-bootsweep-"));
}

function runner(dir: string): JobRunner {
  return new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
}

/** Simulate a crash + restart: build state with one incarnation, then
 *  construct a fresh runner over the same store and sweep. */
function crashAndSweep(
  dir: string,
  build: (jobs: JobRunner) => void,
  opts?: { includeUpdateJobs?: boolean },
) {
  const first = runner(dir);
  build(first);
  const second = runner(dir); // the "restarted" incarnation
  const swept = second.sweepOrphanedJobs(opts);
  return { second, swept };
}

test("boot sweep: a queued job left by a dead incarnation settles failed-loudly with a receipt", () => {
  const dir = freshDir();
  let jobId = "";
  const { second, swept } = crashAndSweep(dir, (jobs) => {
    jobId = jobs.create("chat", "conv1", "hello").id; // never picked up
  });
  assert.equal(swept.length, 1);
  assert.equal(swept[0].id, jobId);
  const rec = second.get(jobId);
  assert.equal(rec?.state, "failed-loudly");
  assert.ok(rec?.receiptId, "settlement issued a receipt");
  assert.match(rec?.outcomeNote ?? "", /boot sweep/);
  const receipts = readFileSync(join(dir, "receipts.jsonl"), "utf8");
  assert.ok(receipts.includes(rec!.receiptId!), "receipt persisted to receipts.jsonl");
});

test("boot sweep: a running job left mid-flight settles failed-loudly", () => {
  const dir = freshDir();
  let jobId = "";
  const { second, swept } = crashAndSweep(dir, (jobs) => {
    const j = jobs.create("workspace-file", "conv1", "organize files");
    jobs.transition(j.id, "running");
    jobId = j.id;
  });
  assert.equal(swept.length, 1);
  assert.equal(second.get(jobId)?.state, "failed-loudly");
});

test("boot sweep: parked (needs-approval) jobs are NOT swept — approvals survive restarts", () => {
  const dir = freshDir();
  let jobId = "";
  const { second, swept } = crashAndSweep(dir, (jobs) => {
    const j = jobs.create("workspace-file", "conv1", "delete 5 files");
    jobs.transition(j.id, "running");
    jobs.transition(j.id, "needs-approval");
    jobId = j.id;
  });
  assert.equal(swept.length, 0);
  assert.equal(second.get(jobId)?.state, "needs-approval");
});

test("boot sweep: settled jobs are untouched and a clean boot sweeps nothing", () => {
  const dir = freshDir();
  let doneId = "";
  const { second, swept } = crashAndSweep(dir, (jobs) => {
    const j = jobs.create("chat", "conv1", "hi");
    jobs.transition(j.id, "running");
    jobs.transition(j.id, "verified-done", "post-condition ok");
    doneId = j.id;
  });
  assert.equal(swept.length, 0);
  assert.equal(second.get(doneId)?.state, "verified-done");
  // Second sweep on the same incarnation is a no-op (idempotent).
  assert.equal(second.sweepOrphanedJobs().length, 0);
  assert.ok(existsSync(join(dir, "jobs.jsonl")));
});

test("boot sweep: update jobs are skipped by default, swept when explicitly included", () => {
  const dir = freshDir();
  let jobId = "";
  const { second, swept } = crashAndSweep(dir, (jobs) => {
    const j = jobs.create("update", "conv1", "update to 0.4.0");
    jobs.transition(j.id, "running");
    jobId = j.id;
  });
  assert.equal(swept.length, 0, "bootReconcile owns in-flight update jobs");
  assert.equal(second.get(jobId)?.state, "running");
  const late = second.sweepOrphanedJobs({ includeUpdateJobs: true });
  assert.equal(late.length, 1);
  assert.equal(second.get(jobId)?.state, "failed-loudly");
});
