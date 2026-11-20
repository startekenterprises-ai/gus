/**
 * Gmail cleanup MVP chunk 4 (tap-through + rule proposals) tests.
 *
 * What is pinned here:
 *  - `cleanup show --batch <id>` prints a fixture batch's record
 *    EXACTLY — every report line resolves to the manifest entries
 *    (exact IDs, rule per ID, prior label sets, receipt) — and a
 *    batch with no run manifest has no record to show.
 *  - cleanupBatchRecord carries the dry-run selection context
 *    when that manifest exists and reports plan: null when it
 *    doesn't (the run manifest stands alone, never reconstructed).
 *  - Proposal generation is deterministic and metadata-only:
 *    a repeated, bulk-labelled, unmatched sender is proposed;
 *    below-threshold, weakly-bulk, rule-covered, starred, unread,
 *    never-archive, and known-correspondent senders are not. It
 *    only ever searches — it cannot change the mailbox.
 *  - The proposals lifecycle through the operator CLI: generate →
 *    list → accept appends the rule to the rule file (validated
 *    by the engine's own loader) and a later dry run matches the
 *    sender; reject is final and never applies; an accept that
 *    would corrupt the rule file fails closed — file untouched,
 *    proposal still pending.
 *  - An UNACCEPTED proposal has zero effect on an armed cycle:
 *    the cycle archives what the rules name and leaves the
 *    proposed sender's mail exactly where it was.
 *
 * Everything runs against the pack's MockGmailTransport and temp
 * state dirs — no real mailbox, no network, no sends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GmailDirectory,
  MockGmailTransport,
  type GmailMessage,
  type GmailOutgoing,
  type GmailTransport,
} from "../../packages/control-plane/src/gmail.js";
import {
  GmailCleanupEngine,
  GmailCleanupManifestStore,
  cleanupBatchRecord,
  formatCleanupBatchRecord,
  loadCleanupRules,
  runGmailCleanupAdmin,
  type CleanupDryRunManifest,
  type CleanupRunManifest,
  type GmailCleanupRuleFile,
} from "../../packages/control-plane/src/gmail-cleanup.js";
import {
  GmailCleanupProposalStore,
  cleanupProposalsPath,
  generateCleanupProposals,
  proposalIdFor,
  runGmailCleanupProposalsAdmin,
} from "../../packages/control-plane/src/gmail-cleanup-proposals.js";
import {
  gmailCleanupSchedulerTick,
  saveCleanupSchedulerConfig,
} from "../../packages/control-plane/src/gmail-cleanup-scheduler.js";
import { VaultBroker } from "../../packages/vault/src/index.js";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(NOW - n * DAY).toUTCString();

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-cleanup4-"));
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

function vaultIn(dir: string): VaultBroker {
  return new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key"));
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
  methods(): string[] {
    return [...new Set(this.calls.map((c) => c.method))];
  }
}

async function captureConsole(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    const code = await fn();
    return { code, out: logs.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

async function labelsOf(t: GmailTransport, id: string): Promise<string[]> {
  const m = await t.get(id);
  assert.ok(m, `message ${id} exists`);
  return [...m.labelIds].sort();
}

// ------------------------------------------------------------- tap-through

const SHOW_BATCH = "cleanup-fixture-1";
const SHOW_STARTED = Date.parse("2026-11-21T02:30:00.000Z");
const SHOW_FINISHED = Date.parse("2026-11-21T02:31:00.000Z");

function writeShowFixtures(stateDir: string): void {
  mkdirSync(join(stateDir, "gmail-cleanup"), { recursive: true });
  const store = new GmailCleanupManifestStore(join(stateDir, "gmail-cleanup"));
  const entries = [
    {
      id: "m1",
      threadId: "t1",
      from: "deals@shop.example",
      subject: "Big sale",
      date: "Thu, 01 Oct 2026 10:00:00 GMT",
      priorLabelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      rule: "promos>30d",
    },
    {
      id: "m2",
      threadId: "t2",
      from: "news@example.com",
      subject: "Weekly digest",
      date: "Fri, 02 Oct 2026 09:00:00 GMT",
      priorLabelIds: ["INBOX"],
      rule: "news",
    },
    {
      id: "m3",
      threadId: "t3",
      from: "deals@shop.example",
      subject: "Bigger sale",
      date: "Sat, 03 Oct 2026 08:00:00 GMT",
      priorLabelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      rule: "promos>30d",
    },
  ];
  const dry: CleanupDryRunManifest = {
    kind: "gmail-cleanup-dry-run",
    batchId: SHOW_BATCH,
    createdAt: Date.parse("2026-11-21T02:29:00.000Z"),
    ruleFileHash: "hashfixture123",
    cap: 200,
    entries,
    byRule: { "promos>30d": 2, news: 1 },
    scanned: 10,
    noRule: 4,
    excluded: { starred: 1, important: 0, "unread-recent": 1, "never-sender": 0, "known-correspondent": 0 },
    withheld: 1,
    overCap: 0,
    shieldUnscanned: false,
  };
  const run: CleanupRunManifest = {
    kind: "gmail-cleanup-run",
    batchId: SHOW_BATCH,
    jobId: `gmail-cleanup-${SHOW_BATCH}`,
    receiptId: "rcpt_fixture123",
    startedAt: SHOW_STARTED,
    finishedAt: SHOW_FINISHED,
    ruleFileHash: "hashfixture123",
    cap: 200,
    status: "verified-done",
    entries: [
      { ...entries[0], state: "done" },
      { ...entries[1], state: "done" },
      {
        ...entries[2],
        state: "skipped-stale",
        detail: "no longer selected on fresh metadata (rule/exclusion state changed since the dry run) — left alone",
      },
    ],
  };
  writeFileSync(store.dryRunPath(SHOW_BATCH), JSON.stringify(dry, null, 2) + "\n");
  writeFileSync(store.runPath(SHOW_BATCH), JSON.stringify(run, null, 2) + "\n");
}

test("show: the printed batch record matches the fixture manifests exactly", async () => {
  const stateDir = freshDir();
  writeShowFixtures(stateDir);
  const deps = {
    vault: vaultIn(stateDir),
    directory: directoryWith([]),
    stateDir,
    transport: new MockGmailTransport([]),
    now: () => NOW,
  };
  const { code, out } = await captureConsole(() => runGmailCleanupAdmin(["show", "--batch", SHOW_BATCH], deps));
  assert.equal(code, 0);
  const expected = [
    `gmail cleanup batch ${SHOW_BATCH}`,
    `job: gmail-cleanup-${SHOW_BATCH}`,
    "receipt: rcpt_fixture123",
    "status: verified-done",
    "started: 2026-11-21T02:30:00.000Z",
    "finished: 2026-11-21T02:31:00.000Z",
    "rule file hash: hashfixture123",
    "nightly cap: 200",
    "selection: scanned 10 inbox messages; 4 matched no rule; 2 excluded (starred 1, important 0, unread<7d 1, never-sender 0, known correspondent 0); 1 withheld by the Shield gate",
    "outcome: 2 archived, 0 failed, 1 skipped-stale, 0 restored by undo — 3 entries",
    "entries:",
    "  m1 | promos>30d | deals@shop.example | Big sale | Thu, 01 Oct 2026 10:00:00 GMT | labels before: INBOX, CATEGORY_PROMOTIONS | done",
    "  m2 | news | news@example.com | Weekly digest | Fri, 02 Oct 2026 09:00:00 GMT | labels before: INBOX | done",
    "  m3 | promos>30d | deals@shop.example | Bigger sale | Sat, 03 Oct 2026 08:00:00 GMT | labels before: INBOX, CATEGORY_PROMOTIONS | skipped-stale — no longer selected on fresh metadata (rule/exclusion state changed since the dry run) — left alone",
  ].join("\n");
  assert.equal(out, expected);
});

test("show: a batch with no run manifest has no record — dry-run-only and unknown batches refuse", async () => {
  const stateDir = freshDir();
  writeShowFixtures(stateDir);
  const deps = {
    vault: vaultIn(stateDir),
    directory: directoryWith([]),
    stateDir,
    transport: new MockGmailTransport([]),
    now: () => NOW,
  };
  const unknown = await captureConsole(() => runGmailCleanupAdmin(["show", "--batch", "no-such-batch"], deps));
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /no run manifest for batch "no-such-batch"/);

  // A dry run that was never archived has no batch record either.
  const store = new GmailCleanupManifestStore(join(stateDir, "gmail-cleanup"));
  const dryOnlyManifest: CleanupDryRunManifest = {
    kind: "gmail-cleanup-dry-run",
    batchId: "dry-only",
    createdAt: NOW,
    ruleFileHash: "hashfixture123",
    cap: 200,
    entries: [],
    byRule: {},
    scanned: 0,
    noRule: 0,
    excluded: { starred: 0, important: 0, "unread-recent": 0, "never-sender": 0, "known-correspondent": 0 },
    withheld: 0,
    overCap: 0,
    shieldUnscanned: false,
  };
  writeFileSync(store.dryRunPath("dry-only"), JSON.stringify(dryOnlyManifest, null, 2) + "\n");
  const dryOnly = await captureConsole(() => runGmailCleanupAdmin(["show", "--batch", "dry-only"], deps));
  assert.equal(dryOnly.code, 1);
  assert.match(dryOnly.out, /no run manifest for batch "dry-only"/);
  const noFlag = await captureConsole(() => runGmailCleanupAdmin(["show"], deps));
  assert.equal(noFlag.code, 2);
});

test("batch record: an undone batch reports its undo, and a missing dry-run manifest reads as plan: null", () => {
  const stateDir = freshDir();
  mkdirSync(join(stateDir, "gmail-cleanup"), { recursive: true });
  const store = new GmailCleanupManifestStore(join(stateDir, "gmail-cleanup"));
  const run: CleanupRunManifest = {
    kind: "gmail-cleanup-run",
    batchId: "cleanup-undone-1",
    jobId: "gmail-cleanup-cleanup-undone-1",
    receiptId: "rcpt_run",
    startedAt: SHOW_STARTED,
    finishedAt: SHOW_FINISHED,
    ruleFileHash: "hashfixture123",
    cap: 200,
    status: "undone",
    undoneAt: Date.parse("2026-11-21T08:00:00.000Z"),
    undoJobId: "gmail-cleanup-undo-cleanup-undone-1",
    undoReceiptId: "rcpt_undo",
    entries: [
      {
        id: "m1",
        threadId: "t1",
        from: "deals@shop.example",
        subject: "Big sale",
        date: "Thu, 01 Oct 2026 10:00:00 GMT",
        priorLabelIds: ["INBOX"],
        rule: "promos>30d",
        state: "done",
        undone: true,
      },
    ],
  };
  writeFileSync(store.runPath("cleanup-undone-1"), JSON.stringify(run, null, 2) + "\n");
  const record = cleanupBatchRecord(store, "cleanup-undone-1");
  assert.ok(record);
  assert.equal(record.plan, null);
  assert.deepEqual(record.counts, { total: 1, done: 1, failed: 0, skippedStale: 0, undone: 1 });
  assert.equal(record.undoReceiptId, "rcpt_undo");
  const lines = formatCleanupBatchRecord(record);
  assert.ok(lines.some((l) => l.startsWith("selection: (the dry-run manifest for this batch is not on disk")));
  assert.ok(lines.some((l) => l === "undo: job gmail-cleanup-undo-cleanup-undone-1 • receipt rcpt_undo • at 2026-11-21T08:00:00.000Z"));
  assert.ok(lines.some((l) => l.includes("| done (undone)")));
  assert.equal(cleanupBatchRecord(store, "nope"), null);
});

// ------------------------------------------------------- proposal generation

function proposalMailbox(): MockGmailTransport {
  const bulk = (id: string, from: string, extra: string[] = ["CATEGORY_PROMOTIONS"], days = 60): GmailMessage =>
    msg({ id, from, labelIds: ["INBOX", ...extra], date: daysAgo(days), subject: `Offer ${id}` });
  return new MockGmailTransport([
    // The one proposable sender: 4 unmatched, 3 of them bulk-labelled.
    bulk("d1", "deals@shop.example", ["CATEGORY_PROMOTIONS"], 70),
    bulk("d2", "deals@shop.example", ["CATEGORY_PROMOTIONS"], 65),
    bulk("d3", "deals@shop.example", ["CATEGORY_PROMOTIONS"], 62),
    bulk("d4", "deals@shop.example", [], 61),
    // Repeated but weakly bulk (1 of 3) — under the bulk-half bar.
    bulk("b1", "blog@corp.example", ["CATEGORY_PROMOTIONS"], 70),
    bulk("b2", "blog@corp.example", [], 65),
    bulk("b3", "blog@corp.example", [], 62),
    // A known correspondent — never proposed, however bulk it looks.
    bulk("f1", "friend@pal.example", ["CATEGORY_UPDATES"], 70),
    bulk("f2", "friend@pal.example", ["CATEGORY_UPDATES"], 65),
    bulk("f3", "friend@pal.example", ["CATEGORY_UPDATES"], 62),
    bulk("f4", "friend@pal.example", ["CATEGORY_UPDATES"], 61),
    // Starred mail is protected before counting.
    bulk("s1", "starred@shop.example", ["CATEGORY_PROMOTIONS", "STARRED"], 70),
    bulk("s2", "starred@shop.example", ["CATEGORY_PROMOTIONS", "STARRED"], 65),
    bulk("s3", "starred@shop.example", ["CATEGORY_PROMOTIONS", "STARRED"], 62),
    // Unread mail is not counted (a default rule could not take it).
    bulk("u1", "unread@shop.example", ["CATEGORY_PROMOTIONS", "UNREAD"], 70),
    bulk("u2", "unread@shop.example", ["CATEGORY_PROMOTIONS", "UNREAD"], 65),
    bulk("u3", "unread@shop.example", ["CATEGORY_PROMOTIONS", "UNREAD"], 62),
    // On the never-archive list.
    bulk("n1", "never@shop.example", ["CATEGORY_PROMOTIONS"], 70),
    bulk("n2", "never@shop.example", ["CATEGORY_PROMOTIONS"], 65),
    bulk("n3", "never@shop.example", ["CATEGORY_PROMOTIONS"], 62),
    // Already covered by a rule.
    bulk("c1", "covered@letters.example", ["CATEGORY_SOCIAL"], 70),
    bulk("c2", "covered@letters.example", ["CATEGORY_SOCIAL"], 65),
    bulk("c3", "covered@letters.example", ["CATEGORY_SOCIAL"], 62),
    // Below the count threshold.
    bulk("o1", "oneoff@shop.example", ["CATEGORY_PROMOTIONS"], 70),
    bulk("o2", "oneoff@shop.example", ["CATEGORY_PROMOTIONS"], 65),
  ]);
}

const PROPOSAL_RULES = rules({
  neverArchiveSenders: ["never@shop.example"],
  rules: [{ name: "letters", fromDomain: ["letters.example"] }],
});

test("proposals: generation proposes exactly the repeated bulk unmatched sender — and only ever searches", async () => {
  const stateDir = freshDir();
  const mock = proposalMailbox();
  const rec = new RecordingTransport(mock);
  const store = new GmailCleanupProposalStore(cleanupProposalsPath(stateDir));
  const pending = await generateCleanupProposals(rec, PROPOSAL_RULES, store, {
    directory: directoryWith(["friend@pal.example"]),
    now: () => NOW,
  });
  assert.deepEqual(rec.methods(), ["search"], "generation reads metadata only — no get, no modify, nothing else");
  assert.equal(pending.length, 1);
  const p = pending[0];
  assert.equal(p.id, proposalIdFor("deals@shop.example"));
  assert.equal(p.status, "pending");
  assert.deepEqual(p.rule, { name: "proposed: deals@shop.example", from: ["deals@shop.example"] });
  assert.equal(p.evidence.sender, "deals@shop.example");
  assert.equal(p.evidence.count, 4);
  assert.equal(p.evidence.bulkCount, 3);
  assert.equal(p.evidence.sampleSubjects.length, 3);
  assert.equal(p.evidence.oldestDate, daysAgo(70));
  assert.equal(p.evidence.newestDate, daysAgo(61));

  // A second pass over the same mailbox refreshes, never duplicates.
  const again = await generateCleanupProposals(rec, PROPOSAL_RULES, store, {
    directory: directoryWith(["friend@pal.example"]),
    now: () => NOW,
  });
  assert.equal(again.length, 1);
  assert.equal(store.load().proposals.length, 1);
});

// -------------------------------------------------------- proposals lifecycle

function lifecycleState(): { stateDir: string; rulesPath: string } {
  const stateDir = freshDir();
  const rulesPath = join(stateDir, "gmail-cleanup-rules.json");
  writeFileSync(
    rulesPath,
    JSON.stringify({ version: 1, nightlyCap: 200, neverArchiveSenders: [], rules: [{ name: "letters", fromDomain: ["letters.example"] }] }),
  );
  return { stateDir, rulesPath };
}

function proposalsDeps(stateDir: string, transport: GmailTransport) {
  return {
    vault: vaultIn(stateDir),
    directory: directoryWith([]),
    stateDir,
    transport,
    now: () => NOW,
  };
}

test("proposals lifecycle: generate → list → accept appends a loader-valid rule the next dry run matches", async () => {
  const { stateDir, rulesPath } = lifecycleState();
  const mock = new MockGmailTransport([
    msg({ id: "d1", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: daysAgo(70) }),
    msg({ id: "d2", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: daysAgo(65) }),
    msg({ id: "d3", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: daysAgo(62) }),
  ]);
  const deps = proposalsDeps(stateDir, mock);
  const hashBefore = loadCleanupRules(rulesPath).hash;

  const gen = await captureConsole(() => runGmailCleanupProposalsAdmin(["generate"], deps));
  assert.equal(gen.code, 0);
  assert.match(gen.out, /1 pending after this scan/);
  assert.match(gen.out, /nothing was archived and no rule changed/);
  assert.deepEqual(await labelsOf(mock, "d1"), ["CATEGORY_PROMOTIONS", "INBOX"], "generation changed nothing in the mailbox");

  const id = proposalIdFor("deals@shop.example");
  const list = await captureConsole(() => runGmailCleanupProposalsAdmin(["list"], deps));
  assert.equal(list.code, 0);
  assert.match(list.out, new RegExp(id));
  assert.match(list.out, /deals@shop\.example: 3 unmatched messages \(3 bulk-labelled\)/);
  assert.match(list.out, /\(0 accepted, 0 rejected/);

  const accept = await captureConsole(() => runGmailCleanupProposalsAdmin(["accept", id], deps));
  assert.equal(accept.code, 0);
  assert.match(accept.out, /accepted .*rule "proposed: deals@shop\.example"/);

  // The rule is in the file, the file loads through the engine's
  // own loader, and its hash moved (old manifests no longer match).
  const loaded = loadCleanupRules(rulesPath);
  assert.notEqual(loaded.hash, hashBefore);
  assert.deepEqual(
    loaded.rules.rules.map((r) => r.name),
    ["letters", "proposed: deals@shop.example"],
  );

  // …and the next dry run selects the sender under the new rule.
  const engine = new GmailCleanupEngine(mock, { directory: directoryWith([]), now: () => NOW, batchId: () => "batch-after-accept" });
  const plan = await engine.select(loaded.rules, loaded.hash);
  assert.deepEqual(plan.entries.map((e) => e.id).sort(), ["d1", "d2", "d3"]);
  assert.deepEqual(plan.byRule, { "proposed: deals@shop.example": 3 });

  // Resolved is resolved: no longer pending, and a second accept refuses.
  const listAfter = await captureConsole(() => runGmailCleanupProposalsAdmin(["list"], deps));
  assert.match(listAfter.out, /no pending cleanup rule proposals/);
  assert.match(listAfter.out, /\(1 accepted, 0 rejected/);
  const again = await captureConsole(() => runGmailCleanupProposalsAdmin(["accept", id], deps));
  assert.equal(again.code, 1);
  assert.match(again.out, /already accepted/);
});

test("proposals lifecycle: reject is final — never applied, never re-proposed", async () => {
  const { stateDir, rulesPath } = lifecycleState();
  const mock = new MockGmailTransport([
    msg({ id: "d1", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: daysAgo(70) }),
    msg({ id: "d2", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: daysAgo(65) }),
    msg({ id: "d3", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: daysAgo(62) }),
  ]);
  const deps = proposalsDeps(stateDir, mock);
  const bytesBefore = readFileSync(rulesPath, "utf8");
  const id = proposalIdFor("deals@shop.example");

  assert.equal((await captureConsole(() => runGmailCleanupProposalsAdmin(["generate"], deps))).code, 0);
  const reject = await captureConsole(() => runGmailCleanupProposalsAdmin(["reject", id], deps));
  assert.equal(reject.code, 0);
  assert.match(reject.out, /was never applied and will not be proposed again/);
  assert.equal(readFileSync(rulesPath, "utf8"), bytesBefore, "reject never touches the rule file");

  // Regeneration does not resurrect a rejected sender.
  const gen2 = await captureConsole(() => runGmailCleanupProposalsAdmin(["generate"], deps));
  assert.equal(gen2.code, 0);
  assert.match(gen2.out, /0 pending after this scan/);
  const store = new GmailCleanupProposalStore(cleanupProposalsPath(stateDir));
  assert.equal(store.load().proposals.filter((p) => p.status === "pending").length, 0);
  assert.equal(store.load().proposals.find((p) => p.id === id)?.status, "rejected");

  const again = await captureConsole(() => runGmailCleanupProposalsAdmin(["reject", id], deps));
  assert.equal(again.code, 1);
  assert.match(again.out, /already rejected/);
});

test("proposals: an accept that would corrupt the rule file fails closed — file untouched, proposal pending", async () => {
  const stateDir = freshDir();
  const rulesPath = join(stateDir, "gmail-cleanup-rules.json");
  // A hand-made rule already owns the proposal's generated name
  // (with different criteria, so the sender stays unmatched).
  writeFileSync(
    rulesPath,
    JSON.stringify({
      version: 1,
      nightlyCap: 200,
      neverArchiveSenders: [],
      rules: [{ name: "proposed: deals@shop.example", fromDomain: ["other.example"] }],
    }),
  );
  const bytesBefore = readFileSync(rulesPath, "utf8");
  const mock = new MockGmailTransport([
    msg({ id: "d1", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: daysAgo(70) }),
    msg({ id: "d2", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: daysAgo(65) }),
    msg({ id: "d3", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: daysAgo(62) }),
  ]);
  const deps = proposalsDeps(stateDir, mock);
  const id = proposalIdFor("deals@shop.example");
  assert.equal((await captureConsole(() => runGmailCleanupProposalsAdmin(["generate"], deps))).code, 0);

  const accept = await captureConsole(() => runGmailCleanupProposalsAdmin(["accept", id], deps));
  assert.equal(accept.code, 1);
  assert.match(accept.out, /would produce an invalid rule file/);
  assert.match(accept.out, /duplicate rule name/);
  assert.equal(readFileSync(rulesPath, "utf8"), bytesBefore, "the rule file is byte-identical after the refused accept");
  assert.equal(existsSync(`${rulesPath}.tmp-proposal`), false, "no temp file is left behind");
  const store = new GmailCleanupProposalStore(cleanupProposalsPath(stateDir));
  assert.equal(store.load().proposals.find((p) => p.id === id)?.status, "pending", "the proposal stays pending");
});

// ------------------------------------------------- unaccepted means inert

test("proposals: an unaccepted proposal has zero effect on an armed cycle", async () => {
  const stateDir = freshDir();
  writeFileSync(
    join(stateDir, "gmail-cleanup-rules.json"),
    JSON.stringify({ version: 1, nightlyCap: 200, neverArchiveSenders: [], rules: [{ name: "letters", fromDomain: ["letters.example"] }] }),
  );
  saveCleanupSchedulerConfig(stateDir, {
    version: 1,
    enabled: true,
    runAt: "02:30",
    reportAt: "07:00",
    conversationId: "chat-1",
  });
  // A pending proposal for the bulk sender already sits in the file.
  const store = new GmailCleanupProposalStore(cleanupProposalsPath(stateDir));
  store.save({
    version: 1,
    proposals: [
      {
        id: proposalIdFor("deals@shop.example"),
        createdAt: NOW,
        updatedAt: NOW,
        status: "pending",
        rule: { name: "proposed: deals@shop.example", from: ["deals@shop.example"] },
        evidence: {
          sender: "deals@shop.example",
          count: 4,
          bulkCount: 4,
          sampleSubjects: ["Offer d1"],
          oldestDate: daysAgo(70),
          newestDate: daysAgo(61),
        },
      },
    ],
  });
  const at230 = new Date(2026, 10, 21, 2, 30).getTime();
  const old = (n: number): string => new Date(at230 - n * DAY).toUTCString();
  const mock = new MockGmailTransport([
    msg({ id: "keep1", from: "news@letters.example", date: old(60) }),
    msg({ id: "d1", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: old(70), subject: "Offer d1" }),
    msg({ id: "d2", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: old(65), subject: "Offer d2" }),
    msg({ id: "d3", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: old(62), subject: "Offer d3" }),
    msg({ id: "d4", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: old(61), subject: "Offer d4" }),
  ]);
  const sent: { conversationId: string; text: string }[] = [];
  const tick = await gmailCleanupSchedulerTick({
    stateDir,
    vault: vaultIn(stateDir),
    directory: directoryWith([]),
    notify: async (conversationId, text) => {
      sent.push({ conversationId, text });
    },
    transport: mock,
    now: () => at230,
  });
  assert.equal(tick.ran, true);
  // The rule's mail was archived; the proposed sender's mail is
  // exactly where it was — the pending proposal did nothing.
  assert.deepEqual(await labelsOf(mock, "keep1"), []);
  for (const id of ["d1", "d2", "d3", "d4"]) {
    assert.deepEqual(await labelsOf(mock, id), ["CATEGORY_PROMOTIONS", "INBOX"], `${id} untouched by the unaccepted proposal`);
  }
  // And it is still pending afterwards (the cycle-end generation
  // refreshed its evidence; it did not apply it).
  const after = new GmailCleanupProposalStore(cleanupProposalsPath(stateDir)).load();
  assert.equal(after.proposals.find((p) => p.id === proposalIdFor("deals@shop.example"))?.status, "pending");
});
