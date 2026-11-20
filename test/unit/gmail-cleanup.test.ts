/**
 * Gmail cleanup MVP (chunks 1–2) unit tests.
 *
 * What is pinned here — every guardrail from the plan as a
 * code-level check, not a prompt:
 *  - Dry-run selection is deterministic over metadata (sender /
 *    domain / label / age / read state), counts by rule, and
 *    changes NOTHING: the only transport call it can make is
 *    search.
 *  - Exclusions win over rules (starred, IMPORTANT, unread<7d,
 *    never-archive senders, known correspondents) and are
 *    re-checked on fresh metadata immediately before a modify.
 *  - The nightly cap is a code constant (200): the rule file can
 *    lower it, never raise it.
 *  - The engine's transport is narrowed to search/get/modify —
 *    trash, delete, send, and draft are unreachable, and the only
 *    archive delta ever issued is modify(id, [], ["INBOX"]).
 *  - Archive executes ONLY against a dry-run manifest: no
 *    manifest, a changed rule file, an over-cap manifest, or a
 *    second run all refuse without touching the mailbox.
 *  - The run manifest is write-ahead: a mid-run failure leaves an
 *    exact on-disk record of what completed, and undo restores
 *    the exact prior label sets from it.
 *  - Settled runs and undos append verifiable local-stub receipts
 *    (the jobs.ts pattern) bound to the manifest by hash.
 *  - The credential status probe reports present / malformed /
 *    refused / healthy without ever printing a secret value.
 *
 * Everything runs against the pack's MockGmailTransport behind a
 * call recorder, plus fake HTTP for the OAuth exchange — no
 * network, no real mailbox.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GmailDirectory,
  MockGmailTransport,
  gmailCredentialHealth,
  runGmailAdmin,
  GMAIL_OAUTH_SECRET,
  type GmailHttpFetch,
  type GmailMessage,
  type GmailOutgoing,
  type GmailShieldScanner,
  type GmailTransport,
} from "../../packages/control-plane/src/gmail.js";
import {
  GmailCleanupEngine,
  GmailCleanupManifestStore,
  loadCleanupRules,
  runGmailCleanupAdmin,
  effectiveCleanupCap,
  GMAIL_CLEANUP_HARD_CAP,
  type CleanupReceiptSink,
  type GmailCleanupRuleFile,
} from "../../packages/control-plane/src/gmail-cleanup.js";
import { LocalReceiptIssuer, sha256Hex, type Receipt } from "../../packages/gate/src/receipts.js";
import { VaultBroker } from "../../packages/vault/src/index.js";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(NOW - n * DAY).toUTCString();

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-cleanup-"));
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

function engineFor(
  transport: GmailTransport,
  opts?: { directory?: GmailDirectory; shield?: GmailShieldScanner; batchId?: string },
): GmailCleanupEngine {
  let n = 0;
  return new GmailCleanupEngine(transport, {
    directory: opts?.directory ?? directoryWith([]),
    shield: opts?.shield,
    now: () => NOW,
    batchId: opts?.batchId ? () => opts.batchId! : () => `batch-${++n}`,
  });
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

/** Records every call the engine (or CLI) makes through the full
 *  GmailTransport surface, so tests can prove what did NOT happen. */
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
  modifies(): { id: string; add: string[]; remove: string[] }[] {
    return this.calls
      .filter((c) => c.method === "modify")
      .map((c) => ({ id: c.args[0] as string, add: c.args[1] as string[], remove: c.args[2] as string[] }));
  }
}

async function labelsOf(t: GmailTransport, id: string): Promise<string[]> {
  const m = await t.get(id);
  assert.ok(m, `message ${id} exists`);
  return [...m.labelIds].sort();
}

// ------------------------------------------------------------ rule loading

test("rules: a missing rule file loads the empty default — cap 200, no rules, nothing selectable", () => {
  const { rules: loaded, existed } = loadCleanupRules(join(freshDir(), "nope.json"));
  assert.equal(existed, false);
  assert.equal(loaded.rules.length, 0);
  assert.equal(effectiveCleanupCap(loaded), GMAIL_CLEANUP_HARD_CAP);
});

test("rules: malformed JSON, a bad cap, and a catch-all rule all fail closed", () => {
  const dir = freshDir();
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json");
  assert.throws(() => loadCleanupRules(bad), /not valid JSON/);
  const cap = join(dir, "cap.json");
  writeFileSync(cap, JSON.stringify({ nightlyCap: 0, rules: [] }));
  assert.throws(() => loadCleanupRules(cap), /nightlyCap/);
  const catchAll = join(dir, "catchall.json");
  writeFileSync(catchAll, JSON.stringify({ rules: [{ name: "everything" }] }));
  assert.throws(() => loadCleanupRules(catchAll), /no criterion/);
  const dup = join(dir, "dup.json");
  writeFileSync(dup, JSON.stringify({ rules: [{ name: "x", fromDomain: ["a.com"] }, { name: "x", fromDomain: ["b.com"] }] }));
  assert.throws(() => loadCleanupRules(dup), /duplicate rule name/);
});

// --------------------------------------------------------------- selection

test("select: sender, domain, label, and age rules match on metadata; counts are by rule", async () => {
  const mock = new MockGmailTransport([
    msg({ id: "a", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: daysAgo(45) }),
    msg({ id: "b", from: "team@corp.example", date: daysAgo(90) }),
    msg({ id: "c", from: "digest@news.example", date: daysAgo(10) }),
    msg({ id: "d", from: "deals@shop.example", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], date: daysAgo(5) }),
    msg({ id: "e", from: "team@corp.example", labelIds: ["SENT"], date: daysAgo(90) }),
  ]);
  const engine = engineFor(mock);
  const plan = await engine.select(
    rules({
      rules: [
        { name: "promos>30d", labelIds: ["CATEGORY_PROMOTIONS"], olderThanDays: 30 },
        { name: "corp mail", fromDomain: ["corp.example"] },
        { name: "the digest", from: ["digest@news.example"] },
      ],
    }),
    "hash",
  );
  assert.deepEqual(plan.entries.map((e) => e.id).sort(), ["a", "b", "c"]);
  assert.deepEqual(plan.byRule, { "promos>30d": 1, "corp mail": 1, "the digest": 1 });
  assert.equal(plan.scanned, 4); // the SENT message is not in the inbox scan
  assert.equal(plan.noRule, 1); // d: promos but only 5 days old
});

test("select: unread mail is skipped by default; a readOnly:false rule takes old unread", async () => {
  const mock = new MockGmailTransport([
    msg({ id: "u1", from: "news@example.com", labelIds: ["INBOX", "UNREAD"], date: daysAgo(60) }),
  ]);
  const engine = engineFor(mock);
  const strict = await engine.select(rules({ rules: [{ name: "news", fromDomain: ["example.com"] }] }), "h");
  assert.equal(strict.entries.length, 0);
  const lax = await engine.select(rules({ rules: [{ name: "news", fromDomain: ["example.com"], readOnly: false }] }), "h");
  assert.deepEqual(lax.entries.map((e) => e.id), ["u1"]);
});

test("exclusions: starred and IMPORTANT messages are never selected", async () => {
  const mock = new MockGmailTransport([
    msg({ id: "s", labelIds: ["INBOX", "STARRED"] }),
    msg({ id: "i", labelIds: ["INBOX", "IMPORTANT"] }),
    msg({ id: "ok" }),
  ]);
  const plan = await engineFor(mock).select(rules({ rules: [{ name: "news", fromDomain: ["example.com"] }] }), "h");
  assert.deepEqual(plan.entries.map((e) => e.id), ["ok"]);
  assert.equal(plan.excluded.starred, 1);
  assert.equal(plan.excluded.important, 1);
});

test("exclusions: unread younger than 7 days is never selected, even for readOnly:false rules", async () => {
  const mock = new MockGmailTransport([
    msg({ id: "young", labelIds: ["INBOX", "UNREAD"], date: daysAgo(3) }),
    msg({ id: "old", labelIds: ["INBOX", "UNREAD"], date: daysAgo(30) }),
  ]);
  const plan = await engineFor(mock).select(
    rules({ rules: [{ name: "news", fromDomain: ["example.com"], readOnly: false }] }),
    "h",
  );
  assert.deepEqual(plan.entries.map((e) => e.id), ["old"]);
  assert.equal(plan.excluded["unread-recent"], 1);
});

test("exclusions: never-archive senders win by exact address and by domain", async () => {
  const mock = new MockGmailTransport([
    msg({ id: "boss", from: "boss@corp.example" }),
    msg({ id: "hr", from: "hr@corp.example" }),
    msg({ id: "other", from: "news@other.example" }),
  ]);
  const plan = await engineFor(mock).select(
    rules({
      neverArchiveSenders: ["boss@corp.example", "corp.example"],
      rules: [{ name: "all mail", olderThanDays: 30 }],
    }),
    "h",
  );
  assert.deepEqual(plan.entries.map((e) => e.id), ["other"]);
  assert.equal(plan.excluded["never-sender"], 2);
});

test("exclusions: known correspondents are skipped unless the rule names the sender exactly", async () => {
  const directory = directoryWith(["pal@example.com"]);
  const mock = new MockGmailTransport([msg({ id: "p", from: "pal@example.com" })]);
  const engine = engineFor(mock, { directory });
  const byDomain = await engine.select(rules({ rules: [{ name: "domain", fromDomain: ["example.com"] }] }), "h");
  assert.equal(byDomain.entries.length, 0);
  assert.equal(byDomain.excluded["known-correspondent"], 1);
  const byName = await engine.select(rules({ rules: [{ name: "named", from: ["pal@example.com"] }] }), "h");
  assert.deepEqual(byName.entries.map((e) => e.id), ["p"]);
});

test("select: a message matching no rule is invisible to the plan", async () => {
  const mock = new MockGmailTransport([msg({ id: "x", from: "random@elsewhere.example" })]);
  const plan = await engineFor(mock).select(rules({ rules: [{ name: "news", fromDomain: ["example.com"] }] }), "h");
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.noRule, 1);
});

test("cap: selection stops at the effective cap and counts the overflow", async () => {
  const seed = Array.from({ length: 5 }, (_, i) => msg({ id: `m${i}`, date: daysAgo(90 - i) }));
  const plan = await engineFor(new MockGmailTransport(seed)).select(
    rules({ nightlyCap: 3, rules: [{ name: "news", fromDomain: ["example.com"] }] }),
    "h",
  );
  assert.equal(plan.entries.length, 3);
  assert.equal(plan.overCap, 2);
  // Oldest first: the cap keeps the newest overflow for another night.
  assert.deepEqual(plan.entries.map((e) => e.id), ["m0", "m1", "m2"]);
});

test("cap: the code hard cap of 200 binds even when the rule file asks for more", async () => {
  const seed = Array.from({ length: 250 }, (_, i) => msg({ id: `m${i}` }));
  const plan = await engineFor(new MockGmailTransport(seed)).select(
    rules({ nightlyCap: 5000, rules: [{ name: "news", fromDomain: ["example.com"] }] }),
    "h",
  );
  assert.equal(effectiveCleanupCap(rules({ nightlyCap: 5000 })), 200);
  assert.equal(plan.entries.length, 200);
  assert.equal(plan.overCap, 50);
});

test("dry-run changes nothing: selection's only transport call is search and the mailbox is untouched", async () => {
  const mock = new MockGmailTransport([msg({ id: "a" }), msg({ id: "b", labelIds: ["INBOX", "STARRED"] })]);
  const rec = new RecordingTransport(mock);
  const before = { a: await labelsOf(mock, "a"), b: await labelsOf(mock, "b") };
  const plan = await engineFor(rec).select(rules({ rules: [{ name: "news", fromDomain: ["example.com"] }] }), "h");
  assert.equal(plan.entries.length, 1);
  assert.deepEqual(rec.methods(), ["search"]);
  assert.deepEqual({ a: await labelsOf(mock, "a"), b: await labelsOf(mock, "b") }, before);
});

test("shield: a message whose snippet the gate blocks is withheld from selection and counted", async () => {
  const shield: GmailShieldScanner = {
    async scanSurface(_surface, _jobId, content) {
      return content.includes("evil")
        ? { action: "block", scanned: true, detail: "injection pattern" }
        : { action: "allow", scanned: true, detail: "" };
    },
  };
  const mock = new MockGmailTransport([
    msg({ id: "good" }),
    msg({ id: "bad", snippet: "an evil snippet" }),
  ]);
  const plan = await engineFor(mock, { shield }).select(
    rules({ rules: [{ name: "news", fromDomain: ["example.com"] }] }),
    "h",
  );
  assert.deepEqual(plan.entries.map((e) => e.id), ["good"]);
  assert.equal(plan.withheld, 1);
});

// ----------------------------------------------------------------- archive

test("archive: refuses without a dry-run manifest, on a changed rule file, and on a second run", async () => {
  const dir = freshDir();
  const store = storeIn(dir);
  const mock = new MockGmailTransport([msg({ id: "a" })]);
  const rec = new RecordingTransport(mock);
  const engine = engineFor(rec, { batchId: "batch-x" });
  const ruleFile = rules({ rules: [{ name: "news", fromDomain: ["example.com"] }] });

  await assert.rejects(() => engine.archive("batch-x", store, { rules: ruleFile, hash: "h1" }), /no dry-run manifest/);

  const plan = await engine.select(ruleFile, "h1");
  store.saveDryRun(plan);
  await assert.rejects(() => engine.archive("batch-x", store, { rules: ruleFile, hash: "h2" }), /rule file changed/);
  assert.equal(rec.modifies().length, 0);

  const run = await engine.archive("batch-x", store, { rules: ruleFile, hash: "h1" });
  assert.equal(run.status, "verified-done");
  await assert.rejects(() => engine.archive("batch-x", store, { rules: ruleFile, hash: "h1" }), /already been executed/);
  assert.equal(rec.modifies().length, 1);
});

test("archive: a manifest over the cap is refused and nothing is modified", async () => {
  const dir = freshDir();
  const store = storeIn(dir);
  const mock = new MockGmailTransport([msg({ id: "a" }), msg({ id: "b" }), msg({ id: "c" })]);
  const rec = new RecordingTransport(mock);
  const engine = engineFor(rec, { batchId: "batch-big" });
  // A forged/foreign manifest: three entries under a cap of two.
  store.saveDryRun({
    batchId: "batch-big",
    createdAt: NOW,
    ruleFileHash: "h",
    cap: 2,
    entries: ["a", "b", "c"].map((id) => ({
      id, threadId: `thread-${id}`, from: "news@example.com", subject: "s", date: daysAgo(60),
      priorLabelIds: ["INBOX"], rule: "news",
    })),
    byRule: { news: 3 },
    scanned: 3,
    noRule: 0,
    excluded: { starred: 0, important: 0, "unread-recent": 0, "never-sender": 0, "known-correspondent": 0 },
    withheld: 0,
    overCap: 0,
    shieldUnscanned: true,
  });
  const ruleFile = rules({ nightlyCap: 2, rules: [{ name: "news", fromDomain: ["example.com"] }] });
  await assert.rejects(() => engine.archive("batch-big", store, { rules: ruleFile, hash: "h" }), /over the nightly cap/);
  assert.equal(rec.modifies().length, 0);
});

test("archive: executes the manifest — INBOX removed, other labels kept, manifest settled", async () => {
  const dir = freshDir();
  const store = storeIn(dir);
  const mock = new MockGmailTransport([
    msg({ id: "a", labelIds: ["INBOX", "Receipts"] }),
    msg({ id: "b" }),
  ]);
  const engine = engineFor(mock, { batchId: "batch-run" });
  const ruleFile = rules({ rules: [{ name: "news", fromDomain: ["example.com"] }] });
  store.saveDryRun(await engine.select(ruleFile, "h"));
  const run = await engine.archive("batch-run", store, { rules: ruleFile, hash: "h" });
  assert.equal(run.status, "verified-done");
  assert.deepEqual(run.entries.map((e) => e.state), ["done", "done"]);
  assert.deepEqual(await labelsOf(mock, "a"), ["Receipts"]);
  assert.deepEqual(await labelsOf(mock, "b"), []);
  const onDisk = store.loadRun("batch-run");
  assert.ok(onDisk);
  assert.equal(onDisk.status, "verified-done");
  // The manifest's prior set for a is the full pre-archive set.
  assert.deepEqual([...onDisk.entries[0].priorLabelIds].sort(), ["INBOX", "Receipts"]);
});

test("archive: exclusions are re-checked on fresh metadata — a message starred after the dry run is left alone", async () => {
  const dir = freshDir();
  const store = storeIn(dir);
  const mock = new MockGmailTransport([msg({ id: "a" }), msg({ id: "b" })]);
  const engine = engineFor(mock, { batchId: "batch-stale" });
  const ruleFile = rules({ rules: [{ name: "news", fromDomain: ["example.com"] }] });
  store.saveDryRun(await engine.select(ruleFile, "h"));
  await mock.modify("a", ["STARRED"], []); // the operator stars it that evening
  const run = await engine.archive("batch-stale", store, { rules: ruleFile, hash: "h" });
  assert.equal(run.entries.find((e) => e.id === "a")?.state, "skipped-stale");
  assert.equal(run.entries.find((e) => e.id === "b")?.state, "done");
  assert.deepEqual(await labelsOf(mock, "a"), ["INBOX", "STARRED"]);
});

/** A mock whose second modify explodes — the mid-run failure
 *  vehicle for the write-ahead test. */
class FlakyMock extends MockGmailTransport {
  private modifyCount = 0;
  override async modify(id: string, add: string[], remove: string[]): Promise<void> {
    this.modifyCount++;
    if (this.modifyCount === 2) throw new Error("transport exploded");
    return super.modify(id, add, remove);
  }
}

test("archive: write-ahead — a mid-run transport failure leaves a manifest showing exactly what completed", async () => {
  const dir = freshDir();
  const store = storeIn(dir);
  const mock = new FlakyMock([msg({ id: "a" }), msg({ id: "b" })]);
  const engine = engineFor(mock, { batchId: "batch-flaky" });
  const ruleFile = rules({ rules: [{ name: "news", fromDomain: ["example.com"] }] });
  store.saveDryRun(await engine.select(ruleFile, "h"));
  const run = await engine.archive("batch-flaky", store, { rules: ruleFile, hash: "h" });
  assert.equal(run.status, "failed-loudly");
  const onDisk = store.loadRun("batch-flaky");
  assert.ok(onDisk, "the write-ahead manifest is on disk despite the failure");
  assert.equal(onDisk.entries.find((e) => e.id === "a")?.state, "done");
  assert.equal(onDisk.entries.find((e) => e.id === "b")?.state, "failed");
  // And undo still covers exactly the completed entry.
  const undone = await engine.undo("batch-flaky", store);
  assert.equal(undone.status, "undone");
  assert.deepEqual(await labelsOf(mock, "a"), ["INBOX"]);
  assert.deepEqual(await labelsOf(mock, "b"), ["INBOX"]);
});

// -------------------------------------------------------------------- undo

test("undo: restores the exact prior label set, not just INBOX", async () => {
  const dir = freshDir();
  const store = storeIn(dir);
  const mock = new MockGmailTransport([msg({ id: "a", labelIds: ["INBOX", "Receipts", "Finance"] })]);
  const engine = engineFor(mock, { batchId: "batch-undo" });
  const ruleFile = rules({ rules: [{ name: "news", fromDomain: ["example.com"] }] });
  store.saveDryRun(await engine.select(ruleFile, "h"));
  await engine.archive("batch-undo", store, { rules: ruleFile, hash: "h" });
  assert.deepEqual(await labelsOf(mock, "a"), ["Finance", "Receipts"]);
  // Life goes on: a filter adds a label while the message sits archived.
  await mock.modify("a", ["Later"], []);
  const run = await engine.undo("batch-undo", store);
  assert.equal(run.status, "undone");
  assert.deepEqual(await labelsOf(mock, "a"), ["Finance", "INBOX", "Receipts"]);
});

test("undo: refuses an unknown batch and a second undo", async () => {
  const dir = freshDir();
  const store = storeIn(dir);
  const mock = new MockGmailTransport([msg({ id: "a" })]);
  const engine = engineFor(mock, { batchId: "batch-u2" });
  await assert.rejects(() => engine.undo("nope", store), /no run manifest/);
  const ruleFile = rules({ rules: [{ name: "news", fromDomain: ["example.com"] }] });
  store.saveDryRun(await engine.select(ruleFile, "h"));
  await engine.archive("batch-u2", store, { rules: ruleFile, hash: "h" });
  await engine.undo("batch-u2", store);
  await assert.rejects(() => engine.undo("batch-u2", store), /already undone/);
});

test("narrowed transport: select + archive + undo only ever call search/get/modify, and archive's only delta is -INBOX", async () => {
  const dir = freshDir();
  const store = storeIn(dir);
  const mock = new MockGmailTransport([msg({ id: "a", labelIds: ["INBOX", "Receipts"] }), msg({ id: "b" })]);
  const rec = new RecordingTransport(mock);
  const engine = engineFor(rec, { batchId: "batch-narrow" });
  const ruleFile = rules({ rules: [{ name: "news", fromDomain: ["example.com"] }] });
  store.saveDryRun(await engine.select(ruleFile, "h"));
  const before = rec.calls.length;
  await engine.archive("batch-narrow", store, { rules: ruleFile, hash: "h" });
  const archiveModifies = rec.calls.slice(before).filter((c) => c.method === "modify");
  assert.ok(archiveModifies.length > 0);
  for (const c of archiveModifies) {
    assert.deepEqual(c.args[1], [], "archive adds no labels");
    assert.deepEqual(c.args[2], ["INBOX"], "archive removes exactly INBOX");
  }
  await engine.undo("batch-narrow", store);
  assert.deepEqual(rec.methods().sort(), ["get", "modify", "search"]);
  for (const forbidden of ["trash", "deleteForever", "send", "createDraft", "createBlockFilter"]) {
    assert.equal(rec.calls.filter((c) => c.method === forbidden).length, 0, `${forbidden} was never called`);
  }
  for (const m of rec.modifies()) {
    assert.ok(!m.add.includes("TRASH") && !m.remove.includes("TRASH"), "no modify ever touches TRASH");
  }
});

test("receipts: archive and undo append verifiable local-stub receipts bound to the manifest", async () => {
  const dir = freshDir();
  const store = storeIn(dir);
  const sink = receiptSinkIn(dir);
  const mock = new MockGmailTransport([msg({ id: "a" })]);
  const engine = engineFor(mock, { batchId: "batch-rcpt" });
  const ruleFile = rules({ rules: [{ name: "news", fromDomain: ["example.com"] }] });
  store.saveDryRun(await engine.select(ruleFile, "h"));
  const run = await engine.archive("batch-rcpt", store, { rules: ruleFile, hash: "h" }, sink);
  assert.ok(run.receiptId);
  const undone = await engine.undo("batch-rcpt", store, sink);
  assert.ok(undone.undoReceiptId);

  const lines = readFileSync(sink.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Receipt);
  assert.equal(lines.length, 2);
  const [archiveReceipt, undoReceipt] = lines;
  assert.equal(archiveReceipt.receiptId, run.receiptId);
  assert.equal(archiveReceipt.jobId, "gmail-cleanup-batch-rcpt");
  assert.equal(archiveReceipt.kind, "gus-local-stub"); // honest: not a Shield Protocol receipt
  assert.ok(sink.issuer.verify(archiveReceipt));
  // The receipt's content hash is bound to the manifest's contents.
  assert.equal(
    archiveReceipt.contentHash,
    sha256Hex(
      JSON.stringify({
        batchId: run.batchId,
        jobId: run.jobId,
        ruleFileHash: run.ruleFileHash,
        entries: run.entries.map((e) => ({ id: e.id, rule: e.rule, state: e.state })),
      }),
    ),
  );
  assert.equal(undoReceipt.receiptId, undone.undoReceiptId);
  assert.equal(undoReceipt.jobId, "gmail-cleanup-undo-batch-rcpt");
  assert.ok(sink.issuer.verify(undoReceipt));
});

// ------------------------------------------------------- status + CLI

const SECRET_VALUE = "REFRESH-SECRET-VALUE-9f8e7d6c";

function vaultWith(secret?: string): VaultBroker {
  const dir = freshDir();
  const vault = new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key"));
  if (secret !== undefined) vault.add(GMAIL_OAUTH_SECRET, secret);
  return vault;
}

function fakeHttp(status: number, body: unknown): GmailHttpFetch {
  return async () => ({ status, json: async () => body });
}

test("status: credential health — not configured, malformed, refused, healthy — and never leaks the secret", async () => {
  const none = await gmailCredentialHealth(vaultWith(undefined));
  assert.equal(none.configured, false);
  assert.equal(none.healthy, false);

  const malformed = await gmailCredentialHealth(vaultWith("not json at all"));
  assert.equal(malformed.configured, true);
  assert.equal(malformed.shapeOk, false);
  assert.equal(malformed.healthy, false);

  const goodJson = JSON.stringify({ client_id: "cid", client_secret: "csecret", refresh_token: SECRET_VALUE });
  const refused = await gmailCredentialHealth(vaultWith(goodJson), fakeHttp(400, { error: "invalid_grant" }));
  assert.equal(refused.shapeOk, true);
  assert.equal(refused.healthy, false);
  assert.ok(!refused.detail.includes(SECRET_VALUE), "the refusal detail never contains the credential value");
  assert.ok(!refused.detail.includes("csecret"), "nor the client secret");

  const healthy = await gmailCredentialHealth(vaultWith(goodJson), fakeHttp(200, { access_token: "tok", expires_in: 3600 }));
  assert.equal(healthy.healthy, true);

  // And through the operator surface: gmail-admin status prints the
  // health line, still without any secret material.
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    const code = await runGmailAdmin(["status"], vaultWith(goodJson), directoryWith([]), fakeHttp(200, { access_token: "tok", expires_in: 3600 }));
    assert.equal(code, 0);
  } finally {
    console.log = orig;
  }
  const out = logs.join("\n");
  assert.match(out, /OAuth health: OK/);
  assert.ok(!out.includes(SECRET_VALUE));
});

test("cli: dry-run prints 'would archive N, by rule', writes the manifest, changes nothing; archive + undo round-trip", async () => {
  const stateDir = freshDir();
  writeFileSync(
    join(stateDir, "gmail-cleanup-rules.json"),
    JSON.stringify({ version: 1, nightlyCap: 200, neverArchiveSenders: [], rules: [{ name: "news", fromDomain: ["example.com"] }] }),
  );
  const mock = new MockGmailTransport([
    msg({ id: "a", labelIds: ["INBOX", "Receipts"] }),
    msg({ id: "b" }),
    msg({ id: "c", from: "human@elsewhere.example" }),
  ]);
  const deps = {
    vault: vaultWith(undefined),
    directory: directoryWith([]),
    stateDir,
    transport: mock,
    now: () => NOW,
  };
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    assert.equal(await runGmailCleanupAdmin(["dry-run"], deps), 0);
    const out = logs.join("\n");
    assert.match(out, /would archive 2, by rule:/);
    assert.match(out, /news — 2/);
    assert.match(out, /nothing was changed in the mailbox/);
    assert.deepEqual(await labelsOf(mock, "a"), ["INBOX", "Receipts"]); // untouched

    const storeDir = join(stateDir, "gmail-cleanup");
    const dryFile = readdirSync(storeDir).find((f) => f.startsWith("dry-"));
    assert.ok(dryFile, "the dry-run manifest is in the store");
    const batchId = dryFile.replace(/^dry-/, "").replace(/\.json$/, "");
    assert.ok(existsSync(join(storeDir, `${batchId}.json`)) === false);

    logs.length = 0;
    assert.equal(await runGmailCleanupAdmin(["archive", "--batch", batchId], deps), 0);
    assert.match(logs.join("\n"), /verified-done/);
    assert.deepEqual(await labelsOf(mock, "a"), ["Receipts"]);
    assert.deepEqual(await labelsOf(mock, "b"), []);

    logs.length = 0;
    assert.equal(await runGmailCleanupAdmin(["undo", "--batch", batchId], deps), 0);
    assert.match(logs.join("\n"), /undone/);
    assert.deepEqual(await labelsOf(mock, "a"), ["INBOX", "Receipts"]);
    assert.deepEqual(await labelsOf(mock, "b"), ["INBOX"]);
    assert.deepEqual(await labelsOf(mock, "c"), ["INBOX"]); // never selected, never touched
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});
