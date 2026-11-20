/**
 * The voice fast lane's runtime steering (v0.9.8) — a pure unit
 * surface, pinned:
 *
 *  - A non-voice job's continuations are byte-identical to the
 *    base prompt, always (the lane is a pass-through when off).
 *  - A voice job's FIRST tool-result continuation carries the
 *    final-call note (answer now, in plain text); that is the
 *    whole "cap" — primary call + one continuation.
 *  - If the model asks for another tool anyway, later
 *    continuations carry NO note: the job has promoted itself
 *    to the normal lane and runs unbounded, never stranded —
 *    the host settles verified-done only on Governor-issued
 *    model text, so the lane steers and never force-cuts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VoiceLane,
  VOICE_FAST_LANE_FINAL_NOTE,
} from "../../packages/runtime/src/voice-lane.js";

const BASE = 'TOOL_RESULT read: ok\n(The operator\'s original request was: "hi". Continue it, or reply with plain text to finish.)';

test("voice lane: an inactive lane never alters a continuation", () => {
  const lane = new VoiceLane(false);
  assert.equal(lane.inLane, false);
  assert.equal(lane.continuationPrompt(BASE), BASE);
  assert.equal(lane.continuationPrompt(BASE), BASE);
  assert.equal(lane.continuationPrompt(BASE), BASE);
});

test("voice lane: the first continuation carries the final-call note, later ones do not", () => {
  const lane = new VoiceLane(true);
  assert.equal(lane.inLane, true, "a fresh voice job starts in the lane");
  const first = lane.continuationPrompt(BASE);
  assert.equal(first, BASE + VOICE_FAST_LANE_FINAL_NOTE);
  assert.ok(first.includes("final model call"), "the note says what it is");
  assert.equal(lane.inLane, true, "still in the lane for its one noted continuation");
  // The model ignored the note and asked for another tool: the
  // job has left the steered shape — continuations are plain.
  const second = lane.continuationPrompt(BASE);
  assert.equal(second, BASE, "a promoted job's continuations are byte-identical to a typed job's");
  assert.equal(lane.inLane, false, "and the lane reports itself left");
  assert.equal(lane.continuationPrompt(BASE), BASE);
});
