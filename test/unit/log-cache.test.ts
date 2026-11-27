/**
 * The incremental append-only log cache (v0.14.0, R2) — the
 * poll-path performance fix, pinned.
 *
 * Cache contract:
 *  - appended lines are visible on the next read, parsed from
 *    the delta only;
 *  - a torn final line is HELD (never parsed, never fatal)
 *    until its newline lands, then it reads whole;
 *  - invalid JSON lines are skipped, as every reader of these
 *    logs has always done;
 *  - truncation and replacement reset to a full re-read — a
 *    rewritten file is never read as its predecessor's tail;
 *  - a missing file reads as empty, and a file created later
 *    is read from byte zero.
 *
 * Consumer equivalence: the Governor's spend summary, the
 * panel chat history, the Watch timeline, and the permissive
 * report must return EXACTLY what the old full-parse readers
 * returned on the same fixture bytes — the naive readers are
 * re-implemented here from the pre-cache code and compared
 * field for field, across appends as well as on first read.
 * (The timeline's category/narration/flagged derivation itself
 * is pinned by secure-log.test.ts; here the projection the
 * merge/sort/slice decides — ts, source, kind, detail, jobId,
 * receiptId — is compared, plus full entries on a small
 * hand-written fixture.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlLogCache } from "../../packages/control-plane/src/log-cache.js";
import { validateSyncedChatMessage } from "../../packages/shared/src/index.js";
import { Governor, type LedgerEntry } from "../../packages/control-plane/src/governor.js";
import {
  PanelChatAdapter,
  PANEL_CHAT_CONVERSATION,
  type PanelChatEntry,
} from "../../packages/control-plane/src/panel-chat.js";
import { readWatchTimeline } from "../../packages/control-plane/src/watch.js";
import { readPermissiveActions } from "../../packages/control-plane/src/governor-mode.js";
import { ContextPackStore } from "../../packages/control-plane/src/context-pack.js";

function freshDir(prefix = "gus-logcache-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const asRecord = (raw: unknown): Record<string, unknown> | undefined =>
  raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;

// ------------------------------------------------------------ cache

test("cache: appended lines are visible on the next read", () => {
  const dir = freshDir();
  const p = join(dir, "x.jsonl");
  writeFileSync(p, '{"n":1}\n{"n":2}\n');
  const cache = new JsonlLogCache<Record<string, unknown>>();
  assert.deepEqual(cache.read(p, asRecord).map((e) => e.n), [1, 2]);
  appendFileSync(p, '{"n":3}\n');
  assert.deepEqual(cache.read(p, asRecord).map((e) => e.n), [1, 2, 3]);
  // A no-change read returns the same entries, unmoved.
  assert.deepEqual(cache.read(p, asRecord).map((e) => e.n), [1, 2, 3]);
});

test("cache: a torn final line is held until its newline lands", () => {
  const dir = freshDir();
  const p = join(dir, "x.jsonl");
  writeFileSync(p, '{"n":1}\n{"n":2');
  const cache = new JsonlLogCache<Record<string, unknown>>();
  assert.deepEqual(
    cache.read(p, asRecord).map((e) => e.n),
    [1],
    "the torn line is not parsed and does not throw",
  );
  appendFileSync(p, '}\n{"n":3}\n');
  assert.deepEqual(cache.read(p, asRecord).map((e) => e.n), [1, 2, 3]);
});

test("cache: invalid lines are skipped; the valid ones still read", () => {
  const dir = freshDir();
  const p = join(dir, "x.jsonl");
  writeFileSync(p, '{"n":1}\nnot json at all\n{"n":2}\n\n{"n":3}\n');
  const cache = new JsonlLogCache<Record<string, unknown>>();
  assert.deepEqual(cache.read(p, asRecord).map((e) => e.n), [1, 2, 3]);
});

test("cache: truncation resets — a shorter file is re-read whole", () => {
  const dir = freshDir();
  const p = join(dir, "x.jsonl");
  writeFileSync(p, '{"n":1}\n{"n":2}\n{"n":3}\n');
  const cache = new JsonlLogCache<Record<string, unknown>>();
  assert.deepEqual(cache.read(p, asRecord).map((e) => e.n), [1, 2, 3]);
  writeFileSync(p, '{"n":9}\n');
  assert.deepEqual(cache.read(p, asRecord).map((e) => e.n), [9]);
  appendFileSync(p, '{"n":10}\n');
  assert.deepEqual(cache.read(p, asRecord).map((e) => e.n), [9, 10]);
});

test("cache: a same-length rewrite is not read as the old file's tail", () => {
  const dir = freshDir();
  const p = join(dir, "x.jsonl");
  writeFileSync(p, '{"n":1}\n{"n":2}\n');
  const cache = new JsonlLogCache<Record<string, unknown>>();
  assert.deepEqual(cache.read(p, asRecord).map((e) => e.n), [1, 2]);
  // Same byte length, different content (the last line differs).
  writeFileSync(p, '{"n":7}\n{"n":8}\n');
  assert.deepEqual(cache.read(p, asRecord).map((e) => e.n), [7, 8]);
});

test("cache: missing reads empty; a file created later reads from zero", () => {
  const dir = freshDir();
  const p = join(dir, "x.jsonl");
  const cache = new JsonlLogCache<Record<string, unknown>>();
  assert.deepEqual(cache.read(p, asRecord), []);
  writeFileSync(p, '{"n":1}\n');
  assert.deepEqual(cache.read(p, asRecord).map((e) => e.n), [1]);
});

test("cache: the mapper may skip lines, and skipped lines stay skipped", () => {
  const dir = freshDir();
  const p = join(dir, "x.jsonl");
  writeFileSync(p, '{"keep":1}\n{"keep":0}\n{"keep":2}\n');
  const cache = new JsonlLogCache<number>();
  const onlyKept = (raw: unknown): number | undefined => {
    const r = raw as { keep?: number };
    return typeof r.keep === "number" && r.keep > 0 ? r.keep : undefined;
  };
  assert.deepEqual(cache.read(p, onlyKept), [1, 2]);
  appendFileSync(p, '{"keep":0}\n{"keep":3}\n');
  assert.deepEqual(cache.read(p, onlyKept), [1, 2, 3]);
});

// ------------------------------------------------------------ governor

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}
function monthStart(ts: number): number {
  const d = new Date(ts);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** The pre-cache reader + summary, re-implemented naively. */
function naiveSpend(dir: string): { todayUsd: number; monthUsd: number; totalUsd: number } {
  const p = join(dir, "ledger.jsonl");
  const entries: LedgerEntry[] = existsSync(p)
    ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerEntry)
    : [];
  const since = (from: number) =>
    entries.reduce((s, e) => (e.kind === "settle" && e.ts >= from ? s + e.costUsd : s), 0);
  const now = Date.now();
  return { todayUsd: since(dayStart(now)), monthUsd: since(monthStart(now)), totalUsd: since(0) };
}

test("governor equivalence: spendSummary matches the naive full parse, across appends", () => {
  const dir = freshDir();
  const now = Date.now();
  const rows: LedgerEntry[] = [
    { kind: "reserve", id: "r_old", ts: now - 90 * 86_400_000, jobId: "j0", model: "m", estTokens: 10, estCostUsd: 1 },
    { kind: "settle", id: "r_old", ts: now - 90 * 86_400_000, jobId: "j0", model: "m", tokensIn: 9, tokensOut: 1, costUsd: 0.5 },
    { kind: "reserve", id: "r_mon", ts: monthStart(now) + 1000, jobId: "j1", model: "m", estTokens: 10, estCostUsd: 1 },
    { kind: "settle", id: "r_mon", ts: monthStart(now) + 1000, jobId: "j1", model: "m", tokensIn: 9, tokensOut: 1, costUsd: 0.25 },
    { kind: "reserve", id: "r_ref", ts: now - 1000, jobId: "j2", model: "m", estTokens: 10, estCostUsd: 1 },
    { kind: "refund", id: "r_ref", ts: now - 900, jobId: "j2", reason: "provider_error" },
  ];
  // A settle exactly at today's start belongs to today AND the month.
  if (dayStart(now) > monthStart(now)) {
    rows.push({ kind: "reserve", id: "r_day", ts: dayStart(now), jobId: "j3", model: "m", estTokens: 10, estCostUsd: 1 });
    rows.push({ kind: "settle", id: "r_day", ts: dayStart(now), jobId: "j3", model: "m", tokensIn: 9, tokensOut: 1, costUsd: 0.125 });
  }
  writeFileSync(join(dir, "ledger.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const g = new Governor(dir, { maxTokensPerJob: 1_000_000, maxTokensPerDay: 10_000_000, pricesUsdPer1k: { "priced-model": 10 } });
  const pick = () => {
    const s = g.spendSummary();
    return { todayUsd: s.todayUsd, monthUsd: s.monthUsd, totalUsd: s.totalUsd };
  };
  assert.deepEqual(pick(), naiveSpend(dir));
  // Repeated polls return the same numbers without re-reading.
  assert.deepEqual(pick(), naiveSpend(dir));

  // The reserve/settle flow: the Governor's own appends are
  // reflected in the very next summary.
  const tokensBefore = g.tokensToday();
  const a = g.authorize("job-live", 10, 0, "priced-model");
  assert.equal(a.ok, true);
  if (a.ok) g.settle(a.reservationId, 10, 0); // $0.10 at the fixture price
  assert.deepEqual(pick(), naiveSpend(dir));
  assert.equal(g.audit().settledUsd, naiveSpend(dir).totalUsd);
  assert.equal(g.tokensToday(), tokensBefore + 10, "the settled tokens land in today's committed total");
});

// ------------------------------------------------------------ panel chat

/** The pre-cache history reader, re-implemented naively —
 *  v0.26.0: mirroring the current line mapping, sync fields
 *  included (history() migrates legacy lines first, so the
 *  file it reads back carries identities the naive reader
 *  must project exactly as mapChatLine does). */
function naiveHistory(dir: string, limit = 200): PanelChatEntry[] {
  const p = join(dir, "chat.jsonl");
  if (!existsSync(p)) return [];
  const out: PanelChatEntry[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as {
        conversationId?: string; ts?: number; direction?: string; text?: string;
        photos?: number; id?: unknown; deviceId?: unknown; seq?: unknown; prevId?: unknown;
      };
      if (r.conversationId !== PANEL_CHAT_CONVERSATION) continue;
      if (typeof r.ts !== "number" || typeof r.text !== "string") continue;
      const entry: PanelChatEntry = {
        ts: r.ts,
        direction: r.direction === "in" ? "in" : "out",
        text: r.text,
        ...(typeof r.photos === "number" && r.photos > 0 ? { photos: r.photos } : {}),
      };
      const synced = validateSyncedChatMessage({
        id: r.id, deviceId: r.deviceId, seq: r.seq, prevId: r.prevId,
        ts: entry.ts, direction: entry.direction, text: entry.text,
        ...(entry.photos ? { photos: entry.photos } : {}),
      });
      if (synced) {
        entry.id = synced.id;
        entry.deviceId = synced.deviceId;
        entry.seq = synced.seq;
        entry.prevId = synced.prevId;
      }
      out.push(entry);
    } catch { /* torn line — skip */ }
  }
  return out.slice(-limit);
}

test("chat equivalence: history matches the naive full parse, across appends and record()", async () => {
  const dir = freshDir();
  const lines = [
    JSON.stringify({ conversationId: "panel-chat", ts: 1000, direction: "in", text: "first" }),
    JSON.stringify({ conversationId: "other-conv", ts: 1500, direction: "in", text: "not the panel's" }),
    JSON.stringify({ conversationId: "panel-chat", ts: 2000, direction: "out", text: "second" }),
    "{torn json",
    JSON.stringify({ conversationId: "panel-chat", ts: "3000", direction: "in", text: "bad ts — skipped" }),
    JSON.stringify({ conversationId: "panel-chat", ts: 4000, direction: "sideways", text: "odd direction reads as out" }),
  ];
  writeFileSync(join(dir, "chat.jsonl"), lines.join("\n") + "\n");
  const chat = new PanelChatAdapter(dir);
  assert.deepEqual(chat.history(), naiveHistory(dir));
  assert.deepEqual(chat.history(2), naiveHistory(dir, 2));
  assert.deepEqual(chat.history(), naiveHistory(dir), "repeat polls agree");

  // The adapter's own record() appends (via send) are visible
  // to the next history() call.
  await chat.send({ conversationId: PANEL_CHAT_CONVERSATION, text: "a reply from the host" });
  assert.deepEqual(chat.history(), naiveHistory(dir));
  assert.equal(chat.history().at(-1)?.text, "a reply from the host");

  // A torn tail written by a crash mid-append is held, then
  // completed — history tracks the naive reader throughout.
  appendFileSync(join(dir, "chat.jsonl"), '{"conversationId":"panel-chat","ts":5000,"direction":"in","text":"hel');
  assert.deepEqual(chat.history(), naiveHistory(dir));
  appendFileSync(join(dir, "chat.jsonl"), 'lo"}\n');
  assert.deepEqual(chat.history(), naiveHistory(dir));
  assert.equal(chat.history().at(-1)?.text, "hello");
});

// ------------------------------------------------------------ watch timeline

interface NaiveEntry {
  ts: number;
  source: string;
  kind: string;
  detail: string;
  jobId?: string;
  receiptId?: string;
}

/** The pre-cache timeline's merge/sort/slice over a naive full
 *  parse, projected to the fields the merge decides (the
 *  derivation fields are pinned by secure-log.test.ts). */
function naiveTimeline(dir: string, limit = 60): NaiveEntry[] {
  const entries: NaiveEntry[] = [];
  const readLines = (file: string): Record<string, unknown>[] => {
    try {
      if (!existsSync(file)) return [];
      const out: Record<string, unknown>[] = [];
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as Record<string, unknown>);
        } catch { /* torn line — skip */ }
      }
      return out;
    } catch {
      return [];
    }
  };
  for (const r of readLines(join(dir, "events.jsonl"))) {
    if (typeof r.ts !== "number" || typeof r.kind !== "string") continue;
    const detail =
      typeof r.detail === "string" ? r.detail
      : typeof r.error === "string" ? r.error
      : typeof r.summary === "string" ? r.summary
      : typeof r.id === "string" ? `id ${r.id}`
      : "";
    entries.push({
      ts: r.ts, source: "events", kind: r.kind, detail,
      ...(typeof r.jobId === "string" ? { jobId: r.jobId } : {}),
    });
  }
  for (const r of readLines(join(dir, "gate.jsonl"))) {
    if (typeof r.ts !== "number") continue;
    const surface = typeof r.surface === "string" ? r.surface : "gate";
    const action = typeof r.action === "string" ? r.action : "decision";
    const base = typeof r.detail === "string" ? r.detail : "";
    const detail = r.wouldBe ? `${base} (permissive — enforcing would ${String(r.wouldBe)})` : base;
    entries.push({
      ts: r.ts, source: "gate", kind: `gate ${surface} → ${action}`, detail,
      ...(typeof r.jobId === "string" ? { jobId: r.jobId } : {}),
      ...(typeof r.receiptId === "string" ? { receiptId: r.receiptId } : {}),
    });
  }
  return entries.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

const project = (es: ReturnType<typeof readWatchTimeline>): NaiveEntry[] =>
  es.map((e) => ({
    ts: e.ts, source: e.source, kind: e.kind, detail: e.detail,
    ...(e.jobId !== undefined ? { jobId: e.jobId } : {}),
    ...(e.receiptId !== undefined ? { receiptId: e.receiptId } : {}),
  }));

test("timeline equivalence: merge, stable order, and slice match the naive reader, across appends", () => {
  const dir = freshDir();
  const events = [
    { ts: 2000, kind: "job_settled", detail: "settled", jobId: "job_a" },
    { ts: 1000, kind: "approval_approved", id: "appr_1", jobId: "job_a" },
    { ts: 2000, kind: "send_failed", error: "network down" },
    { ts: "bad", kind: "nope" },
    { ts: 3000, kind: "summary_only", summary: "a summary detail" },
  ];
  const gate = [
    { ts: 2000, surface: "ingress", action: "allow", detail: "clean", jobId: "job_b", receiptId: "rcpt_1" },
    { ts: 500, surface: "tool-call", action: "block", detail: "bad", receiptId: "rcpt_2" },
    { ts: 2000, action: "flag", detail: "suspicious", wouldBe: "block" },
    { ts: 4000, detail: "no surface or action" },
  ];
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n{torn\n");
  writeFileSync(join(dir, "gate.jsonl"), gate.map((e) => JSON.stringify(e)).join("\n") + "\n");

  assert.deepEqual(project(readWatchTimeline(dir, 60)), naiveTimeline(dir, 60));
  assert.deepEqual(project(readWatchTimeline(dir, 3)), naiveTimeline(dir, 3), "the limit slices identically");
  assert.deepEqual(project(readWatchTimeline(dir, 60)), naiveTimeline(dir, 60), "repeat polls agree");

  // Appends land in the next read, in the same order the naive
  // reader produces (equal-ts entries keep events-before-gate
  // concatenation order under the stable sort).
  appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ ts: 2000, kind: "late_event", detail: "appended" }) + "\n");
  appendFileSync(join(dir, "gate.jsonl"), JSON.stringify({ ts: 2000, surface: "egress", action: "allow", detail: "appended gate" }) + "\n");
  assert.deepEqual(project(readWatchTimeline(dir, 60)), naiveTimeline(dir, 60));
});

// ------------------------------------------------------------ permissive report

test("permissive equivalence: the report matches the naive merge, across appends", () => {
  const dir = freshDir();
  appendFileSync(join(dir, "permissive.jsonl"), JSON.stringify({ ts: 300, jobId: "j3", kind: "policy", detail: "park proceeded" }) + "\n");
  appendFileSync(join(dir, "permissive.jsonl"), JSON.stringify({ ts: 100, jobId: "j1", kind: "policy", detail: "deny proceeded" }) + "\n");
  writeFileSync(
    join(dir, "gate.jsonl"),
    JSON.stringify({ ts: 200, jobId: "j2", surface: "tool-call", action: "allow", wouldBe: "block", detail: "shield would-be" }) + "\n" +
      JSON.stringify({ ts: 400, jobId: "j4", surface: "tool-call", action: "block", detail: "an enforcing block — not a let-through" }) + "\n",
  );
  assert.deepEqual(readPermissiveActions(dir, 0).map((a) => a.jobId), ["j1", "j2", "j3"]);
  assert.deepEqual(readPermissiveActions(dir, 250).map((a) => a.jobId), ["j3"]);
  appendFileSync(join(dir, "gate.jsonl"), JSON.stringify({ ts: 250, jobId: "j5", surface: "ingress", action: "allow", wouldBe: "flag", detail: "late let-through" }) + "\n");
  assert.deepEqual(readPermissiveActions(dir, 0).map((a) => a.jobId), ["j1", "j2", "j5", "j3"]);
  assert.deepEqual(readPermissiveActions(dir, 250).map((a) => a.jobId), ["j5", "j3"]);
});

// ------------------------------------------------------------ context status memo

test("context status: memoized while the tree is unchanged, recomputed on any edit", () => {
  const dir = freshDir();
  const store = new ContextPackStore(dir);
  store.ensureSeeded();
  const s1 = store.status();
  const s2 = store.status();
  assert.equal(s1, s2, "an unchanged tree returns the memoized status object");
  assert.deepEqual(s1.files.length, 8);

  writeFileSync(join(store.contextDir, "MEMORY.md"), "# Memory\n\n- A new fact that changes the hash.\n");
  const s3 = store.status();
  assert.notEqual(s3, s1, "an edit invalidates the memo");
  const mem = s3.files.find((f) => f.name === "MEMORY.md");
  const memBefore = s1.files.find((f) => f.name === "MEMORY.md");
  assert.notEqual(mem?.sha256, memBefore?.sha256, "the recomputed status carries the new hash");
  assert.equal(store.status(), s3, "and memoizes again");

  store.appendCandidateLine({ id: "cand_x", status: "proposed", text: "a proposal", ts: 1 });
  const s4 = store.status();
  assert.notEqual(s4, s3, "a candidates.jsonl append invalidates the memo");
  assert.equal(s4.pendingCandidates, 1);
});
