/**
 * v0.14.6: the budget profile (budget-profile.ts) — one operator
 * setting that scales the Governor's caps.
 *
 * The properties ARE the tests: standard is the identity (the
 * configured caps exactly); generous/max multiply every cap,
 * token and USD alike, and never touch prices; unlimited
 * removes enforcement but NOT accounting (the ledger still
 * counts and receipts); a missing or malformed profile file
 * reads as standard, never as "no caps"; the profile is live
 * on the next authorization without a restart; and an
 * explicitly-configured Governor (tests, the canary) is
 * isolated from the install's profile — it runs exactly the
 * caps it was handed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Governor, type GovernorConfig } from "../../packages/control-plane/src/governor.js";
import {
  applyBudgetProfile,
  loadBudgetProfile,
  writeBudgetProfile,
} from "../../packages/control-plane/src/budget-profile.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-budget-"));
}

const BASE: GovernorConfig = {
  maxTokensPerJob: 20_000,
  maxTokensPerDay: 200_000,
  maxUsdPerTask: 2,
  maxUsdPerDay: 10,
  maxUsdPerMonth: 100,
  pricesUsdPer1k: { "test/model": 0.01 },
};

test("budget profile: standard is the identity — configured caps exactly", () => {
  assert.deepEqual(applyBudgetProfile(BASE, "standard"), BASE);
});

test("budget profile: generous and max multiply every cap and never the prices", () => {
  const g = applyBudgetProfile(BASE, "generous");
  assert.equal(g.maxTokensPerJob, 200_000);
  assert.equal(g.maxTokensPerDay, 2_000_000);
  assert.equal(g.maxUsdPerTask, 20);
  assert.equal(g.maxUsdPerDay, 100);
  assert.equal(g.maxUsdPerMonth, 1_000);
  assert.deepEqual(g.pricesUsdPer1k, BASE.pricesUsdPer1k, "prices are facts, not a posture");

  const m = applyBudgetProfile(BASE, "max");
  assert.equal(m.maxTokensPerJob, 2_000_000);
  assert.equal(m.maxUsdPerDay, 1_000);

  const sparse = applyBudgetProfile({ maxTokensPerJob: 100, maxTokensPerDay: 1_000 }, "max");
  assert.equal(sparse.maxUsdPerDay, undefined, "an unconfigured USD cap stays unconfigured");
});

test("budget profile: unlimited removes the caps and keeps the price table", () => {
  const u = applyBudgetProfile(BASE, "unlimited");
  assert.equal(u.maxTokensPerJob, Number.POSITIVE_INFINITY);
  assert.equal(u.maxTokensPerDay, Number.POSITIVE_INFINITY);
  assert.equal(u.maxUsdPerTask, undefined);
  assert.equal(u.maxUsdPerDay, undefined);
  assert.equal(u.maxUsdPerMonth, undefined);
  assert.deepEqual(u.pricesUsdPer1k, BASE.pricesUsdPer1k);
});

test("budget profile: missing or malformed file reads as standard, never as no-caps", () => {
  const dir = freshDir();
  assert.equal(loadBudgetProfile(dir), "standard");
  writeFileSync(join(dir, "budget-profile.json"), "{not json", { mode: 0o600 });
  assert.equal(loadBudgetProfile(dir), "standard");
  writeFileSync(join(dir, "budget-profile.json"), JSON.stringify({ profile: "yolo" }), { mode: 0o600 });
  assert.equal(loadBudgetProfile(dir), "standard", "an unknown profile name falls back to standard");
});

test("budget profile: the write round-trips and the file is 0600", () => {
  const dir = freshDir();
  writeBudgetProfile(dir, "max", "test");
  assert.equal(loadBudgetProfile(dir), "max");
  assert.equal(statSync(join(dir, "budget-profile.json")).mode & 0o777, 0o600);
});

test("budget profile: standard binds at the configured cap; max lifts it, live", () => {
  const dir = freshDir();
  const gov = new Governor(dir); // no fixed config: governor.json absent = defaults (20k/job)
  assert.equal(gov.budgetProfile(), "standard");
  const over = gov.authorize("job-a", 20_001);
  assert.equal(over.ok, false);
  assert.equal(over.reason, "cap_exceeded");

  writeBudgetProfile(dir, "max", "test");
  assert.equal(gov.budgetProfile(), "max");
  assert.equal(gov.effectiveConfig().maxTokensPerJob, 2_000_000);
  const under = gov.authorize("job-a", 25_000);
  assert.equal(under.ok, true, "the Cycle 0 workload that died at 20k authorizes under max");
});

test("budget profile: unlimited authorizes anything and still accounts for it", () => {
  const dir = freshDir();
  writeBudgetProfile(dir, "unlimited", "test");
  const gov = new Governor(dir);
  const big = gov.authorize("job-big", 10_000_000, 0, "muse-spark-1.3");
  assert.equal(big.ok, true);
  const cost = gov.settle(big.reservationId!, 10_000, 0);
  assert.ok(cost > 0, "a priced model still meters under unlimited");
  assert.ok(gov.spendSummary().todayUsd > 0, "accounting continues with enforcement off");
  assert.equal(gov.audit().reconciles, true);
});

test("budget profile: an explicitly-configured Governor is isolated from the profile", () => {
  const dir = freshDir();
  writeBudgetProfile(dir, "unlimited", "test");
  const gov = new Governor(dir, { maxTokensPerJob: 100, maxTokensPerDay: 10_000 });
  assert.equal(gov.budgetProfile(), "standard");
  const over = gov.authorize("job-x", 101);
  assert.equal(over.ok, false, "a fixed-config Governor runs exactly the caps it was handed");
});
