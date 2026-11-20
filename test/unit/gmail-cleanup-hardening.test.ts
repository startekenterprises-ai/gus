/**
 * Gmail cleanup MVP chunk 5 (hardening) tests.
 *
 * What is pinned here, on top of the chunks 1–4 suites:
 *  - Adversarial rule files fail closed, loudly: oversized
 *    files, too many rules, oversized lists, a non-object top
 *    level, and a non-finite age (JSON 1e999 → Infinity) all
 *    refuse at load; deeply duplicated lists collapse to their
 *    canonical selves.
 *  - Manifest writes are atomic (no torn write-ahead record, no
 *    leftover tmp, a crashed writer's tmp is never promoted) and
 *    manifest reads validate: unparseable, mislabelled,
 *    oversized, duplicate-ID, or unknown-state manifests are
 *    CORRUPT and throw — no consumer ever guesses.
 *  - Transient transport failures (Gmail 429/5xx, network
 *    errors) retry with backoff; non-transient failures do not.
 *    The archive modify is idempotent under a lost response —
 *    the fresh read stands the retry down, so a message is
 *    never modified twice toward the same state.
 *  - Receipt integrity: a settled batch's receipts verify
 *    against the issuer's HMAC and the manifest-bound content
 *    hash; a tampered manifest, a tampered log entry, and a
 *    missing receipt each fail with their own named verdict.
 *  - Scheduler hardening: the config save is atomic, the state
 *    load shape-checks every field, and a Mac off for three
 *    days runs exactly ONE combined cycle on wake (still
 *    capped), delivering the stale report first.
 *  - The weekly summary line rolls the trailing 7 days of
 *    manifests into the morning report.
 *  - Soak: 25 fixture cycles of dry-run → archive → report →
 *    verify → undo (with transient and hard failures injected)
 *    each return the mailbox to its EXACT initial state.
 *
 * Everything runs against the pack's MockGmailTransport behind
 * fault-injecting wrappers — no network, no real mailbox.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GmailDirectory,
  MockGmailTransport,
  type GmailMessage,
  type GmailTransport,
} from "../../packages/control-plane/src/gmail.js";
import {
  buildWeeklyCleanupSummary,
  formatCleanupReceiptVerification,
  GmailCleanupEngine,
  GmailCleanupManifestStore,
  isTransientGmailError,
  loadCleanupRules,
  runGmailCleanupAdmin,
  verifyCleanupBatchReceipts,
  GMAIL_CLEANUP_HARD_CAP,
  type CleanupPlan,
  type CleanupReceiptSink,
  type CleanupRunManifest,
  type CleanupTransport,
  type GmailCleanupRuleFile,
} from "../../packages/control-plane/src/gmail-cleanup.js";
import {
  buildCleanupReport,
  gmailCleanupSchedulerTick,
  loadCleanupSchedulerConfig,
  loadCleanupSchedulerState,
  localDateKey,
  saveCleanupSchedulerConfig,
  saveCleanupSchedulerState,
  type GmailCleanupSchedulerDeps,
} from "../../packages/control-plane/src/gmail-cleanup-scheduler.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/receipts.js";
import { VaultBroker } from "../../packages/vault/src/index.js";

// ------------------------------------------------------------ fixtures

const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(NOW - n * DAY).toUTCString();

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-cleanup-hardening-"));
}

function msg(partial: Partial<GmailMessage> & { id: string }): GmailMessage {
  return {
    threadId: `thread-${partial.id}`,
    from: "news@example.com",
    to: ["me@example.com"],
    subject: `Subject ${partial.id}`,
    snippet: `snippet ${partial.id}`,
    date: daysAgo(60),
    labelIds: ["INBOX"],
    body: "",
    ...partial,
  };
}

function rules(partial: Partial<GmailCleanupRuleFile>): GmailCleanupRuleFile {
  return { version: 1, nightlyCap: 200, neverArchiveSenders: [], rules: [], ...partial };
}

function directoryWith(known: string[]): GmailDirectory {
  const dir = new GmailDirectory(join(freshDir(), "gmail-directory.json"));
  if (known.length) dir.recordKnown(known);
  return dir;
}

function storeIn(dir: string): GmailCleanupManifestStore {
  return new GmailCleanupManifestStore(join(dir, "gmail-cleanup"));
}

function receiptSinkIn(dir: string): CleanupReceiptSink {
  return {
    issuer: new LocalReceiptIssuer(join(dir, "receipt-stub.key")),
    logPath: join(dir, "receipts.jsonl"),
  };
}

function engineFor(
  transport: CleanupTransport,
  batchId: string,
  directory: GmailDirectory = directoryWith([]),
): GmailCleanupEngine {
  return new GmailCleanupEngine(transport, {
    directory,
    now: () => NOW,
    batchId: () => batchId,
    sleep: async () => {},
    retryBaseMs: 1,
  });
}

const NEWS_RULES = rules({ rules: [{ name: "Newsletters", from: ["news@example.com"] }] });

async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    const result = await fn();
    return { result, out: logs.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

// ------------------------------------------------- adversarial rule files

test("rules hardening: an oversized rule file refuses at load, before parsing", () => {
  const path = join(freshDir(), "rules.json");
  writeFileSync(path, `{"version":1,"rules":[],"pad":"${"x".repeat(1_100_000)}"}`);
  assert.throws(() => loadCleanupRules(path), /byte limit/);
});

test("rules hardening: too many rules and oversized lists refuse at load", () => {
  const dir = freshDir();
  const manyRules = join(dir, "many.json");
  writeFileSync(
    manyRules,
    JSON.stringify({ version: 1, rules: Array.from({ length: 257 }, (_, i) => ({ name: `r${i}`, from: ["a@b.c"] })) }),
  );
  assert.throws(() => loadCleanupRules(manyRules), /256-rule limit/);

  const longList = join(dir, "list.json");
  writeFileSync(
    longList,
    JSON.stringify({ version: 1, neverArchiveSenders: Array.from({ length: 1001 }, (_, i) => `s${i}@x.com`), rules: [] }),
  );
  assert.throws(() => loadCleanupRules(longList), /1000-entry limit/);

  const longString = join(dir, "string.json");
  writeFileSync(longString, JSON.stringify({ version: 1, rules: [{ name: "x", from: [`${"a".repeat(600)}@x.com`] }] }));
  assert.throws(() => loadCleanupRules(longString), /character limit/);
});

test("rules hardening: a non-object top level and a non-finite age refuse at load", () => {
  const dir = freshDir();
  for (const [name, raw] of [
    ["array", "[]"],
    ["null", "null"],
    ["string", '"just a string"'],
  ] as const) {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, raw);
    assert.throws(() => loadCleanupRules(path), /must hold a JSON object/, name);
  }
  // JSON has no Infinity literal, but 1e999 parses to Infinity.
  const inf = join(dir, "inf.json");
  writeFileSync(inf, `{"version":1,"rules":[{"name":"x","from":["a@b.c"],"olderThanDays":1e999}]}`);
  assert.throws(() => loadCleanupRules(inf), /finite number/);
});

test("rules hardening: deeply duplicated lists collapse to their canonical selves", () => {
  const path = join(freshDir(), "rules.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      neverArchiveSenders: ["Boss@X.com", "boss@x.com", " boss@x.com "],
      rules: [{ name: "x", from: ["A@x.com", "a@x.com"], fromDomain: ["@x.com", "x.com"], labelIds: ["inbox", "INBOX"] }],
    }),
  );
  const { rules: loaded } = loadCleanupRules(path);
  assert.deepEqual(loaded.neverArchiveSenders, ["boss@x.com"]);
  assert.deepEqual(loaded.rules[0]!.from, ["a@x.com"]);
  assert.deepEqual(loaded.rules[0]!.fromDomain, ["x.com"]);
  assert.deepEqual(loaded.rules[0]!.labelIds, ["INBOX"]);
});

// ------------------------------------------------------- manifest store

function planFixture(batchId: string, ids: string[]): CleanupPlan {
  return {
    batchId,
    createdAt: NOW,
    ruleFileHash: "hashfixture",
    cap: GMAIL_CLEANUP_HARD_CAP,
    entries: ids.map((id) => ({
      id,
      threadId: `thread-${id}`,
      from: "news@example.com",
      subject: `Subject ${id}`,
      date: daysAgo(60),
      priorLabelIds: ["INBOX"],
      rule: "Newsletters",
    })),
    byRule: { Newsletters: ids.length },
    scanned: ids.length,
    noRule: 0,
    excluded: { starred: 0, important: 0, "unread-recent": 0, "never-sender": 0, "known-correspondent": 0 },
    withheld: 0,
    overCap: 0,
    shieldUnscanned: true,
  };
}

function runFixture(batchId: string, partial: Partial<CleanupRunManifest> = {}): CleanupRunManifest {
  return {
    kind: "gmail-cleanup-run",
    batchId,
    jobId: `gmail-cleanup-${batchId}`,
    startedAt: NOW,
    ruleFileHash: "hashfixture",
    cap: GMAIL_CLEANUP_HARD_CAP,
    status: "verified-done",
    entries: [],
    ...partial,
  };
}

test("manifest store: writes are atomic — no tmp remains, and a crashed writer's tmp is never promoted", () => {
  const dir = freshDir();
  const store = storeIn(dir);
  store.saveRun(runFixture("atomic-1"));
  const names = readdirSync(join(dir, "gmail-cleanup"));
  assert.deepEqual(names, ["atomic-1.json"], "only the final manifest exists after a save");
  // A crashed writer's leftover tmp, full of garbage, changes nothing.
  writeFileSync(`${store.runPath("atomic-1")}.tmp`, "{torn garbage");
  const loaded = store.loadRun("atomic-1");
  assert.ok(loaded);
  assert.equal(loaded.batchId, "atomic-1");
});

test("manifest store: a torn manifest is CORRUPT and loud — never a silent null — and the file is untouched", () => {
  const dir = freshDir();
  const store = storeIn(dir);
  mkdirSync(join(dir, "gmail-cleanup"), { recursive: true });
  const path = store.runPath("torn-1");
  const torn = `{"kind":"gmail-cleanup-run","batchId":"torn-1","entries":[{"id":"m1"`;
  writeFileSync(path, torn);
  assert.throws(() => store.loadRun("torn-1"), /corrupt \(not valid JSON\)/);
  assert.equal(readFileSync(path, "utf8"), torn, "the corrupt file is left exactly as found");
  // Absence is still null — the two cases are never confused.
  assert.equal(store.loadRun("never-existed"), null);
});

test("manifest store: mislabelled, duplicate-ID, oversized, and unknown-state manifests all refuse as corrupt", () => {
  const dir = freshDir();
  const store = storeIn(dir);

  // A dry-run manifest sitting at a run path (wrong kind).
  store.saveDryRun(planFixture("kind-1", ["m1"]));
  writeFileSync(store.runPath("kind-1"), readFileSync(store.dryRunPath("kind-1"), "utf8"));
  assert.throws(() => store.loadRun("kind-1"), /corrupt \(kind is /);

  // The file names a different batch than its path does.
  store.saveDryRun(planFixture("name-1", ["m1"]));
  const renamed = store.dryRunPath("name-2");
  writeFileSync(renamed, readFileSync(store.dryRunPath("name-1"), "utf8"));
  assert.throws(() => store.loadDryRun("name-2"), /corrupt \(it names batch /);

  // The same message twice — a real selection can never do this.
  store.saveDryRun(planFixture("dup-1", ["m1", "m1"]));
  assert.throws(() => store.loadDryRun("dup-1"), /appears twice/);

  // More entries than the hard cap — no run can have produced it.
  const big = planFixture("big-1", Array.from({ length: GMAIL_CLEANUP_HARD_CAP + 1 }, (_, i) => `m${i}`));
  writeFileSync(store.dryRunPath("big-1"), JSON.stringify({ kind: "gmail-cleanup-dry-run", ...big }));
  assert.throws(() => store.loadDryRun("big-1"), /exceeds the nightly hard cap/);

  // A run entry in a state the engine never writes.
  const badState = runFixture("state-1", {
    entries: [
      {
        id: "m1",
        threadId: "t1",
        from: "news@example.com",
        subject: "S",
        date: daysAgo(60),
        priorLabelIds: ["INBOX"],
        rule: "Newsletters",
        state: "vanished" as never,
      },
    ],
  });
  writeFileSync(store.runPath("state-1"), JSON.stringify(badState));
  assert.throws(() => store.loadRun("state-1"), /unknown state/);
});

test("manifest store: listRuns returns the good runs and names the corrupt files", () => {
  const dir = freshDir();
  const store = storeIn(dir);
  store.saveRun(runFixture("good-1"));
  writeFileSync(store.runPath("torn-2"), "{not json");
  const { runs, corrupt } = store.listRuns();
  assert.deepEqual(runs.map((r) => r.batchId), ["good-1"]);
  assert.deepEqual(corrupt, ["torn-2.json"]);
});

// ------------------------------------------------------ transient retries

const err503 = (): Error => new Error("Gmail API refused POST messages/m1/modify (HTTP 503)");
const err429 = (): Error => new Error("Gmail API refused GET messages (HTTP 429)");
const err400 = (): Error => new Error("Gmail API refused POST messages/m1/modify (HTTP 400)");

interface FailSpec {
  method: "search" | "get" | "modify";
  id?: string;
  times: number;
  skip?: number;
  error: () => Error;
  /** Apply the call to the inner transport, THEN throw — the
   *  "the change landed but the response was lost" case. */
  afterApply?: boolean;
}

/** A CleanupTransport over the mock that injects scripted
 *  failures — the rate-limit / lost-response drill vehicle. */
class FlakyTransport implements CleanupTransport {
  readonly modifyCalls: { id: string; add: string[]; remove: string[] }[] = [];
  readonly getCalls: string[] = [];
  private specs: (FailSpec & { skipped: number; used: number })[] = [];
  constructor(private inner: MockGmailTransport) {}
  fail(spec: FailSpec): void {
    this.specs.push({ ...spec, skipped: 0, used: 0 });
  }
  private take(method: FailSpec["method"], id?: string): (FailSpec & { skipped: number; used: number }) | undefined {
    for (const s of this.specs) {
      if (s.method !== method) continue;
      if (s.id !== undefined && s.id !== id) continue;
      if (s.used >= s.times) continue;
      if (s.skipped < (s.skip ?? 0)) {
        s.skipped++;
        return undefined;
      }
      s.used++;
      return s;
    }
    return undefined;
  }
  async search(q: string, m: number) {
    const f = this.take("search");
    if (f) throw f.error();
    return this.inner.search(q, m);
  }
  async get(id: string) {
    this.getCalls.push(id);
    const f = this.take("get", id);
    if (f) throw f.error();
    return this.inner.get(id);
  }
  async modify(id: string, add: string[], remove: string[]) {
    this.modifyCalls.push({ id, add, remove });
    const f = this.take("modify", id);
    if (f) {
      if (f.afterApply) await this.inner.modify(id, add, remove);
      throw f.error();
    }
    return this.inner.modify(id, add, remove);
  }
}

test("transient classification: 429/5xx and network shapes retry; 400/404 and plain errors do not", () => {
  assert.equal(isTransientGmailError(err429()), true);
  assert.equal(isTransientGmailError(err503()), true);
  assert.equal(isTransientGmailError(new TypeError("fetch failed")), true);
  const reset = new Error("socket hang up") as Error & { code?: string };
  reset.code = "ECONNRESET";
  assert.equal(isTransientGmailError(reset), true);
  assert.equal(isTransientGmailError(err400()), false);
  assert.equal(isTransientGmailError(new Error("Gmail API: not found (messages/m1)")), false);
  assert.equal(isTransientGmailError(new Error("the rule file changed")), false);
});

async function archiveFixture(
  flaky: FlakyTransport,
  batchId: string,
  dir: string,
): Promise<{ store: GmailCleanupManifestStore; run: CleanupRunManifest }> {
  const engine = engineFor(flaky, batchId);
  const store = storeIn(dir);
  const plan = await engine.select(NEWS_RULES, "h");
  store.saveDryRun(plan);
  const run = await engine.archive(batchId, store, { rules: NEWS_RULES, hash: "h" });
  return { store, run };
}

test("retry: a rate-limited modify is retried until it lands — the batch still verifies done", async () => {
  const mock = new MockGmailTransport([msg({ id: "m1" }), msg({ id: "m2" })]);
  const flaky = new FlakyTransport(mock);
  flaky.fail({ method: "modify", id: "m1", times: 2, error: err503 });
  const { run } = await archiveFixture(flaky, "retry-1", freshDir());
  assert.equal(run.status, "verified-done");
  assert.deepEqual(
    run.entries.map((e) => e.state),
    ["done", "done"],
  );
  assert.equal(flaky.modifyCalls.filter((c) => c.id === "m1").length, 3, "two failures + the landing attempt");
  assert.equal(flaky.modifyCalls.filter((c) => c.id === "m2").length, 1);
});

test("retry: a modify that landed but lost its response is never applied twice", async () => {
  const mock = new MockGmailTransport([msg({ id: "m1" })]);
  const flaky = new FlakyTransport(mock);
  flaky.fail({ method: "modify", id: "m1", times: 1, error: err503, afterApply: true });
  const { run } = await archiveFixture(flaky, "retry-2", freshDir());
  assert.equal(run.status, "verified-done");
  assert.equal(run.entries[0]!.state, "done");
  assert.equal(flaky.modifyCalls.length, 1, "the fresh read stood the retry down — exactly one modify");
  const after = await mock.get("m1");
  assert.deepEqual(after!.labelIds, [], "INBOX removed exactly once");
});

test("retry: a non-transient modify failure is NOT retried — the entry fails as it always did", async () => {
  const mock = new MockGmailTransport([msg({ id: "m1" })]);
  const flaky = new FlakyTransport(mock);
  flaky.fail({ method: "modify", id: "m1", times: 5, error: err400 });
  const { run } = await archiveFixture(flaky, "retry-3", freshDir());
  assert.equal(run.status, "failed-loudly");
  assert.equal(run.entries[0]!.state, "failed");
  assert.equal(flaky.modifyCalls.length, 1, "no retry on a final error");
});

test("retry: transient failures on search and on the verify read are ridden through", async () => {
  const mock = new MockGmailTransport([msg({ id: "m1" })]);
  const flaky = new FlakyTransport(mock);
  flaky.fail({ method: "search", times: 1, error: err429 });
  // The entry's SECOND get is the post-modify verify — fail it once.
  flaky.fail({ method: "get", id: "m1", skip: 1, times: 1, error: err503 });
  const { run } = await archiveFixture(flaky, "retry-4", freshDir());
  assert.equal(run.status, "verified-done");
  assert.equal(run.entries[0]!.state, "done", "a rate-limited verify never masquerades as an unmoved message");
  assert.equal(flaky.getCalls.filter((id) => id === "m1").length, 3, "fresh read + failed verify + retried verify");
});

test("retry: undo recomputes its delta after a lost response — restored exactly, modified once", async () => {
  const mock = new MockGmailTransport([msg({ id: "m1", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] })]);
  const flaky = new FlakyTransport(mock);
  const dir = freshDir();
  const { store, run } = await archiveFixture(flaky, "retry-5", dir);
  assert.equal(run.status, "verified-done");
  const modifiesBeforeUndo = flaky.modifyCalls.length;
  flaky.fail({ method: "modify", id: "m1", times: 1, error: err503, afterApply: true });
  const engine = engineFor(flaky, "retry-5");
  const undone = await engine.undo("retry-5", store);
  assert.equal(undone.status, "undone");
  assert.equal(flaky.modifyCalls.length - modifiesBeforeUndo, 1, "the undo modify landed once; the retry saw an empty delta");
  const after = await mock.get("m1");
  assert.deepEqual([...after!.labelIds].sort(), ["CATEGORY_PROMOTIONS", "INBOX"], "the exact prior set is back");
});

// ----------------------------------------------------- receipt integrity

async function settledBatch(dir: string, batchId: string, withUndo: boolean): Promise<GmailCleanupManifestStore> {
  const mock = new MockGmailTransport([msg({ id: "m1" }), msg({ id: "m2" })]);
  const engine = engineFor(mock, batchId);
  const store = storeIn(dir);
  const sink = receiptSinkIn(dir);
  const plan = await engine.select(NEWS_RULES, "h");
  store.saveDryRun(plan);
  await engine.archive(batchId, store, { rules: NEWS_RULES, hash: "h" }, sink);
  if (withUndo) await engine.undo(batchId, store, sink);
  return store;
}

test("verify: a settled batch's receipts verify against the issuer and the manifest — archive and undo", async () => {
  const dir = freshDir();
  const store = await settledBatch(dir, "verify-1", true);
  const v = verifyCleanupBatchReceipts(store, "verify-1", receiptSinkIn(dir));
  assert.ok(v);
  assert.equal(v.ok, true);
  assert.equal(v.archive.status, "ok");
  assert.equal(v.undo.status, "ok");
  assert.deepEqual(v.warnings, []);
  assert.ok(formatCleanupReceiptVerification(v).join("\n").includes("verify — batch verify-1: OK"));
});

test("verify: a batch that has not been undone reports the undo side as not-run, still ok", async () => {
  const dir = freshDir();
  const store = await settledBatch(dir, "verify-2", false);
  const v = verifyCleanupBatchReceipts(store, "verify-2", receiptSinkIn(dir));
  assert.ok(v);
  assert.equal(v.ok, true);
  assert.equal(v.archive.status, "ok");
  assert.equal(v.undo.status, "not-run");
});

test("verify: a manifest altered after settlement fails the hash binding", async () => {
  const dir = freshDir();
  const store = await settledBatch(dir, "verify-3", false);
  const path = store.runPath("verify-3");
  const tampered = JSON.parse(readFileSync(path, "utf8")) as CleanupRunManifest;
  tampered.entries[0]!.state = "skipped-stale"; // rewrite history: pretend it never archived
  writeFileSync(path, JSON.stringify(tampered, null, 2) + "\n");
  const v = verifyCleanupBatchReceipts(store, "verify-3", receiptSinkIn(dir));
  assert.ok(v);
  assert.equal(v.ok, false);
  assert.equal(v.archive.status, "hash-mismatch");
});

test("verify: a tampered log entry fails its signature; a deleted entry reads as missing", async () => {
  const dir = freshDir();
  const store = await settledBatch(dir, "verify-4", false);
  const sink = receiptSinkIn(dir);
  const lines = readFileSync(sink.logPath, "utf8").split("\n").filter(Boolean);
  const receipts = lines.map((l) => JSON.parse(l) as { receiptId: string; jobId: string; contentHash: string });
  const archiveReceipt = receipts.find((r) => r.jobId === "gmail-cleanup-verify-4")!;
  archiveReceipt.contentHash = "0".repeat(64);
  writeFileSync(sink.logPath, receipts.map((r) => JSON.stringify(r)).join("\n") + "\n");
  let v = verifyCleanupBatchReceipts(store, "verify-4", sink);
  assert.ok(v);
  assert.equal(v.ok, false);
  assert.equal(v.archive.status, "bad-signature");

  // Now the entry vanishes from the log altogether.
  writeFileSync(sink.logPath, "");
  v = verifyCleanupBatchReceipts(store, "verify-4", sink);
  assert.ok(v);
  assert.equal(v.ok, false);
  assert.equal(v.archive.status, "missing");
});

test("verify: a run that settled without a receipt sink reports not-recorded, not failure", async () => {
  const dir = freshDir();
  const mock = new MockGmailTransport([msg({ id: "m1" })]);
  const engine = engineFor(mock, "verify-5");
  const store = storeIn(dir);
  const plan = await engine.select(NEWS_RULES, "h");
  store.saveDryRun(plan);
  await engine.archive("verify-5", store, { rules: NEWS_RULES, hash: "h" }); // no sink
  const v = verifyCleanupBatchReceipts(store, "verify-5", receiptSinkIn(dir));
  assert.ok(v);
  assert.equal(v.ok, true);
  assert.equal(v.archive.status, "not-recorded");
});

test("verify: a torn line elsewhere in the shared log is a loud warning, not a silent skip", async () => {
  const dir = freshDir();
  const store = await settledBatch(dir, "verify-6", false);
  const sink = receiptSinkIn(dir);
  writeFileSync(sink.logPath, readFileSync(sink.logPath, "utf8") + "{torn append\n");
  const v = verifyCleanupBatchReceipts(store, "verify-6", sink);
  assert.ok(v);
  assert.equal(v.ok, true, "the batch's own receipts still verify");
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0]!, /not valid JSON/);
});

test("verify CLI: exit 0 on a sound batch, exit 1 once the manifest is tampered with", async () => {
  const dir = freshDir();
  const store = await settledBatch(dir, "verify-7", false);
  const deps = {
    vault: new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key")),
    directory: directoryWith([]),
    stateDir: dir,
    transport: new MockGmailTransport([]) as GmailTransport,
  };
  const good = await captureConsole(() => runGmailCleanupAdmin(["verify", "--batch", "verify-7"], deps));
  assert.equal(good.result, 0);
  assert.ok(good.out.includes("verify — batch verify-7: OK"));

  const path = store.runPath("verify-7");
  const tampered = JSON.parse(readFileSync(path, "utf8")) as CleanupRunManifest;
  tampered.entries[0]!.state = "failed";
  writeFileSync(path, JSON.stringify(tampered, null, 2) + "\n");
  const bad = await captureConsole(() => runGmailCleanupAdmin(["verify", "--batch", "verify-7"], deps));
  assert.equal(bad.result, 1);
  assert.ok(bad.out.includes("verify — batch verify-7: FAILED"));
  assert.ok(bad.out.includes("hash-mismatch"));
});

// --------------------------------------------------- scheduler hardening

test("scheduler state: every field is shape-checked on load — bad shapes degrade, never crash", () => {
  const dir = freshDir();
  writeFileSync(
    join(dir, "gmail-cleanup-scheduler-state.json"),
    JSON.stringify({
      version: 1,
      lastRunDate: "yesterday", // a string, but not a date — dropped
      lastReportDate: "2026-11-19",
      pendingReport: { date: "2026-11-19", batchId: 42, failure: "boom" }, // batchId not a string — dropped, report kept
    }),
  );
  const state = loadCleanupSchedulerState(dir);
  assert.equal(state.lastRunDate, undefined);
  assert.equal(state.lastReportDate, "2026-11-19");
  assert.deepEqual(state.pendingReport, { date: "2026-11-19", failure: "boom" });

  writeFileSync(
    join(dir, "gmail-cleanup-scheduler-state.json"),
    JSON.stringify({ version: 1, pendingReport: { date: "Nov 19", batchId: "b1" } }),
  );
  assert.equal(loadCleanupSchedulerState(dir).pendingReport, undefined, "an undatable pending report is dropped whole");
});

test("scheduler config: the save is atomic and round-trips", () => {
  const dir = freshDir();
  saveCleanupSchedulerConfig(dir, { version: 1, enabled: true, runAt: "02:30", reportAt: "07:00", conversationId: "chat-1" });
  assert.deepEqual(readdirSync(dir), ["gmail-cleanup-scheduler.json"], "no tmp left behind");
  const { config } = loadCleanupSchedulerConfig(dir);
  assert.equal(config.enabled, true);
  assert.equal(config.conversationId, "chat-1");
});

test("scheduler catch-up: three days off runs exactly ONE combined cycle on wake, stale report first", async () => {
  const dir = freshDir();
  // Local wall-clock: Sat Nov 21 2026, 08:00 — past both windows.
  const nowMs = new Date(2026, 10, 21, 8, 0).getTime();
  const today = localDateKey(new Date(nowMs));
  // State as the three-days-off Mac left it: last run Nov 18, and
  // a Nov 19 failure report that never got delivered.
  saveCleanupSchedulerState(dir, {
    version: 1,
    lastRunDate: "2026-11-18",
    pendingReport: { date: "2026-11-19", failure: "the pack exploded (fixture)" },
  });
  saveCleanupSchedulerConfig(dir, { version: 1, enabled: true, runAt: "02:30", reportAt: "07:00", conversationId: "chat-1" });
  writeFileSync(
    join(dir, "gmail-cleanup-rules.json"),
    JSON.stringify({
      version: 1,
      nightlyCap: 200,
      neverArchiveSenders: [],
      rules: [{ name: "Promotions older than 30d", labelIds: ["CATEGORY_PROMOTIONS"], olderThanDays: 30 }],
    }),
  );
  const mock = new MockGmailTransport([
    msg({ id: "p1", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] }),
    msg({ id: "p2", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] }),
    msg({ id: "p3", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] }),
  ]);
  const sent: { conversationId: string; text: string }[] = [];
  const deps: GmailCleanupSchedulerDeps = {
    stateDir: dir,
    vault: new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key")),
    directory: directoryWith([]),
    notify: async (conversationId, text) => {
      sent.push({ conversationId, text });
    },
    transport: mock as GmailTransport,
    now: () => nowMs,
  };

  const tick = await gmailCleanupSchedulerTick(deps);
  assert.equal(tick.ran, true);
  assert.equal(sent.length, 2, "the stale report and the fresh report, in that order");
  assert.ok(sent[0]!.text.includes("The overnight cleanup FAILED: the pack exploded (fixture)"), "stale failure report goes first");
  assert.ok(sent[1]!.text.includes("Archived 3 messages (1 rule):"), "then today's cycle reports");
  assert.ok(sent[1]!.text.includes("This week: 1 cleanup batch, 3 archived."), "with the weekly summary line");

  const store = storeIn(dir);
  assert.equal(store.listRuns().runs.length, 1, "exactly one cycle ran for the three missed days — combined, capped, not tripled");
  assert.equal(loadCleanupSchedulerState(dir).lastRunDate, today);

  const again = await gmailCleanupSchedulerTick(deps);
  assert.equal(again.ran, false, "a second tick the same day does not re-run");
  assert.equal(sent.length, 2, "and does not re-report");
});

// ------------------------------------------------------- weekly summary

test("weekly summary: trailing 7 days only, undone batches net out, corrupt manifests are counted not hidden", () => {
  const dir = freshDir();
  const store = storeIn(dir);
  const entry = (id: string, state: "done" | "failed", undone = false) => ({
    id,
    threadId: `t-${id}`,
    from: "news@example.com",
    subject: `S ${id}`,
    date: daysAgo(60),
    priorLabelIds: ["INBOX"],
    rule: "Newsletters",
    state,
    ...(undone ? { undone: true } : {}),
  });
  store.saveRun(runFixture("wk-a", { startedAt: NOW - DAY, entries: [entry("a1", "done"), entry("a2", "done"), entry("a3", "done")] }));
  store.saveRun(
    runFixture("wk-b", {
      startedAt: NOW - 3 * DAY,
      status: "undone",
      entries: [entry("b1", "done", true), entry("b2", "done", true), entry("b3", "failed")],
    }),
  );
  store.saveRun(runFixture("wk-c", { startedAt: NOW - 8 * DAY, entries: [entry("c1", "done")] })); // outside the window
  writeFileSync(store.runPath("wk-broken"), "{torn");

  const s = buildWeeklyCleanupSummary(store, NOW);
  assert.equal(s.batches, 2);
  assert.equal(s.archived, 3, "wk-b's entries were restored — they do not count as archived");
  assert.equal(s.undoneBatches, 1);
  assert.equal(s.failedEntries, 1);
  assert.equal(s.corruptManifests, 1);
  assert.equal(s.line, "This week: 2 cleanup batches, 3 archived, 1 undone, 1 failed, 1 corrupt manifest skipped.");
});

test("report: the weekly line slots between the batch line and the undo line; the one-line empty report keeps its shape", () => {
  const run = runFixture("wk-report", {
    jobId: "gmail-cleanup-wk-report",
    receiptId: "rcpt-wk",
    entries: [
      {
        id: "m1",
        threadId: "t1",
        from: "news@example.com",
        subject: "S",
        date: daysAgo(60),
        priorLabelIds: ["INBOX"],
        rule: "Newsletters",
        state: "done" as const,
      },
    ],
  });
  const text = buildCleanupReport({ date: new Date(NOW), run, weeklySummary: "This week: 1 cleanup batch, 1 archived." });
  const lines = text.split("\n");
  const batchAt = lines.findIndex((l) => l.startsWith("Batch wk-report"));
  const weekAt = lines.findIndex((l) => l.startsWith("This week:"));
  const undoAt = lines.findIndex((l) => l.startsWith("Undo:"));
  assert.ok(batchAt >= 0 && weekAt === batchAt + 1 && undoAt === weekAt + 1, "batch, weekly, undo — in that order");

  const empty = buildCleanupReport({
    date: new Date(NOW),
    run: runFixture("wk-empty", { entries: [] }),
    weeklySummary: "This week: 1 cleanup batch, 0 archived.",
  });
  assert.ok(!empty.includes("\n"), "the nothing-to-archive report stays one line, weekly line or not");
});

// ------------------------------------------------------------------- soak

async function snapshotOf(mock: MockGmailTransport): Promise<[string, string][]> {
  const all = await mock.search("", 100_000);
  return all.map((m) => [m.id, [...m.labelIds].sort().join(",")] as [string, string]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

test("soak: 25 cycles of dry-run → archive → report → verify → undo return the mailbox to its exact initial state", async () => {
  const dir = freshDir();
  const store = storeIn(dir);
  const sink = receiptSinkIn(dir);
  const seed: GmailMessage[] = [];
  for (let i = 1; i <= 30; i++) {
    seed.push(msg({ id: `p${i}`, from: `deals${i}@shop.example`, labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] }));
  }
  for (let i = 1; i <= 12; i++) seed.push(msg({ id: `n${i}`, date: daysAgo(45) }));
  for (let i = 1; i <= 6; i++) {
    seed.push(msg({ id: `s${i}`, from: `deals${i}@shop.example`, labelIds: ["INBOX", "CATEGORY_PROMOTIONS", "STARRED"] }));
  }
  for (let i = 1; i <= 3; i++) {
    seed.push(msg({ id: `u${i}`, from: `deals${i}@shop.example`, labelIds: ["INBOX", "CATEGORY_PROMOTIONS", "UNREAD"], date: daysAgo(2) }));
  }
  for (let i = 1; i <= 3; i++) seed.push(msg({ id: `x${i}`, from: "friend@example.com", date: daysAgo(90) }));
  const mock = new MockGmailTransport(seed);
  const initial = await snapshotOf(mock);
  assert.equal(initial.length, 54);

  const RULES_A = rules({
    rules: [
      { name: "promos>30d", labelIds: ["CATEGORY_PROMOTIONS"], olderThanDays: 30 },
      { name: "newsletters", from: ["news@example.com"] },
    ],
  });
  const RULES_B = rules({ rules: [{ name: "promos>30d", labelIds: ["CATEGORY_PROMOTIONS"], olderThanDays: 30 }] });

  for (let cycle = 0; cycle < 25; cycle++) {
    const batchId = `soak-${cycle}`;
    const cycleRules = cycle % 2 === 0 ? RULES_A : RULES_B;
    const hash = `soak-hash-${cycle}`;
    const flaky = new FlakyTransport(mock);
    if (cycle % 5 === 4) {
      // One rate-limit per such cycle, on the run's first modify.
      flaky.fail({ method: "modify", times: 1, error: err503 });
    }
    if (cycle === 12) {
      // A hard failure on one entry: the batch settles
      // failed-loudly, and undo must still restore the rest.
      flaky.fail({ method: "modify", id: "p7", times: 99, error: err400 });
    }
    const engine = engineFor(flaky, batchId);
    const before = await snapshotOf(mock);
    assert.deepEqual(before, initial, `cycle ${cycle} starts from the exact initial mailbox`);

    const plan = await engine.select(cycleRules, hash);
    store.saveDryRun(plan);
    const run = await engine.archive(batchId, store, { rules: cycleRules, hash }, sink);
    assert.equal(run.status, cycle === 12 ? "failed-loudly" : "verified-done", `cycle ${cycle} settles as expected`);

    const report = buildCleanupReport({ date: new Date(NOW), run, plan });
    assert.ok(report.includes(`Batch ${batchId}`), `cycle ${cycle} report names its batch`);

    const v = verifyCleanupBatchReceipts(store, batchId, sink);
    assert.ok(v && v.ok, `cycle ${cycle} receipts verify before undo`);

    const undone = await engine.undo(batchId, store, sink);
    assert.equal(undone.status, "undone", `cycle ${cycle} undo completes`);
    const v2 = verifyCleanupBatchReceipts(store, batchId, sink);
    assert.ok(v2 && v2.ok && v2.undo.status === "ok", `cycle ${cycle} receipts verify after undo`);

    const after = await snapshotOf(mock);
    assert.deepEqual(after, initial, `cycle ${cycle} leaves the mailbox EXACTLY as it found it`);
  }

  assert.equal(existsSync(join(dir, "receipts.jsonl")), true);
  assert.equal(store.listRuns().runs.length, 25, "every cycle's manifest is on disk");
  assert.equal(store.listRuns().corrupt.length, 0, "and none of them is corrupt");
});
