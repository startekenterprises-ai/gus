#!/usr/bin/env node
/**
 * perf-bench.mjs — poll-cost + boot-cost benchmark for the GUS control
 * plane's operator read paths (R2 performance work, v0.14.0).
 *
 * Builds a synthetic state dir sized like a well-used install
 * (months of jobs/scans/chat), then times the exact calls the
 * desktop app's 2.5 s poll makes server-side:
 *   Governor.spendSummary()        (GET /api/status)
 *   PanelChatAdapter.history()     (GET /api/chat/history)
 *   readWatchTimeline(dir, 60)     (GET /api/watch/timeline)
 * plus cold construction (boot): Governor + JobRunner + ApprovalEngine.
 *
 * Usage: node scripts/perf-bench.mjs [--keep]
 * Prints per-call ms (mean of N after one warm-up) and file sizes.
 */
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Governor } from "../packages/control-plane/dist/governor.js";
import { JobRunner } from "../packages/control-plane/dist/jobs.js";
import { ApprovalEngine } from "../packages/control-plane/dist/approvals.js";
import { PanelChatAdapter } from "../packages/control-plane/dist/panel-chat.js";
import { readWatchTimeline } from "../packages/control-plane/dist/watch.js";
import { LocalReceiptIssuer } from "../packages/gate/dist/index.js";

const keep = process.argv.includes("--keep");
const dir = mkdtempSync(join(tmpdir(), "gus-perf-bench-"));
const now = Date.now();
const DAY = 86_400_000;

function writeJsonl(name, rows) {
  writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const kb = Math.round(statSync(join(dir, name)).size / 1024);
  console.log(`  ${name}: ${rows.length} lines, ${kb} KB`);
}

console.log(`state dir: ${dir}`);
// Ledger: 20k entries — reserve/settle pairs spread over 120 days.
{
  const rows = [];
  for (let i = 0; i < 10_000; i++) {
    const ts = now - Math.floor(Math.random() * 120) * DAY - Math.floor(Math.random() * DAY);
    rows.push({ kind: "reserve", id: `r${i}`, ts, jobId: `job_${i}`, model: "m", estTokens: 1000, estCostUsd: 0.01 });
    rows.push({ kind: "settle", id: `r${i}`, ts: ts + 1000, jobId: `job_${i}`, model: "m", tokensIn: 900, tokensOut: 100, costUsd: 0.009 });
  }
  rows.sort((a, b) => a.ts - b.ts);
  writeJsonl("ledger.jsonl", rows);
}
// Chat: 1,500 transcript lines in the one panel conversation.
writeJsonl("chat.jsonl", Array.from({ length: 1500 }, (_, i) => ({
  conversationId: "panel-chat",
  ts: now - (1500 - i) * 60_000,
  direction: i % 2 ? "out" : "in",
  text: `message ${i} — a perfectly ordinary operator message with some words in it`,
})));
// Gate log: 60k scan decisions.
writeJsonl("gate.jsonl", Array.from({ length: 60_000 }, (_, i) => ({
  ts: now - (60_000 - i) * 10_000,
  surface: "ingress",
  action: "allow",
  detail: "no known-bad patterns detected",
  jobId: `job_${i % 3000}`,
  receiptId: `rcpt_${i}`,
})));
// Events log: 30k host/channel events.
writeJsonl("events.jsonl", Array.from({ length: 30_000 }, (_, i) => ({
  ts: now - (30_000 - i) * 20_000,
  kind: "job_settled",
  detail: `job job_${i % 3000} settled verified-done`,
  jobId: `job_${i % 3000}`,
})));
// Jobs: 3,000 jobs × ~4 transition lines each.
{
  const rows = [];
  for (let i = 0; i < 3000; i++) {
    const base = { id: `job_${i}`, kind: "chat", conversationId: "panel-chat", input: "do a thing", createdAt: now - i * 60_000, origin: "operator" };
    rows.push({ ...base, state: "queued", updatedAt: base.createdAt });
    rows.push({ ...base, state: "running", updatedAt: base.createdAt + 1000 });
    rows.push({ ...base, state: "settled", updatedAt: base.createdAt + 2000, receiptId: `rcpt_j${i}` });
    rows.push({ ...base, state: "verified-done", updatedAt: base.createdAt + 3000, receiptId: `rcpt_j${i}`, costUsd: 0.01 });
  }
  writeJsonl("jobs.jsonl", rows);
}
// Approvals: 500 requests × ~3 lines.
{
  const rows = [];
  for (let i = 0; i < 500; i++) {
    const base = { id: `ap_${i}`, jobId: `job_${i}`, conversationId: "panel-chat", tool: "shell", summary: "run a command", reason: "consequential", createdAt: now - i * 100_000, expiresAt: now - i * 100_000 + 600_000, approvalHash: "h" };
    rows.push({ ...base, status: "pending" });
    rows.push({ ...base, status: "approved", resolvedAt: base.createdAt + 5000, resolvedBy: "operator" });
    rows.push({ ...base, status: "consumed", resolvedAt: base.createdAt + 6000, resolvedBy: "operator" });
  }
  writeJsonl("approvals.jsonl", rows);
}

function timeit(label, fn, n = 20) {
  fn(); // warm-up
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n;
  console.log(`  ${label}: ${ms.toFixed(2)} ms/call (mean of ${n})`);
  return ms;
}

console.log("boot (cold construction over the synthetic state):");
{
  const t0 = process.hrtime.bigint();
  const g = new Governor(dir);
  const j = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const a = new ApprovalEngine(dir, () => 600_000);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  Governor+JobRunner+ApprovalEngine construct: ${ms.toFixed(1)} ms`);
  globalThis.__g = g; globalThis.__j = j; globalThis.__a = a;
}

console.log("poll paths (what the desktop app's 2.5 s poll pays server-side):");
const gov = globalThis.__g;
timeit("Governor.spendSummary()      [/api/status]", () => gov.spendSummary());
const chat = new PanelChatAdapter(dir);
timeit("PanelChatAdapter.history()   [/api/chat/history]", () => chat.history());
timeit("readWatchTimeline(dir, 60)   [/api/watch/timeline]", () => readWatchTimeline(dir, 60));
const jobs = globalThis.__j;
timeit("JobRunner.list(200)          [/api/jobs + history]", () => jobs.list(200));
const appr = globalThis.__a;
timeit("ApprovalEngine.recentResolved(25) [/api/approvals/history]", () => appr.recentResolved(25));

if (!keep) console.log("(state dir left in place for inspection; delete manually)");
