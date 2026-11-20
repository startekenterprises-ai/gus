/**
 * Store migration — R1 groundwork (v0.13.0): a state directory
 * written by v0.12.0 opens UNCHANGED behind the new @gus/shared
 * store contracts.
 *
 * R1 is a seam, not a migration: ContextPackStore now implements
 * MemoryStore and JobRunner implements TaskStore, but no file
 * moved and no format changed. This test builds a fixture shaped
 * like a real v0.12.0 install — hand-written core files with
 * distinctive content, a custom context.json, candidate lines in
 * both Slice A and Slice B shapes, a daily note, three job records
 * in three states, and a stub receipt — then opens it through the
 * new contracts and pins:
 *
 *  - status() sees every file, with the hash of its exact bytes;
 *  - candidate resolution is latest-line-wins (B's promotion line
 *    supersedes its proposal line; A stays proposed; pending = 1);
 *  - every job field survives the round trip (receipt ids, Shield
 *    receipt ids, parked state);
 *  - a write through the new MemoryWriteService APPENDS — the
 *    original file content remains a strict prefix;
 *  - a transition appends (jobs.jsonl grows), and a SECOND
 *    JobRunner over the same directory sees the settled state and
 *    its receipt — the store is the directory, not the instance;
 *  - receipts.jsonl is append-only through all of it: the original
 *    line is intact as a strict prefix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";
import { ContextPackStore } from "../../packages/control-plane/src/context-pack.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { MemoryWriteService } from "../../packages/control-plane/src/memory-write.js";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const CORE_MARKERS: Record<string, string> = {
  "IDENTITY.md": "# Identity\n\n- FIXTURE-IDENTITY-MARKER — GUS, the operator's agent.\n",
  "SOUL.md": "# Character\n\n- FIXTURE-SOUL-MARKER — direct and decisive.\n",
  "OPERATOR.md": "# Operator\n\n- FIXTURE-OPERATOR-MARKER — the operator's standing facts.\n",
  "MEMORY.md": "# Memory\n\n- FIXTURE-MEMORY-MARKER — a durable fact from v0.12.0.\n",
  "PROJECTS.md": "# Projects\n\n- FIXTURE-PROJECTS-MARKER — the live project list.\n",
};

interface Fixture {
  dir: string;
  contextDir: string;
  memoryBefore: string;
  jobsBytesBefore: number;
  receiptsBefore: string;
}

function buildFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "gus-stores-migration-"));
  const contextDir = join(dir, "context");
  mkdirSync(join(contextDir, "memory"), { recursive: true });
  mkdirSync(join(contextDir, "archive"), { recursive: true });
  for (const [name, content] of Object.entries(CORE_MARKERS)) {
    writeFileSync(join(contextDir, name), content, "utf8");
  }
  // A custom context.json — the operator's budgets, not the defaults.
  writeFileSync(
    join(contextDir, "context.json"),
    JSON.stringify({
      enabled: true,
      maxPackChars: 9999,
      maxDigestChars: 2222,
      dailyNoteDays: 3,
      profiles: { delegateMemory: true },
    }) + "\n",
    "utf8",
  );
  // candidates.jsonl: A proposed; B proposed, then promoted (the
  // second B line supersedes the first). Full Slice B record shapes.
  const candA = {
    id: "cand_fixture_a",
    ts: 1_763_000_000_000,
    origin: "agent-self",
    category: "fact",
    text: "Fixture fact A, still awaiting a decision.",
    source: "fixture job",
    status: "proposed",
  };
  const candBProposed = {
    id: "cand_fixture_b",
    ts: 1_763_000_100_000,
    jobId: "job_fixture_done",
    origin: "operator",
    category: "preference",
    text: "Fixture preference B, promoted by the operator.",
    source: "fixture",
    status: "proposed",
  };
  const candBPromoted = {
    ...candBProposed,
    status: "promoted",
    decidedBy: "operator",
    decidedAt: 1_763_000_200_000,
    promotedTo: "OPERATOR.md",
  };
  writeFileSync(
    join(contextDir, "candidates.jsonl"),
    [candA, candBProposed, candBPromoted].map((c) => JSON.stringify(c)).join("\n") + "\n",
    "utf8",
  );
  writeFileSync(
    join(contextDir, "context-events.jsonl"),
    [
      JSON.stringify({ ts: 1_763_000_000_000, kind: "seeded", filesCreated: 8 }),
      JSON.stringify({ ts: 1_763_000_300_000, kind: "assembly", jobId: "job_fixture_done", profile: "operator-full" }),
    ].join("\n") + "\n",
    "utf8",
  );
  writeFileSync(
    join(contextDir, "memory", "2026-11-17.md"),
    "# 2026-11-17\n\n- FIXTURE-DAILY-MARKER — yesterday's note.\n",
    "utf8",
  );

  // jobs.jsonl: a verified-done job carrying both receipt kinds, a
  // running job, and a parked needs-approval job.
  const jobDone = {
    id: "job_fixture_done",
    kind: "chat",
    state: "verified-done",
    inputHash: sha256("fixture done input"),
    origin: "operator",
    conversationId: "conv-fixture",
    createdAt: 1_763_000_000_000,
    updatedAt: 1_763_000_050_000,
    outcomeNote: "settled by the fixture",
    costUsd: 0.01,
    tokensIn: 120,
    tokensOut: 30,
    receiptId: "gus_rcpt_fixture_done",
    shieldReceiptIds: ["shield_rcpt_fixture_1"],
  };
  const jobRunning = {
    id: "job_fixture_running",
    kind: "chat",
    state: "running",
    inputHash: sha256("fixture running input"),
    origin: "operator",
    conversationId: "conv-fixture",
    createdAt: 1_763_000_100_000,
    updatedAt: 1_763_000_100_000,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  const jobParked = {
    id: "job_fixture_parked",
    kind: "workspace-file",
    state: "needs-approval",
    inputHash: sha256("fixture parked input"),
    origin: "operator",
    conversationId: "conv-fixture",
    createdAt: 1_763_000_200_000,
    updatedAt: 1_763_000_200_000,
    costUsd: 0,
    tokensIn: 10,
    tokensOut: 0,
  };
  writeFileSync(
    join(dir, "jobs.jsonl"),
    [jobDone, jobRunning, jobParked].map((j) => JSON.stringify(j)).join("\n") + "\n",
    "utf8",
  );
  const receiptsLine = JSON.stringify({
    kind: "gus-local-stub",
    receiptId: "gus_rcpt_fixture_done",
    jobId: "job_fixture_done",
    state: "verified-done",
    contentHash: sha256("fixture done input"),
    costUsd: 0.01,
    issuedAt: 1_763_000_050_000,
    signature: "fixture-signature",
    note: "Phase 0 local stub — real Agent-Shield Protocol receipts integrate in Phase 4.",
  });
  writeFileSync(join(dir, "receipts.jsonl"), receiptsLine + "\n", "utf8");

  return {
    dir,
    contextDir,
    memoryBefore: CORE_MARKERS["MEMORY.md"]!,
    jobsBytesBefore: readFileSync(join(dir, "jobs.jsonl")).length,
    receiptsBefore: receiptsLine + "\n",
  };
}

test("migration: a v0.12.0-shaped state dir opens unchanged behind the store contracts", () => {
  const fx = buildFixture();
  // NOTE: no ensureSeeded() — the fixture IS the seeded tree, and
  // opening the store must not need (or make) any repair writes.
  const store = new ContextPackStore(fx.dir);
  const jobs = new JobRunner(
    fx.dir,
    new LocalReceiptIssuer(join(fx.dir, "receipt-stub.key")),
  );

  // ---- status(): every file present, hashed over its exact bytes.
  const status = store.status();
  assert.equal(status.config.maxPackChars, 9999, "the custom context.json is honored");
  assert.equal(status.config.dailyNoteDays, 3);
  for (const [name, content] of Object.entries(CORE_MARKERS)) {
    const stat = status.files.find((f) => f.name === name);
    assert.ok(stat, `status lists ${name}`);
    assert.equal(stat?.exists, true);
    assert.equal(stat?.bytes, Buffer.byteLength(content, "utf8"));
    assert.equal(stat?.sha256, sha256(content), `${name}'s hash is its content's hash`);
  }
  for (const name of ["context.json", "candidates.jsonl", "context-events.jsonl"]) {
    const stat = status.files.find((f) => f.name === name);
    assert.equal(stat?.exists, true, `status lists ${name}`);
    assert.ok(stat?.sha256, `${name} carries a hash`);
  }
  assert.deepEqual(store.dailyNoteNames(), ["2026-11-17.md"]);

  // ---- candidates: latest line wins; pending counts proposed only.
  const candidates = store.listCandidates();
  assert.equal(candidates.length, 2, "three lines resolve to two candidates");
  const a = candidates.find((c) => c.id === "cand_fixture_a");
  assert.equal(a?.status, "proposed");
  assert.equal(a?.category, "fact");
  assert.equal(a?.text, "Fixture fact A, still awaiting a decision.");
  const b = candidates.find((c) => c.id === "cand_fixture_b");
  assert.equal(b?.status, "promoted", "B's promotion line supersedes its proposal line");
  assert.equal(b?.promotedTo, "OPERATOR.md");
  assert.equal(b?.decidedBy, "operator");
  assert.equal(b?.category, "preference");
  assert.equal(store.pendingCandidateCount(), 1, "only A is still pending");
  assert.equal(status.pendingCandidates, 1);

  // ---- jobs: all three records, fields intact.
  const listed = jobs.list();
  assert.equal(listed.length, 3);
  const done = jobs.get("job_fixture_done");
  assert.equal(done?.state, "verified-done");
  assert.equal(done?.receiptId, "gus_rcpt_fixture_done");
  assert.deepEqual(done?.shieldReceiptIds, ["shield_rcpt_fixture_1"]);
  assert.equal(done?.inputHash, sha256("fixture done input"));
  assert.equal(done?.costUsd, 0.01);
  assert.equal(done?.tokensIn, 120);
  assert.equal(jobs.get("job_fixture_running")?.state, "running");
  assert.equal(jobs.get("job_fixture_parked")?.state, "needs-approval");

  // ---- a Slice B write APPENDS: the v0.12.0 content is a strict prefix.
  const service = new MemoryWriteService(store);
  const remembered = service.remember("A fact remembered after the upgrade.");
  assert.equal(remembered.ok, true);
  const memoryAfter = readFileSync(join(fx.contextDir, "MEMORY.md"), "utf8");
  assert.ok(memoryAfter.length > fx.memoryBefore.length, "the file grew");
  assert.ok(
    memoryAfter.startsWith(fx.memoryBefore),
    "the original MEMORY.md content is a strict prefix — the write appended, never rewrote",
  );
  assert.ok(memoryAfter.includes("FIXTURE-MEMORY-MARKER"), "the fixture fact survived");
  assert.ok(memoryAfter.includes("[operator] A fact remembered after the upgrade."));

  // ---- a transition appends; a second runner sees the settled state.
  const settled = jobs.transition("job_fixture_running", "verified-done", "fixture settle");
  assert.ok(settled.receiptId, "settlement issued a receipt");
  const jobsBytesAfter = readFileSync(join(fx.dir, "jobs.jsonl")).length;
  assert.ok(jobsBytesAfter > fx.jobsBytesBefore, "jobs.jsonl grew by append");

  const jobs2 = new JobRunner(
    fx.dir,
    new LocalReceiptIssuer(join(fx.dir, "receipt-stub.key")),
  );
  const seen = jobs2.get("job_fixture_running");
  assert.equal(seen?.state, "verified-done", "the second instance sees the settlement");
  assert.equal(seen?.receiptId, settled.receiptId, "…and the same receipt id");
  assert.equal(jobs2.list().length, 3, "no job was lost or duplicated");

  // ---- receipts.jsonl: append-only — the original line is intact.
  const receiptsAfter = readFileSync(join(fx.dir, "receipts.jsonl"), "utf8");
  assert.ok(
    receiptsAfter.startsWith(fx.receiptsBefore),
    "the v0.12.0 receipt line is an untouched prefix; the settlement appended after it",
  );
  assert.ok(receiptsAfter.includes(settled.receiptId!), "the new receipt was appended");
  assert.ok(existsSync(join(fx.dir, "jobs.jsonl")));
});
