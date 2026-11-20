/**
 * Memory Write Service — Memory Slice B (v0.13.0), the write loop
 * over the MemoryStore contract:
 *
 *  - A proposal lands as a "proposed" candidate line (Slice A's
 *    pinned vocabulary) and shows up pending; nothing touches a
 *    core file until the operator promotes.
 *  - A secret-shaped proposal or remember is REFUSED — pattern
 *    classes named, nothing appended anywhere. The guard's refusal
 *    is the whole behavior: no silent redaction, no stored secret.
 *  - Promotion appends a dated "[candidate <id>]" bullet to the
 *    category's default file (preference → OPERATOR.md, else
 *    MEMORY.md), the operator's edited wording wins over the
 *    proposal, and the decision is a new status line (latest wins,
 *    pending count drops).
 *  - Reject is a status line too; decided candidates cannot be
 *    decided again.
 *  - Forget is count-bound: apply with a stale count refuses and
 *    removes nothing; apply with the reviewed count removes exactly
 *    those lines, archives them, events hashes (never content), and
 *    turns a matching pending candidate into a rejection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextPackStore } from "../../packages/control-plane/src/context-pack.js";
import { MemoryWriteService } from "../../packages/control-plane/src/memory-write.js";

// The synthetic AWS key from secret-guard.test.ts — AKIA + 16,
// refused as "aws_key", never a real credential.
const AWS_KEY_TEXT = "my key is AKIAGUSTEST123456789 keep it safe";

function tmpState(): {
  dir: string;
  store: ContextPackStore;
  service: MemoryWriteService;
} {
  const dir = mkdtempSync(join(tmpdir(), "gus-memory-write-"));
  const store = new ContextPackStore(dir);
  store.ensureSeeded();
  return { dir, store, service: new MemoryWriteService(store) };
}

function readCtx(store: ContextPackStore, name: string): string {
  return readFileSync(join(store.contextDir, name), "utf8");
}

function writeCtx(store: ContextPackStore, name: string, content: string): void {
  writeFileSync(join(store.contextDir, name), content, "utf8");
}

function candidateLines(store: ContextPackStore): Record<string, unknown>[] {
  return readCtx(store, "candidates.jsonl")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ------------------------------------------------------------ propose

test("propose: a clean proposal is stored as one proposed candidate line", () => {
  const { store, service } = tmpState();
  const res = service.propose({
    origin: "operator",
    category: "fact",
    text: "The operator drinks tea in the morning.",
    source: "panel chat",
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.candidate.status, "proposed");
  assert.equal(res.candidate.category, "fact");
  assert.equal(res.candidate.text, "The operator drinks tea in the morning.");
  assert.match(res.candidate.id, /^mem_/);

  const lines = candidateLines(store);
  assert.equal(lines.length, 1, "exactly one line was appended");
  assert.equal(lines[0]?.status, "proposed");
  assert.equal(lines[0]?.id, res.candidate.id);

  const pending = service.pendingCandidates();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.id, res.candidate.id);
  assert.equal(service.listCandidates().length, 1);
  assert.equal(store.pendingCandidateCount(), 1);
  assert.ok(
    readCtx(store, "context-events.jsonl").includes('"candidate_proposed"'),
    "the proposal is evented",
  );
  // A proposal alone never touches a core file.
  assert.ok(!readCtx(store, "MEMORY.md").includes("tea in the morning"));
});

test("propose: a secret-shaped proposal is refused and nothing is appended", () => {
  const { store, service } = tmpState();
  const before = readCtx(store, "candidates.jsonl");
  const res = service.propose({ origin: "agent-self", text: AWS_KEY_TEXT });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.ok(res.detail.includes("aws_key"), "the refusal names the pattern class");
  assert.ok(!res.detail.includes("AKIAGUSTEST123456789"), "the refusal never carries the secret");
  assert.equal(readCtx(store, "candidates.jsonl"), before, "no candidate line was appended");
  assert.equal(service.pendingCandidates().length, 0);
  assert.equal(store.pendingCandidateCount(), 0);
});

test("propose: empty text is refused; an unknown category coerces to fact", () => {
  const { service } = tmpState();
  assert.equal(service.propose({ origin: "operator", text: "   " }).ok, false);
  const res = service.propose({
    origin: "operator",
    category: "not-a-category",
    text: "A fact with a foreign category label.",
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.candidate.category, "fact");
});

// ------------------------------------------------------------ promote

test("promote: the bullet lands in MEMORY.md, the status line lands, pending drops", () => {
  const { store, service } = tmpState();
  const proposed = service.propose({
    origin: "agent-self",
    category: "fact",
    text: "The workshop is in the garage.",
  });
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  const id = proposed.candidate.id;

  const res = service.promote(id);
  assert.equal(res.ok, true);
  assert.equal(res.identityCategory, undefined, "a fact is not flagged as identity");

  const memory = readCtx(store, "MEMORY.md");
  assert.ok(memory.includes(`[candidate ${id}] The workshop is in the garage.`));
  assert.match(memory, /\d{4}-\d{2}-\d{2} \[candidate /, "the bullet is dated");

  const lines = candidateLines(store);
  assert.equal(lines.length, 2, "promotion is a second line, not an edit");
  assert.equal(lines[1]?.status, "promoted");
  assert.equal(lines[1]?.promotedTo, "MEMORY.md");
  assert.equal(lines[1]?.decidedBy, "operator");

  const resolved = service.listCandidates().find((c) => c.id === id);
  assert.equal(resolved?.status, "promoted", "latest line wins in the resolved view");
  assert.equal(service.pendingCandidates().length, 0);
  assert.equal(store.pendingCandidateCount(), 0, "the store's pending count drops too");
  assert.ok(readCtx(store, "context-events.jsonl").includes('"candidate_promoted"'));
});

test("promote: a preference candidate defaults to OPERATOR.md", () => {
  const { store, service } = tmpState();
  const proposed = service.propose({
    origin: "operator",
    category: "preference",
    text: "Prefers morning meetings.",
  });
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  const res = service.promote(proposed.candidate.id);
  assert.equal(res.ok, true);
  assert.ok(readCtx(store, "OPERATOR.md").includes("Prefers morning meetings."));
  assert.ok(!readCtx(store, "MEMORY.md").includes("Prefers morning meetings."));
});

test("promote: the operator's edited text wins over the proposal", () => {
  const { store, service } = tmpState();
  const proposed = service.propose({
    origin: "agent-self",
    text: "draft wording from the agent",
  });
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  const res = service.promote(proposed.candidate.id, {
    text: "operator final wording",
  });
  assert.equal(res.ok, true);
  const memory = readCtx(store, "MEMORY.md");
  assert.ok(memory.includes("operator final wording"));
  assert.ok(!memory.includes("draft wording from the agent"));
});

test("promote: an identity candidate is flagged in the result but still promotes", () => {
  const { store, service } = tmpState();
  const proposed = service.propose({
    origin: "operator",
    category: "identity",
    text: "GUS also answers to Gus.",
  });
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  const res = service.promote(proposed.candidate.id, { targetFile: "IDENTITY.md" });
  assert.equal(res.ok, true);
  assert.equal(res.identityCategory, true, "the panel flag rides the result");
  assert.ok(readCtx(store, "IDENTITY.md").includes("GUS also answers to Gus."));
});

test("promote: unknown ids, decided candidates, bad targets, and secret edits all refuse", () => {
  const { service } = tmpState();
  assert.equal(service.promote("mem_missing").ok, false);
  const proposed = service.propose({ origin: "operator", text: "A one-time fact." });
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  const id = proposed.candidate.id;
  assert.equal(service.promote(id, { targetFile: "context.json" }).ok, false,
    "context.json is config, never a promotion target");
  assert.equal(service.promote(id, { text: AWS_KEY_TEXT }).ok, false,
    "an edited text is screened like every other write");
  assert.equal(service.pendingCandidates().length, 1, "the refusals decided nothing");
  assert.equal(service.promote(id).ok, true);
  assert.equal(service.promote(id).ok, false, "a promoted candidate cannot promote again");
});

// ------------------------------------------------------------ reject

test("reject: a status line decides the candidate; decided and unknown ids refuse", () => {
  const { store, service } = tmpState();
  const proposed = service.propose({ origin: "agent-self", text: "A doubtful claim." });
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  const id = proposed.candidate.id;
  const res = service.reject(id);
  assert.equal(res.ok, true);
  assert.equal(service.listCandidates().find((c) => c.id === id)?.status, "rejected");
  assert.equal(service.pendingCandidates().length, 0);
  assert.equal(store.pendingCandidateCount(), 0);
  assert.ok(readCtx(store, "context-events.jsonl").includes('"candidate_rejected"'));
  assert.equal(service.reject(id).ok, false, "already decided");
  assert.equal(service.reject("mem_missing").ok, false, "unknown id");
});

// ------------------------------------------------------------ remember

test("remember: a dated [operator] bullet lands in MEMORY.md", () => {
  const { store, service } = tmpState();
  const res = service.remember("The operator prefers tea in the morning.");
  assert.equal(res.ok, true);
  assert.equal(res.file, "MEMORY.md");
  const memory = readCtx(store, "MEMORY.md");
  assert.match(
    memory,
    /- \d{4}-\d{2}-\d{2} \[operator\] The operator prefers tea in the morning\./,
  );
  const events = readCtx(store, "context-events.jsonl");
  assert.ok(events.includes('"remembered"'), "the write is evented");
  assert.ok(!events.includes("prefers tea"), "the event carries a hash, never the content");
});

test("remember: a secret is refused and the file is byte-for-byte unchanged", () => {
  const { store, service } = tmpState();
  const before = readCtx(store, "MEMORY.md");
  const res = service.remember(AWS_KEY_TEXT);
  assert.equal(res.ok, false);
  assert.ok(res.detail.includes("aws_key"));
  assert.equal(readCtx(store, "MEMORY.md"), before, "nothing was appended or altered");
});

// ------------------------------------------------------------ forget

test("forget: search counts, a stale count refuses, the right count removes exactly the matches", () => {
  const { store, service } = tmpState();
  writeCtx(
    store,
    "MEMORY.md",
    "# Memory\n\n- The zebra fact one.\n- An unrelated fact.\n- Another ZEBRA note here.\n",
  );
  const { matches } = service.forgetSearch("zebra");
  assert.equal(matches.length, 2, "matching is case-insensitive, line by line");
  assert.ok(matches.every((m) => m.where === "file" && m.file === "MEMORY.md"));

  const stale = service.forgetApply("zebra", 1);
  assert.equal(stale.ok, false, "a count that no longer matches refuses");
  assert.match(stale.detail, /matches changed since you counted/);
  assert.ok(readCtx(store, "MEMORY.md").includes("zebra fact one"), "the refusal removed nothing");

  const applied = service.forgetApply("zebra", 2);
  assert.equal(applied.ok, true);
  assert.equal(applied.removed, 2);
  const after = readCtx(store, "MEMORY.md");
  assert.ok(after.includes("An unrelated fact."), "the non-matching line survives");
  assert.ok(!after.toLowerCase().includes("zebra"), "both matching lines are gone");
  assert.ok(after.startsWith("# Memory\n"), "the rest of the file is preserved");

  const archiveNames = readdirSync(join(store.contextDir, "archive")).filter((n) =>
    n.startsWith("forget-"),
  );
  assert.equal(archiveNames.length, 1, "the removed lines were archived");
  const archived = readFileSync(
    join(store.contextDir, "archive", archiveNames[0]!),
    "utf8",
  );
  assert.ok(archived.includes("The zebra fact one."));
  assert.ok(archived.includes("Another ZEBRA note here."));

  const forgottenLine = readCtx(store, "context-events.jsonl")
    .split("\n")
    .filter((l) => l.includes('"forgotten"'))
    .at(-1);
  assert.ok(forgottenLine, "one forgotten event was appended");
  const event = JSON.parse(forgottenLine!) as { count: number; hashes: string[] };
  assert.equal(event.count, 2);
  assert.equal(event.hashes.length, 2);
  assert.ok(event.hashes.every((h) => /^[0-9a-f]{64}$/.test(h)), "proof is hashes");
  assert.ok(!forgottenLine!.toLowerCase().includes("zebra"), "the event carries no content");
});

test("forget: a matching pending candidate becomes a rejection", () => {
  const { service } = tmpState();
  const proposed = service.propose({
    origin: "agent-self",
    text: "A quokka fact to forget.",
  });
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  const { matches } = service.forgetSearch("quokka");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.where, "candidate");
  assert.equal(matches[0]?.candidateId, proposed.candidate.id);

  const applied = service.forgetApply("quokka", 1);
  assert.equal(applied.ok, true);
  assert.equal(applied.removed, 1);
  const resolved = service.listCandidates().find((c) => c.id === proposed.candidate.id);
  assert.equal(resolved?.status, "rejected");
  assert.equal(resolved?.decidedBy, "operator-forget");
  assert.equal(service.pendingCandidates().length, 0);
});

test("forget: an empty query finds nothing and applying zero refuses", () => {
  const { service } = tmpState();
  assert.deepEqual(service.forgetSearch(""), { matches: [] });
  assert.deepEqual(service.forgetSearch("   "), { matches: [] });
  assert.equal(service.forgetApply("nothing-matches-this", 0).ok, false);
});

test("forget: daily notes are searched under their memory/ names", () => {
  const { store, service } = tmpState();
  writeCtx(store, "memory/2026-11-17.md", "# 2026-11-17\n- Walked the harbor trail.\n- A quiet day.\n");
  const { matches } = service.forgetSearch("harbor");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.file, "memory/2026-11-17.md");
  const applied = service.forgetApply("harbor", 1);
  assert.equal(applied.ok, true);
  const note = readCtx(store, "memory/2026-11-17.md");
  assert.ok(note.includes("A quiet day."));
  assert.ok(!note.includes("harbor"));
  assert.ok(existsSync(join(store.contextDir, "memory", "2026-11-17.md")));
});
