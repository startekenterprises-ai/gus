/**
 * Spoken form (v0.14.7): a delivery composed for a text surface
 * must never be read aloud verbatim when it is system
 * bookkeeping. Field case, 2026-11-19: a Governor cap refusal
 * ("per-day token cap 200000 would be exceeded… the ledger
 * shows every charge") was synthesized word for word on a voice
 * call. These tests pin the rewrite rules and — just as much —
 * that ordinary replies pass through untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toSpokenForm } from "../../packages/channels/voice/src/index.js";

test("the Governor cap notice becomes one plain spoken line", () => {
  const spoken = toSpokenForm(
    "💸 Governor cap reached — the job was stopped by the spend ceiling, not by the agent: " +
      "per-day token cap 200000 would be exceeded. It ended as failed-loudly with a receipt; the ledger shows every charge.",
  );
  assert.ok(!/token/i.test(spoken), spoken);
  assert.ok(!/\d/.test(spoken), spoken);
  assert.ok(!/ledger|receipt/i.test(spoken), spoken);
  assert.match(spoken, /usage limit/i);
  assert.match(spoken, /Budget/);
});

test("a denied-action notice is spoken as a block, without the tool detail", () => {
  const spoken = toSpokenForm(
    '🚫 Denied by the control plane: "mac_shell" was refused (outside the workspace jail). The job ended as failed-loudly with a receipt.',
  );
  assert.match(spoken, /blocked/i);
  assert.ok(!/mac_shell|jail/i.test(spoken), spoken);
});

test("a secret-guard withholding is spoken plainly", () => {
  const spoken = toSpokenForm(
    "[A reply was withheld by secret-guard: it contained what looked like a secret.]",
  );
  assert.match(spoken, /withheld/i);
  assert.ok(!/secret-guard/.test(spoken), spoken);
});

test("the runtime's cap-flavoured failure sentence collapses to the limit line", () => {
  const spoken = toSpokenForm("I couldn't complete that: per-day token cap 200000 would be exceeded");
  assert.equal(spoken, "That hit a limit on my side, so it didn't finish.");
});

test("a jargon sentence inside a longer reply is dropped; the rest is kept", () => {
  const spoken = toSpokenForm(
    "The build finished and the DMG is in the dist folder. That job used 12,739 tokens in total. You can publish it whenever you're ready.",
  );
  assert.match(spoken, /build finished/);
  assert.match(spoken, /publish it whenever/);
  assert.ok(!/tokens/.test(spoken), spoken);
});

test("record ids are spoken as nouns, not strings", () => {
  const spoken = toSpokenForm("Job job_mwo218jm_03399 settled with receipt gus_rcpt_2a1a605104ae7858 attached.");
  assert.ok(!/job_mwo|rcpt_/.test(spoken), spoken);
  assert.match(spoken, /the job settled with receipt a receipt/);
});

test("an ordinary reply passes through untouched", () => {
  const reply =
    "It's going well — the iMac build passed all 469 tests, and dinner's at 7 if you're still walking Dino then.";
  assert.equal(toSpokenForm(reply), reply);
});

test("ordinary uses of the filter's near-miss words survive", () => {
  const reply = "The governor signed the bill today, and the token economy piece is worth a read.";
  assert.equal(toSpokenForm(reply), reply);
});

test("markdown and emoji are cleaned from spoken text", () => {
  const spoken = toSpokenForm("✅ **Done** — the `report.md` file is ready.");
  assert.equal(spoken, "Done — the report.md file is ready.");
});

test("the approval read-back surface passes verbatim — it is a security surface", () => {
  const parked =
    '⏸ Job parked — this needs your approval before anything runs: "Write file "notes.txt" in the workspace (2 chars)". ' +
    'Say "confirm" to approve it exactly as read, or "deny" to refuse it.';
  assert.equal(toSpokenForm(parked), parked);
  const approved = '✅ Approved: "Write file "notes.txt" in the workspace (2 chars)". Executing exactly that now.';
  assert.equal(toSpokenForm(approved), approved);
  const denied = '🚫 Denied: "Write file "notes.txt" in the workspace (2 chars)". Nothing ran. The job ended as failed-loudly with a receipt.';
  assert.equal(toSpokenForm(denied), denied);
});

test("empty stays empty", () => {
  assert.equal(toSpokenForm(""), "");
  assert.equal(toSpokenForm("   "), "");
});
