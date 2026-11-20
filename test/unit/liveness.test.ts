/**
 * Phase 0 (GUS-lead / Nova-fallback design, 2026-11-16): the liveness
 * beat. The properties ARE the tests: the snapshot carries exactly the
 * fields the Nova watchdog acts on and nothing else, queue depth and
 * last-settled are derived from real job states, the canary bookkeeping
 * survives a restart, and a failed write can never break the control
 * plane.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUS_VERSION } from "../../packages/shared/src/index.js";
import {
  buildLivenessSnapshot,
  canaryDue,
  readLivenessFile,
  startLivenessBeat,
  type LivenessSources,
} from "../../packages/control-plane/src/liveness.js";

function fakeSources(overrides: Partial<LivenessSources> = {}): LivenessSources {
  return {
    governorMode: () => "enforcing",
    budgetProfile: () => "standard",
    daySpentUsd: () => 0.42,
    dayCapUsd: () => 10,
    jobs: () => [],
    ...overrides,
  };
}

const NO_CANARY = { lastRunTs: null, lastOk: null };

test("liveness: snapshot shape is exactly the design's fields", () => {
  const snap = buildLivenessSnapshot(fakeSources(), NO_CANARY, 1794852300000);
  assert.deepEqual(Object.keys(snap).sort(), [
    "budgetProfile",
    "canary",
    "caps",
    "governorMode",
    "lastJobSettledTs",
    "queueDepth",
    "ts",
    "version",
  ]);
  assert.equal(snap.ts, 1794852300000);
  assert.equal(snap.version, GUS_VERSION);
  assert.equal(snap.governorMode, "enforcing");
  assert.equal(snap.budgetProfile, "standard");
  assert.deepEqual(snap.caps, { daySpentUsd: 0.42, dayCapUsd: 10 });
  assert.equal(snap.lastJobSettledTs, null);
  assert.equal(snap.queueDepth, 0);
  assert.deepEqual(snap.canary, NO_CANARY);
});

test("liveness: queue depth counts unsettled jobs; last-settled is the newest settled updatedAt", () => {
  const jobs = [
    { state: "verified-done" as const, updatedAt: 100 },
    { state: "failed-loudly" as const, updatedAt: 300 },
    { state: "verified-done" as const, updatedAt: 200 },
    { state: "running" as const, updatedAt: 400 },
    { state: "needs-approval" as const, updatedAt: 500 },
    { state: "queued" as const, updatedAt: 600 },
  ];
  const snap = buildLivenessSnapshot(fakeSources({ jobs: () => jobs }), NO_CANARY, 1000);
  assert.equal(snap.lastJobSettledTs, 300);
  assert.equal(snap.queueDepth, 3);
});

test("liveness: dayCapUsd is null when no USD day cap is configured", () => {
  const snap = buildLivenessSnapshot(fakeSources({ dayCapUsd: () => null }), NO_CANARY, 1);
  assert.equal(snap.caps.dayCapUsd, null);
});

test("liveness: the beat writes liveness.json at boot and recordCanaryResult folds into it", () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-liveness-"));
  try {
    const beat = startLivenessBeat(dir, fakeSources(), 60_000);
    const first = readLivenessFile(dir);
    assert.ok(first);
    assert.equal(first.version, GUS_VERSION);
    assert.deepEqual(first.canary, NO_CANARY);
    assert.equal(canaryDue(first.canary, first.ts), true);
    beat.recordCanaryResult(true, 5000);
    const after = readLivenessFile(dir);
    assert.ok(after);
    assert.deepEqual(after.canary, { lastRunTs: 5000, lastOk: true });
    assert.equal(canaryDue(after.canary, 5000 + 23 * 60 * 60 * 1000), false);
    assert.equal(canaryDue(after.canary, 5000 + 24 * 60 * 60 * 1000), true);
    beat.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("liveness: canary state carries across a restart (no fake never-run, no fake ok)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-liveness-"));
  try {
    const one = startLivenessBeat(dir, fakeSources(), 60_000);
    one.recordCanaryResult(false, 777);
    one.stop();
    const two = startLivenessBeat(dir, fakeSources(), 60_000);
    assert.deepEqual(two.snapshot().canary, { lastRunTs: 777, lastOk: false });
    two.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("liveness: a missing or malformed file reads as no beat", () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-liveness-"));
  try {
    assert.equal(readLivenessFile(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("liveness: a failing state dir never throws — the beat is best-effort", () => {
  const beat = startLivenessBeat("/nonexistent/no/such/dir", fakeSources(), 60_000);
  assert.equal(beat.snapshot().version, GUS_VERSION);
  beat.recordCanaryResult(true);
  beat.stop();
});

test("liveness: file content on disk is valid JSON with the design's field names", () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-liveness-"));
  try {
    const beat = startLivenessBeat(dir, fakeSources(), 60_000);
    const raw = JSON.parse(readFileSync(join(dir, "liveness.json"), "utf8")) as Record<string, unknown>;
    assert.equal(typeof raw.ts, "number");
    assert.equal(raw.governorMode, "enforcing");
    assert.deepEqual(raw.caps, { daySpentUsd: 0.42, dayCapUsd: 10 });
    beat.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
