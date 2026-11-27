/**
 * v0.24.0: the Gmail cleanup proposals store, hardened.
 *
 * Two failure modes motivated this file:
 *  - save() wrote the proposals file in place, so a crash
 *    mid-write left a torn file — and the old load() then threw
 *    on it forever, wedging every cycle that touches the store
 *    (generation runs inside the scheduler; the morning report
 *    depends on this state).
 *  - The fix: saves are atomic (temp file + rename, the
 *    scheduler-config pattern), and loads RECOVER — a corrupt
 *    file is quarantined aside (never deleted: it is the audit
 *    trail) and the store starts clean instead of crashing.
 *
 * These tests pin both halves: a torn write can no longer be
 * produced by save(), and a corrupt file — however it got that
 * way — loads as the empty set with the evidence preserved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GmailCleanupProposalStore,
  cleanupProposalsPath,
  type GmailCleanupProposalsFile,
} from "../../packages/control-plane/src/gmail-cleanup-proposals.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-proposals-store-"));
}

function sampleFile(sender = "deals@shop.example"): GmailCleanupProposalsFile {
  return {
    version: 1,
    proposals: [
      {
        id: "prop-abc123",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        status: "pending",
        rule: { name: `proposed: ${sender}`, from: [sender] },
        evidence: {
          sender,
          count: 5,
          bulkCount: 4,
          sampleSubjects: ["Sale ends soon"],
          oldestDate: "Mon, 1 Jan 2024 00:00:00 +0000",
          newestDate: "Fri, 5 Jan 2024 00:00:00 +0000",
        },
      },
    ],
  };
}

test("proposals store: save → load round-trips, the file is 0600, and no temp file remains", () => {
  const dir = freshDir();
  const path = cleanupProposalsPath(dir);
  const store = new GmailCleanupProposalStore(path);
  store.save(sampleFile());
  assert.deepEqual(store.load(), sampleFile());
  assert.equal(statSync(path).mode & 0o777, 0o600, "the proposals file stays operator-only");
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
    "the temp file was renamed away, not left behind",
  );
});

test("proposals store: a second save fully replaces the first — no torn tail survives", () => {
  const dir = freshDir();
  const path = cleanupProposalsPath(dir);
  const store = new GmailCleanupProposalStore(path);
  store.save(sampleFile("a-much-longer-sender-name@some-bulk-mailer.example"));
  store.save({ version: 1, proposals: [] });
  assert.equal(
    readFileSync(path, "utf8"),
    JSON.stringify({ version: 1, proposals: [] }, null, 2) + "\n",
    "the file is exactly the second save — rename replaced it wholesale",
  );
  assert.deepEqual(store.load(), { version: 1, proposals: [] });
});

test("proposals store: a missing file loads as the empty set", () => {
  const dir = freshDir();
  const store = new GmailCleanupProposalStore(cleanupProposalsPath(dir));
  assert.deepEqual(store.load(), { version: 1, proposals: [] });
  assert.deepEqual(store.pending(), []);
});

test("proposals store: corrupt JSON loads as the empty set and quarantines the bad file aside", () => {
  const dir = freshDir();
  const path = cleanupProposalsPath(dir);
  const torn = '{"version":1,"proposals":[{"id":"prop-abc123","createdAt":1700';
  writeFileSync(path, torn, { mode: 0o600 });
  const store = new GmailCleanupProposalStore(path);
  assert.deepEqual(store.load(), { version: 1, proposals: [] }, "no throw — the store starts clean");
  assert.equal(existsSync(path), false, "the corrupt file moved aside");
  const quarantined = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
  assert.equal(quarantined.length, 1, "exactly one quarantine file");
  assert.equal(
    readFileSync(join(dir, quarantined[0]!), "utf8"),
    torn,
    "the corrupt bytes are preserved verbatim for the operator to inspect",
  );
});

test("proposals store: structurally malformed files recover the same way", () => {
  const dir = freshDir();
  const path = cleanupProposalsPath(dir);
  const store = new GmailCleanupProposalStore(path);

  writeFileSync(path, JSON.stringify({ version: 1, proposals: "not-a-list" }), { mode: 0o600 });
  assert.deepEqual(store.load(), { version: 1, proposals: [] }, "no proposals list → clean start");

  writeFileSync(path, JSON.stringify({ version: 1, proposals: [{ id: 42 }] }), { mode: 0o600 });
  assert.deepEqual(store.load(), { version: 1, proposals: [] }, "a malformed record → clean start");

  assert.equal(
    readdirSync(dir).filter((f) => f.includes(".corrupt-")).length,
    2,
    "both bad files were quarantined, neither was deleted",
  );
});

test("proposals store: after recovery the store is fully usable again", () => {
  const dir = freshDir();
  const path = cleanupProposalsPath(dir);
  writeFileSync(path, "this is not json at all", { mode: 0o600 });
  const store = new GmailCleanupProposalStore(path);
  assert.deepEqual(store.load(), { version: 1, proposals: [] });
  store.save(sampleFile());
  assert.deepEqual(store.load(), sampleFile(), "save + load work on the recovered store");
  assert.equal(store.pending().length, 1);
});
