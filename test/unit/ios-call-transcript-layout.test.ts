/**
 * v0.47.2: the call screen's transcript space contract.
 *
 * Glenn's report (2026-11-27): the live transcript's
 * scrolling text was no longer visible during voice
 * calls. The mechanism: transcriptPanel was the ONLY
 * flexible element in callContent's VStack — no minimum
 * height — so everything the screen gained since the
 * transcript shipped in v0.23.0 (the persona name line,
 * Camera and Watch controls, stackable status notices,
 * push-to-talk, the Share screen row) was paid for out
 * of the transcript's height, squeezing it toward
 * invisibility on shorter screens or with notices
 * stacked. And its ScrollView used a LazyVStack, whose
 * not-yet-realized bottom anchor could make
 * ScrollViewReader.scrollTo silently no-op.
 *
 * What is pinned here (all in CallView.swift):
 *  - The floor: transcriptPanel's frame declares a
 *    minHeight (170) alongside its flexible maxHeight —
 *    the panel can shrink, never vanish.
 *  - The room comes from the face: in the non-Watch
 *    header, the persona face's side is 150 while a call
 *    is live and 232 pre-call — and the live side is
 *    strictly smaller than the pre-call side.
 *  - The notices' claim is capped: each of the four
 *    statusBlock notices (speech / watch / screen /
 *    error) carries the live-call line cap
 *    `.lineLimit(inCall ? 2 : 3)`.
 *  - Auto-scroll is robust: the transcript's stack is a
 *    plain VStack, NOT a LazyVStack, and the bottom
 *    anchor id + scrollTo wiring are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const callView = read("apps/ios/App/CallView.swift");

/** One body section of CallView.swift, sliced from its
 * declaration to the next section's declaration. */
function section(startMarker: string, endMarker: string): string {
  const start = callView.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} not found`);
  const end = callView.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} not found after ${startMarker}`);
  return callView.slice(start, end);
}

const header = section("private var headerSection", "private var statusBlock");
const status = section("private var statusBlock", "private var inCallSection");
const panel = section(
  "private var transcriptPanel",
  "private static let transcriptBottomID",
);

test("transcript floor: the panel's frame declares a minHeight", () => {
  assert.ok(
    panel.includes(
      ".frame(maxWidth: .infinity, minHeight: 170, maxHeight: .infinity, alignment: .topLeading)",
    ),
    "transcriptPanel must keep a 170pt floor under its flexible height",
  );
});

test("the face pays for it: in-call side is smaller than pre-call", () => {
  const m = header.match(/personaFaceButton\(side: inCall \? (\d+) : (\d+)\)/);
  assert.ok(m, "the non-Watch face must size itself by inCall");
  const live = Number(m[1]);
  const preCall = Number(m[2]);
  assert.equal(preCall, 232);
  assert.equal(live, 150);
  assert.ok(live < preCall, "the live-call face must be the smaller one");
  // The Watch/screen tile layout is untouched.
  assert.ok(header.includes("personaFaceButton(side: 104)"));
});

test("notices are capped while a call is live", () => {
  const caps = status.match(/\.lineLimit\(inCall \? 2 : 3\)/g) ?? [];
  assert.equal(
    caps.length,
    4,
    "speech, watch, screen and error notices each carry the live-call cap",
  );
  // The primary status line is not a notice — it keeps
  // its own 3 lines.
  assert.ok(status.includes(".lineLimit(3)"));
});

test("auto-scroll: the transcript stack is not lazy, the anchor is", () => {
  assert.ok(
    !panel.includes("LazyVStack"),
    "a lazy stack's unrealized bottom anchor makes scrollTo a silent no-op",
  );
  assert.ok(panel.includes("VStack(alignment: .leading, spacing: 10)"));
  assert.ok(panel.includes(".id(Self.transcriptBottomID)"));
  assert.ok(
    callView.includes("proxy.scrollTo(Self.transcriptBottomID, anchor: .bottom)"),
  );
});
