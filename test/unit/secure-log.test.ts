/**
 * The secure log's read model (v0.11.0) — the timeline derivation
 * pinned. The desktop chat's live secure log renders the Watch
 * timeline's entries; since v0.11.0 each entry also carries a
 * derived category (for the filter chips), a plain-language
 * narration line, and a flagged marker for permissive
 * let-throughs. The derivation lives in readWatchTimeline
 * (control-plane/src/watch.ts) so it is exercised here, against
 * the real durable-log shapes, instead of living only in a view:
 *
 *  - gate decisions are "scan" lines, narrated plainly, with the
 *    receipt id still attached;
 *  - a gate record carrying wouldBe (permissive: enforcing would
 *    have bound) is flagged, and its narration is the ONE short
 *    discreet line — allowed, logged, flagged as potentially
 *    insecure — while `detail` keeps the full recorded text;
 *  - permissive_action / permissive_ingress events are flagged
 *    with the same one-liner (the tool named when the record
 *    names one);
 *  - a delegated approval recorded through the same hook is an
 *    "approval" line and is NOT flagged — GUS decided it, with
 *    its reason on the record;
 *  - approval lifecycle events are "approval" lines; Shield flag
 *    and scan-skip events are "scan" lines; everything else is
 *    an "action" line narrated by its recorded detail;
 *  - kind / detail / ordering are exactly what they were before
 *    the derivation existed (the web Watch view renders those).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWatchTimeline } from "../../packages/control-plane/src/watch.js";

function dirWith(events: unknown[], gate: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "gus-secure-log-"));
  if (events.length) {
    appendFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  if (gate.length) {
    appendFileSync(join(dir, "gate.jsonl"), gate.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  return dir;
}

test("secure log: a gate decision is a scan line with a plain narration and its receipt", () => {
  const dir = dirWith([], [{
    ts: 2000, jobId: "job_a", surface: "tool-call", action: "block", scanned: true,
    receiptId: "rcpt_gate_1", detail: "injection pattern in tool result",
  }]);
  const [entry] = readWatchTimeline(dir, 60);
  assert.equal(entry.category, "scan");
  assert.equal(entry.flagged, false);
  assert.equal(entry.receiptId, "rcpt_gate_1");
  assert.equal(entry.narration, "Shield scan — tool-call: block — injection pattern in tool result");
  // The pre-derivation fields are untouched.
  assert.equal(entry.kind, "gate tool-call → block");
  assert.equal(entry.detail, "injection pattern in tool result");
});

test("secure log: a gate wouldBe record is flagged and narrated as the one discreet line", () => {
  const dir = dirWith([], [{
    ts: 2000, jobId: "job_a", surface: "chat-ingress", action: "allow", scanned: true,
    receiptId: "rcpt_gate_2", detail: "suspicious content", wouldBe: "block",
  }]);
  const [entry] = readWatchTimeline(dir, 60);
  assert.equal(entry.category, "scan");
  assert.equal(entry.flagged, true);
  assert.equal(
    entry.narration,
    "⚑ Allowed under Permissive — this chat-ingress scan would block under Enforcing · flagged as potentially insecure · logged",
  );
  // The full recorded text stays on the entry, one tap away.
  assert.equal(entry.detail, "suspicious content (permissive — enforcing would block)");
  assert.equal(entry.receiptId, "rcpt_gate_2");
});

test("secure log: a permissive tool let-through is flagged, one line, tool named", () => {
  const dir = dirWith([{
    ts: 3000, kind: "permissive_action", jobId: "job_b",
    detail: "tool mac_click would PARK for approval in enforcing mode (clicks are consequential) — proceeding under PERMISSIVE mode (no agent approval: approval delegation is off)",
  }], []);
  const [entry] = readWatchTimeline(dir, 60);
  assert.equal(entry.category, "action");
  assert.equal(entry.flagged, true);
  assert.equal(
    entry.narration,
    "⚑ Allowed under Permissive — tool mac_click proceeded · flagged as potentially insecure · logged",
  );
  assert.match(entry.detail, /would PARK for approval/, "the full recorded detail is preserved");
});

test("secure log: a permissive ingress let-through is a flagged scan line", () => {
  const dir = dirWith([{
    ts: 3000, kind: "permissive_ingress", jobId: "job_c", detail: "flagged phrasing in the message",
  }], []);
  const [entry] = readWatchTimeline(dir, 60);
  assert.equal(entry.category, "scan");
  assert.equal(entry.flagged, true);
  assert.equal(
    entry.narration,
    "⚑ Allowed under Permissive — a flagged message proceeded · flagged as potentially insecure · logged",
  );
});

test("secure log: a delegated approval is an approval line, never flagged", () => {
  const dir = dirWith([{
    ts: 3000, kind: "permissive_action", jobId: "job_d",
    detail: "tool shell_run was approved by GUS under the approval-delegation policy (bounded scope; record appr_9) and is executing — GUS's reason: read-only listing",
  }], []);
  const [entry] = readWatchTimeline(dir, 60);
  assert.equal(entry.category, "approval");
  assert.equal(entry.flagged, false);
  assert.match(entry.narration ?? "", /Approved by GUS as delegated approver — tool shell_run is executing/);
});

test("secure log: approval lifecycle, shield flag, and scan-skip events categorize and narrate", () => {
  const dir = dirWith([
    { ts: 1000, kind: "approval_denied", id: "appr_1", jobId: "job_a" },
    { ts: 2000, kind: "shield_flag_inbound", jobId: "job_b", detail: "indirect instruction in a fetched page" },
    { ts: 3000, kind: "shield_scan_skipped_voice", jobId: "job_c", detail: "scan-skipped-by-operator" },
    { ts: 4000, kind: "approval_expired", id: "appr_2", jobId: "job_d" },
  ], []);
  const entries = readWatchTimeline(dir, 60);
  const byTs = new Map(entries.map((e) => [e.ts, e]));
  assert.equal(byTs.get(1000)?.category, "approval");
  assert.match(byTs.get(1000)?.narration ?? "", /Approval denied — the action never ran/);
  assert.equal(byTs.get(2000)?.category, "scan");
  assert.match(byTs.get(2000)?.narration ?? "", /Shield flagged an inbound message — indirect instruction/);
  assert.equal(byTs.get(3000)?.category, "scan");
  assert.match(byTs.get(3000)?.narration ?? "", /without the Shield scan/);
  assert.equal(byTs.get(4000)?.category, "approval");
  assert.match(byTs.get(4000)?.narration ?? "", /Approval expired/);
  assert.ok(entries.every((e) => e.flagged === false));
});

test("secure log: an unlisted event kind is an action line narrated by its detail", () => {
  const dir = dirWith([
    { ts: 1000, kind: "send_failed", detail: "telegram send failed: network down" },
    { ts: 2000, kind: "some_future_kind" },
  ], []);
  const entries = readWatchTimeline(dir, 60);
  const byTs = new Map(entries.map((e) => [e.ts, e]));
  assert.equal(byTs.get(1000)?.category, "action");
  assert.equal(byTs.get(1000)?.narration, "telegram send failed: network down");
  assert.equal(byTs.get(2000)?.category, "action");
  assert.equal(byTs.get(2000)?.narration, "Some future kind");
});
