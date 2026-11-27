/**
 * v0.42.0: voice playback speed — the pins.
 *
 * What is pinned here:
 *  - The preference: ONE KokoroSpeed pick persisted at
 *    gus.voice.speed, global (never per-persona), with
 *    the five steps 0.8 / 0.9 / 1.0 / 1.1 / 1.25 and an
 *    unwritten key reading as 1.0 — the speed every
 *    build through v0.41.1 spoke at. Stored values are
 *    snapped to the nearest step on read AND write, so
 *    the engine only ever hears an offered step.
 *  - The mechanism: the pick rides the SDK's own speed
 *    parameter (KokoroAneManager.synthesizeDetailed
 *    text:voice:speed:, default KokoroAneConstants
 *    .defaultSpeed = 1.0) — the model scales its
 *    predicted durations; no resampling anywhere.
 *  - The application: KokoroRuntime.synthesize passes
 *    the CURRENT pick, read at each synthesis, through
 *    the app's ONE synthesizeDetailed call — the funnel
 *    call sentences (both playback engines) and voice
 *    previews share, so a Settings change lands on the
 *    next sentence, even mid-call.
 *  - The Settings surface: a Speed picker in the Call
 *    voice section, bound to the one preference, 1.0×
 *    labeled Normal, with the caption that speed covers
 *    calls and previews and lands on the next sentence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const kokoroTTS = read("apps/ios/Shared/KokoroTTS.swift");
const settingsView = read("apps/ios/App/SettingsView.swift");
const speechEngine = read("apps/ios/Shared/SpeechEngine.swift");

test("voice speed: the one global preference, Normal by default", () => {
  assert.ok(kokoroTTS.includes("enum KokoroSpeed"));
  // The five steps, in order, with 1.0 the default.
  assert.ok(kokoroTTS.includes("static let steps: [Double] = [0.8, 0.9, 1.0, 1.1, 1.25]"));
  assert.ok(kokoroTTS.includes("static let defaultStep: Double = 1.0"));
  // One key; the read and the write both snap.
  assert.ok(kokoroTTS.includes('UserDefaults.standard.object(forKey: "gus.voice.speed") as? Double'));
  assert.ok(kokoroTTS.includes("return snapped(raw ?? defaultStep)"));
  assert.ok(kokoroTTS.includes('UserDefaults.standard.set(snapped(newValue), forKey: "gus.voice.speed")'));
  assert.ok(kokoroTTS.includes("static func snapped(_ value: Double) -> Double"));
  // 1.0× carries the Normal label.
  assert.ok(kokoroTTS.includes('"Normal (1.0×)"'));
  assert.ok(kokoroTTS.includes("static func displayName(for step: Double) -> String"));
});

test("voice speed: the SDK's own speed parameter, no resampling", () => {
  // The one synthesizeDetailed call in the app passes
  // the current pick as the SDK's speed argument.
  assert.ok(
    kokoroTTS.includes("manager.synthesizeDetailed(\n                text: text, voice: voiceID, speed: Float(KokoroSpeed.selected))"),
    "the funnel passes Float(KokoroSpeed.selected) as speed:",
  );
  const calls = kokoroTTS.match(/manager\.synthesizeDetailed/g) ?? [];
  assert.equal(calls.length, 1, "exactly one synthesizeDetailed call site — the funnel");
  // No pitch/rate trickery was introduced anywhere in
  // the file to fake the speed.
  assert.ok(!kokoroTTS.includes("AVAudioUnitTimePitch"));
  assert.ok(!kokoroTTS.includes("AVAudioUnitVarispeed"));
});

test("voice speed: calls and previews share the funnel", () => {
  // Call sentences reach Kokoro through SpeechEngine's
  // KokoroRuntime calls; previews call the same runtime.
  assert.ok(speechEngine.includes("KokoroRuntime.shared.synthesize(text)"));
  assert.ok(kokoroTTS.includes("KokoroRuntime.shared.synthesize(line, voice: voice.id)"));
  // Neither path names a speed of its own — the pick is
  // read once, inside the funnel.
  assert.ok(!speechEngine.includes("KokoroSpeed"));
});

test("voice speed: the Settings picker and its caption", () => {
  assert.ok(settingsView.includes("@State private var kokoroSpeed: Double = KokoroSpeed.selected"));
  assert.ok(settingsView.includes('Picker("Speed", selection: $kokoroSpeed)'));
  assert.ok(settingsView.includes("ForEach(KokoroSpeed.steps, id: \\.self)"));
  assert.ok(settingsView.includes("Text(KokoroSpeed.displayName(for: step)).tag(step)"));
  assert.ok(settingsView.includes("KokoroSpeed.selected = newValue"));
  assert.ok(
    settingsView.includes("Speed sets how fast GUS talks — on calls and in these previews alike — and a change lands on the next sentence, even mid-call."),
    "the caption states the reach: calls, previews, next sentence",
  );
});
