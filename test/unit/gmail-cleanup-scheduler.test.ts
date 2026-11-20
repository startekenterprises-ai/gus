/**
 * Gmail cleanup MVP chunk 3 (scheduler + morning report) tests.
 *
 * What is pinned here:
 *  - The scheduler ships DEFAULT OFF: with no config file (or an
 *    explicit disable) a tick makes NO transport calls and sends
 *    nothing — arming is the operator's explicit act, via
 *    `gmail-admin cleanup schedule enable`.
 *  - A malformed scheduler config fails closed (treated as off).
 *  - The chunk-1 status surface reports the armed state.
 *  - The nightly cycle rides chunks 1–2 exactly: fresh dry-run
 *    selection → archive from that run's own manifest → the
 *    morning report at the report window, built from the
 *    manifests, carrying per-rule counts, the batch id, the
 *    receipt id, and the undo command.
 *  - A failed cycle (pack not set up, selection throwing) still
 *    reports — plainly — at report time, and archives nothing.
 *  - Catch-up: a first tick after both windows runs the cycle and
 *    delivers its report in the same tick; a second tick the same
 *    day does not re-run.
 *
 * Everything runs against the pack's MockGmailTransport behind a
 * call recorder and a captured notify — no real mailbox, no real
 * Telegram send, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GmailDirectory,
  MockGmailTransport,
  GMAIL_OAUTH_SECRET,
  type GmailMessage,
  type GmailOutgoing,
  type GmailTransport,
} from "../../packages/control-plane/src/gmail.js";
import {
  GmailCleanupManifestStore,
  runGmailCleanupAdmin,
  type CleanupPlan,
  type CleanupRunManifest,
} from "../../packages/control-plane/src/gmail-cleanup.js";
import {
  buildCleanupReport,
  formatReportDate,
  gmailCleanupSchedulerTick,
  loadCleanupSchedulerConfig,
  localDateKey,
  runGmailCleanupScheduleAdmin,
  saveCleanupSchedulerConfig,
  startGmailCleanupScheduler,
  type GmailCleanupSchedulerDeps,
} from "../../packages/control-plane/src/gmail-cleanup-scheduler.js";
import { VaultBroker } from "../../packages/vault/src/index.js";

// ------------------------------------------------------------ fixtures

const DAY = 86_400_000;
/** Local wall-clock on Sat Nov 21, 2026 — the scheduler's "today". */
const at = (h: number, m: number): number => new Date(2026, 10, 21, h, m).getTime();
const daysBefore = (base: number, n: number): string => new Date(base - n * DAY).toUTCString();

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-cleanup-sched-"));
}

function msg(partial: Partial<GmailMessage> & { id: string }): GmailMessage {
  return {
    threadId: `thread-${partial.id}`,
    from: "news@example.com",
    to: ["me@example.com"],
    subject: `Subject ${partial.id}`,
    snippet: `snippet ${partial.id}`,
    date: daysBefore(at(2, 30), 60),
    labelIds: ["INBOX"],
    body: "",
    ...partial,
  };
}

function vaultIn(dir: string): VaultBroker {
  return new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key"));
}

function directoryIn(dir: string): GmailDirectory {
  return new GmailDirectory(join(dir, "gmail-directory.json"));
}

/** Records every call through the full GmailTransport surface, so
 *  tests can prove what did NOT happen (the chunks 1–2 pattern). */
class RecordingTransport implements GmailTransport {
  readonly calls: { method: string; args: unknown[] }[] = [];
  constructor(private inner: MockGmailTransport) {}
  private rec(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }
  async search(q: string, m: number) {
    this.rec("search", [q, m]);
    return this.inner.search(q, m);
  }
  async get(id: string) {
    this.rec("get", [id]);
    return this.inner.get(id);
  }
  async createDraft(m: GmailOutgoing) {
    this.rec("createDraft", [m]);
    return this.inner.createDraft(m);
  }
  async send(m: GmailOutgoing) {
    this.rec("send", [m]);
    return this.inner.send(m);
  }
  async modify(id: string, add: string[], remove: string[]) {
    this.rec("modify", [id, add, remove]);
    return this.inner.modify(id, add, remove);
  }
  async trash(id: string) {
    this.rec("trash", [id]);
    return this.inner.trash(id);
  }
  async deleteForever(id: string) {
    this.rec("deleteForever", [id]);
    return this.inner.deleteForever(id);
  }
  async createBlockFilter(f: string) {
    this.rec("createBlockFilter", [f]);
    return this.inner.createBlockFilter(f);
  }
  modifies(): number {
    return this.calls.filter((c) => c.method === "modify").length;
  }
}

/** A transport whose search always throws — the failed cycle. */
class ThrowingTransport implements GmailTransport {
  async search(): Promise<never> {
    throw new Error("gmail search exploded (fixture)");
  }
  async get(): Promise<null> {
    return null;
  }
  async createDraft(): Promise<never> {
    throw new Error("unreachable");
  }
  async send(): Promise<never> {
    throw new Error("unreachable");
  }
  async modify(): Promise<void> {}
  async trash(): Promise<void> {}
  async deleteForever(): Promise<void> {}
  async createBlockFilter(): Promise<never> {
    throw new Error("unreachable");
  }
}

interface Captured {
  sent: { conversationId: string; text: string }[];
  notify: (conversationId: string, text: string) => Promise<void>;
}
function captureNotify(): Captured {
  const sent: { conversationId: string; text: string }[] = [];
  return {
    sent,
    notify: async (conversationId, text) => {
      sent.push({ conversationId, text });
    },
  };
}

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

function writeRules(stateDir: string): void {
  writeFileSync(
    join(stateDir, "gmail-cleanup-rules.json"),
    JSON.stringify({
      version: 1,
      nightlyCap: 200,
      neverArchiveSenders: [],
      rules: [
        { name: "Promotions older than 30d", labelIds: ["CATEGORY_PROMOTIONS"], olderThanDays: 30 },
        { name: "Newsletters", fromDomain: ["example.com"] },
      ],
    }),
  );
}

function armScheduler(stateDir: string, conversationId = "chat-42"): void {
  saveCleanupSchedulerConfig(stateDir, {
    version: 1,
    enabled: true,
    runAt: "02:30",
    reportAt: "07:00",
    conversationId,
  });
}

function depsFor(
  stateDir: string,
  transport: GmailTransport,
  notify: Captured["notify"],
  now: () => number,
): GmailCleanupSchedulerDeps {
  return { stateDir, vault: vaultIn(stateDir), directory: directoryIn(stateDir), transport, notify, now };
}

// ------------------------------------------------------------ config

test("config: an absent file loads the disabled default; run/report times default to 02:30 / 07:00", () => {
  const dir = freshDir();
  const { config, existed } = loadCleanupSchedulerConfig(dir);
  assert.equal(existed, false);
  assert.equal(config.enabled, false);
  assert.equal(config.runAt, "02:30");
  assert.equal(config.reportAt, "07:00");
  assert.equal(config.conversationId, undefined);
});

test("config: a malformed file fails closed — the loader throws and a tick treats it as off", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, "gmail-cleanup-scheduler.json"), "{ not json");
  assert.throws(() => loadCleanupSchedulerConfig(dir), /not valid JSON/);
  writeFileSync(join(dir, "gmail-cleanup-scheduler.json"), JSON.stringify({ version: 1, enabled: "yes" }));
  assert.throws(() => loadCleanupSchedulerConfig(dir), /enabled must be a boolean/);

  const rec = new RecordingTransport(new MockGmailTransport([msg({ id: "a" })]));
  const cap = captureNotify();
  const r = await gmailCleanupSchedulerTick(depsFor(dir, rec, cap.notify, () => at(8, 0)));
  assert.equal(r.ran, false);
  assert.match(r.detail, /treated as off/);
  assert.deepEqual(rec.calls, []);
  assert.equal(cap.sent.length, 0);
});

test("time helpers: local date key and the report header date", () => {
  assert.equal(localDateKey(new Date(2026, 10, 21, 2, 30)), "2026-11-21");
  assert.equal(formatReportDate(new Date(2026, 10, 21)), "Sat Nov 21");
});

// ------------------------------------------------------- schedule admin

test("schedule admin: enable requires a conversation; enable/disable round-trip through the config file", async () => {
  const dir = freshDir();
  const noConv = await captureConsole(() => runGmailCleanupScheduleAdmin(["enable"], { stateDir: dir }));
  assert.equal(noConv.result, 2);
  assert.match(noConv.out, /--conversation/);

  const en = await captureConsole(() =>
    runGmailCleanupScheduleAdmin(["enable", "--conversation", "chat-42"], { stateDir: dir }),
  );
  assert.equal(en.result, 0);
  assert.match(en.out, /ARMED/);
  let loaded = loadCleanupSchedulerConfig(dir);
  assert.equal(loaded.config.enabled, true);
  assert.equal(loaded.config.conversationId, "chat-42");
  assert.equal(loaded.config.runAt, "02:30");
  assert.equal(loaded.config.reportAt, "07:00");

  const badTime = await captureConsole(() =>
    runGmailCleanupScheduleAdmin(["enable", "--run-at", "25:99"], { stateDir: dir }),
  );
  assert.equal(badTime.result, 1);
  assert.equal(loadCleanupSchedulerConfig(dir).config.runAt, "02:30"); // unchanged

  const dis = await captureConsole(() => runGmailCleanupScheduleAdmin(["disable"], { stateDir: dir }));
  assert.equal(dis.result, 0);
  loaded = loadCleanupSchedulerConfig(dir);
  assert.equal(loaded.config.enabled, false);
  assert.equal(loaded.config.conversationId, "chat-42"); // kept — re-enabling needs no re-typing

  const st = await captureConsole(() => runGmailCleanupScheduleAdmin(["status"], { stateDir: dir }));
  assert.equal(st.result, 0);
  assert.match(st.out, /cleanup scheduler: off/);
});

test("status surface: cleanup status shows the scheduler off by default and ARMED after enable", async () => {
  const dir = freshDir();
  const deps = {
    vault: vaultIn(dir),
    directory: directoryIn(dir),
    stateDir: dir,
    transport: new MockGmailTransport([]),
  };
  const off = await captureConsole(() => runGmailCleanupAdmin(["status"], deps));
  assert.equal(off.result, 0);
  assert.match(off.out, /cleanup scheduler: off \(default\)/);

  armScheduler(dir);
  const on = await captureConsole(() => runGmailCleanupAdmin(["status"], deps));
  assert.equal(on.result, 0);
  assert.match(on.out, /cleanup scheduler: ARMED — nightly run at 02:30, report at 07:00 to Telegram chat chat-42/);
});

// ------------------------------------------------------- default off

test("tick: a disabled scheduler performs NO transport calls and sends nothing, even after both windows", async () => {
  const dir = freshDir();
  writeRules(dir);
  const rec = new RecordingTransport(new MockGmailTransport([msg({ id: "a", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] })]));
  const cap = captureNotify();
  // No config file at all — the shipped default.
  const r = await gmailCleanupSchedulerTick(depsFor(dir, rec, cap.notify, () => at(9, 0)));
  assert.equal(r.ran, false);
  assert.equal(r.reported, false);
  assert.deepEqual(rec.calls, []);
  assert.equal(cap.sent.length, 0);
  const after = await rec.get("a");
  assert.deepEqual(after?.labelIds, ["INBOX", "CATEGORY_PROMOTIONS"]);
});

test("tick: enabled but before the run window — nothing happens", async () => {
  const dir = freshDir();
  writeRules(dir);
  armScheduler(dir);
  const rec = new RecordingTransport(new MockGmailTransport([msg({ id: "a", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] })]));
  const cap = captureNotify();
  const r = await gmailCleanupSchedulerTick(depsFor(dir, rec, cap.notify, () => at(1, 0)));
  assert.equal(r.ran, false);
  assert.deepEqual(rec.calls, []);
  assert.equal(cap.sent.length, 0);
});

test("start: registration returns a stop function and a disabled scheduler stays inert across ticks", async () => {
  const dir = freshDir();
  writeRules(dir);
  const rec = new RecordingTransport(new MockGmailTransport([msg({ id: "a", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] })]));
  const cap = captureNotify();
  const stop = startGmailCleanupScheduler({ ...depsFor(dir, rec, cap.notify, () => at(9, 0)), tickMs: 5 });
  assert.equal(typeof stop, "function");
  await new Promise((r) => setTimeout(r, 1_200)); // let the boot tick + interval ticks fire
  stop();
  assert.deepEqual(rec.calls, []);
  assert.equal(cap.sent.length, 0);
});

// ------------------------------------------------------------- report

function fixturePlan(partial: Partial<CleanupPlan>): CleanupPlan {
  return {
    batchId: "batch-1",
    createdAt: at(2, 30),
    ruleFileHash: "hash",
    cap: 200,
    entries: [],
    byRule: {},
    scanned: 20,
    noRule: 12,
    excluded: { starred: 3, important: 1, "unread-recent": 5, "never-sender": 2, "known-correspondent": 1 },
    withheld: 2,
    overCap: 4,
    shieldUnscanned: false,
    ...partial,
  };
}

function fixtureEntry(id: string, rule: string, state: "done" | "failed"): CleanupRunManifest["entries"][number] {
  return {
    id,
    threadId: `thread-${id}`,
    from: "news@example.com",
    subject: `Subject ${id}`,
    date: daysBefore(at(2, 30), 60),
    priorLabelIds: ["INBOX"],
    rule,
    state,
  };
}

test("report: a fixture run renders exact counts by rule, left-alone counts, the receipt id, and the undo line", () => {
  const plan = fixturePlan({ byRule: { "Promotions older than 30d": 2, Newsletters: 1 } });
  const run: CleanupRunManifest = {
    kind: "gmail-cleanup-run",
    batchId: "batch-1",
    jobId: "gmail-cleanup-batch-1",
    receiptId: "rcpt-1",
    startedAt: at(2, 30),
    finishedAt: at(2, 31),
    ruleFileHash: "hash",
    cap: 200,
    status: "verified-done",
    entries: [
      fixtureEntry("p1", "Promotions older than 30d", "done"),
      fixtureEntry("p2", "Promotions older than 30d", "done"),
      fixtureEntry("n1", "Newsletters", "done"),
    ],
  };
  const text = buildCleanupReport({ date: new Date(2026, 10, 21), run, plan });
  const lines = text.split("\n");
  assert.equal(lines[0], "GUS overnight cleanup — Sat Nov 21");
  assert.ok(lines.includes("Archived 3 messages (2 rules):"));
  assert.ok(lines.includes("• Promotions older than 30d — 2"));
  assert.ok(lines.includes("• Newsletters — 1"));
  assert.ok(
    lines.includes(
      "Left alone: 12 matched no rule, 12 excluded (starred 3, important 1, unread<7d 5, never-sender 2, known correspondent 1), 4 over the nightly cap of 200",
    ),
  );
  assert.ok(lines.includes("Shield: 2 messages withheld from selection (injection patterns in their snippets)"));
  assert.ok(lines.includes("Batch batch-1 • Receipt rcpt-1"));
  assert.ok(lines.includes("Undo: gmail-admin cleanup undo --batch batch-1"));
});

test("report: nothing archived is a single line", () => {
  const plan = fixturePlan({ batchId: "batch-2", scanned: 20, byRule: {} });
  const run: CleanupRunManifest = {
    kind: "gmail-cleanup-run",
    batchId: "batch-2",
    jobId: "gmail-cleanup-batch-2",
    receiptId: "rcpt-2",
    startedAt: at(2, 30),
    finishedAt: at(2, 30),
    ruleFileHash: "hash",
    cap: 200,
    status: "verified-done",
    entries: [],
  };
  const text = buildCleanupReport({ date: new Date(2026, 10, 21), run, plan });
  assert.ok(!text.includes("\n"), "the empty report is one line");
  assert.equal(
    text,
    "GUS overnight cleanup — Sat Nov 21: nothing to archive — 20 in the inbox left alone. Batch batch-2 • Receipt rcpt-2",
  );
});

test("report: a failed cycle reports the failure plainly — before a manifest, and from a failed-loudly manifest", () => {
  const preManifest = buildCleanupReport({
    date: new Date(2026, 10, 21),
    run: null,
    plan: null,
    failure: "the Gmail pack is not set up — no gmail-oauth credential in the vault (see docs/gmail-pack.md)",
  });
  assert.match(preManifest, /GUS overnight cleanup — Sat Nov 21/);
  assert.match(preManifest, /⚠️ The overnight cleanup FAILED: the Gmail pack is not set up/);
  assert.match(preManifest, /Nothing was archived\./);

  const run: CleanupRunManifest = {
    kind: "gmail-cleanup-run",
    batchId: "batch-3",
    jobId: "gmail-cleanup-batch-3",
    receiptId: "rcpt-3",
    startedAt: at(2, 30),
    finishedAt: at(2, 31),
    ruleFileHash: "hash",
    cap: 200,
    status: "failed-loudly",
    entries: [fixtureEntry("n1", "Newsletters", "done"), fixtureEntry("n2", "Newsletters", "failed")],
  };
  const fromManifest = buildCleanupReport({ date: new Date(2026, 10, 21), run, plan: fixturePlan({ batchId: "batch-3" }) });
  assert.ok(fromManifest.includes("Archived 1 message (1 rule):"));
  assert.ok(fromManifest.includes("• Newsletters — 1"));
  assert.match(fromManifest, /⚠️ 1 message could not be archived/);
  assert.ok(fromManifest.includes("Undo: gmail-admin cleanup undo --batch batch-3"));
  assert.ok(fromManifest.includes("Batch batch-3 • Receipt rcpt-3"));
});

// ------------------------------------------------- cycle + report e2e

test("armed cycle: the run tick archives via the manifest flow; the report tick delivers counts, receipt, and undo", async () => {
  const dir = freshDir();
  writeRules(dir);
  armScheduler(dir);
  const mock = new MockGmailTransport([
    msg({ id: "p1", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] }),
    msg({ id: "p2", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] }),
    msg({ id: "n1", from: "news@example.com", labelIds: ["INBOX"] }),
    msg({ id: "keep-star", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS", "STARRED"] }),
    msg({ id: "keep-other", from: "human@elsewhere.example", labelIds: ["INBOX", "UNREAD"], date: daysBefore(at(2, 30), 1) }),
  ]);
  const rec = new RecordingTransport(mock);
  const cap = captureNotify();
  let now = at(2, 35);
  const deps = depsFor(dir, rec, cap.notify, () => now);

  const runTick = await gmailCleanupSchedulerTick(deps);
  assert.equal(runTick.ran, true);
  assert.equal(runTick.reported, false);
  assert.equal(cap.sent.length, 0); // no report before the report window
  assert.deepEqual([...(await mock.get("p1"))!.labelIds].sort(), ["CATEGORY_PROMOTIONS"]);
  assert.deepEqual([...(await mock.get("p2"))!.labelIds].sort(), ["CATEGORY_PROMOTIONS"]);
  assert.deepEqual([...(await mock.get("n1"))!.labelIds].sort(), []);
  assert.deepEqual([...(await mock.get("keep-star"))!.labelIds].sort(), ["CATEGORY_PROMOTIONS", "INBOX", "STARRED"]);
  assert.deepEqual([...(await mock.get("keep-other"))!.labelIds].sort(), ["INBOX", "UNREAD"]);
  // The narrowed surface only: no trash/send/draft ever.
  assert.deepEqual([...new Set(rec.calls.map((c) => c.method))].sort(), ["get", "modify", "search"]);

  // A second tick the same night does not re-run.
  const modifiesAfterRun = rec.modifies();
  now = at(2, 50);
  const again = await gmailCleanupSchedulerTick(deps);
  assert.equal(again.ran, false);
  assert.equal(rec.modifies(), modifiesAfterRun);

  // The morning tick delivers the report, built from the manifests.
  now = at(7, 5);
  const reportTick = await gmailCleanupSchedulerTick(deps);
  assert.equal(reportTick.reported, true);
  assert.equal(cap.sent.length, 1);
  assert.equal(cap.sent[0]!.conversationId, "chat-42");
  const text = cap.sent[0]!.text;
  assert.match(text, /^GUS overnight cleanup — Sat Nov 21/);
  assert.ok(text.includes("Archived 3 messages (2 rules):"));
  assert.ok(text.includes("• Promotions older than 30d — 2"));
  assert.ok(text.includes("• Newsletters — 1"));

  // The batch + receipt in the text are the run manifest's own.
  const store = new GmailCleanupManifestStore(join(dir, "gmail-cleanup"));
  const runFile = readdirSync(join(dir, "gmail-cleanup")).find((f) => f.endsWith(".json") && !f.startsWith("dry-"));
  assert.ok(runFile, "a run manifest exists");
  const run = store.loadRun(runFile.replace(/\.json$/, ""));
  assert.ok(run);
  assert.equal(run.status, "verified-done");
  assert.ok(text.includes(`Batch ${run.batchId} • Receipt ${run.receiptId}`));
  assert.ok(text.includes(`Undo: gmail-admin cleanup undo --batch ${run.batchId}`));
  assert.ok(existsSync(join(dir, "receipts.jsonl")), "the run's receipt was appended to the log");

  // And no second report.
  now = at(7, 20);
  const third = await gmailCleanupSchedulerTick(deps);
  assert.equal(third.reported, false);
  assert.equal(cap.sent.length, 1);
});

test("catch-up: a first tick after both windows runs the cycle and delivers its report in the same tick", async () => {
  const dir = freshDir();
  writeRules(dir);
  armScheduler(dir);
  const mock = new MockGmailTransport([msg({ id: "n1", from: "news@example.com", labelIds: ["INBOX"] })]);
  const cap = captureNotify();
  const r = await gmailCleanupSchedulerTick(depsFor(dir, new RecordingTransport(mock), cap.notify, () => at(9, 15)));
  assert.equal(r.ran, true);
  assert.equal(r.reported, true);
  assert.equal(cap.sent.length, 1);
  assert.ok(cap.sent[0]!.text.includes("Archived 1 message (1 rule):"));
  assert.deepEqual([...(await mock.get("n1"))!.labelIds].sort(), []);
});

test("failed cycle: a throwing selection still reports the failure at report time and archives nothing", async () => {
  const dir = freshDir();
  writeRules(dir);
  armScheduler(dir);
  const cap = captureNotify();
  let now = at(2, 35);
  const deps = depsFor(dir, new ThrowingTransport(), cap.notify, () => now);
  const runTick = await gmailCleanupSchedulerTick(deps);
  assert.equal(runTick.ran, true);
  assert.equal(cap.sent.length, 0);
  now = at(7, 5);
  const reportTick = await gmailCleanupSchedulerTick(deps);
  assert.equal(reportTick.reported, true);
  assert.equal(cap.sent.length, 1);
  assert.match(cap.sent[0]!.text, /⚠️ The overnight cleanup FAILED: gmail search exploded \(fixture\)/);
  assert.match(cap.sent[0]!.text, /Nothing was archived\./);
});

test("failed cycle: an armed scheduler with no Gmail credential reports the setup failure instead of staying silent", async () => {
  const dir = freshDir();
  writeRules(dir);
  armScheduler(dir);
  const cap = captureNotify();
  // No transport injected and an empty vault — the pack is not set up.
  const deps: GmailCleanupSchedulerDeps = {
    stateDir: dir,
    vault: vaultIn(dir),
    directory: directoryIn(dir),
    notify: cap.notify,
    now: () => at(9, 0),
  };
  assert.equal(deps.vault.has(GMAIL_OAUTH_SECRET), false);
  const r = await gmailCleanupSchedulerTick(deps);
  assert.equal(r.ran, true);
  assert.equal(r.reported, true);
  assert.equal(cap.sent.length, 1);
  assert.match(cap.sent[0]!.text, /⚠️ The overnight cleanup FAILED: the Gmail pack is not set up/);
  assert.match(cap.sent[0]!.text, /Nothing was archived\./);
});
