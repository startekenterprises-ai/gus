/**
 * v0.41.0: push-to-talk — the call input mode pins.
 *
 * What is pinned here:
 *  - The preference: ONE CallInputMode enum persisted at
 *    gus.call.inputMode, defaulting to handsFree (an
 *    unwritten key reads as today's behavior exactly),
 *    with Claude's two display names from Glenn's
 *    screenshots (2026-11-27).
 *  - Settings carries the picker in the Call mode section,
 *    bound to the one preference, with the plain captions:
 *    hands free is best for quiet environments; push to
 *    talk is hold to speak, release to send; a change
 *    takes effect on the next call.
 *  - CallSession reads the preference ONCE, in startCall —
 *    a call runs in the mode it started in.
 *  - The gating: in push-to-talk, handleTranscript diverts
 *    to the capture handler BEFORE any dispatch or
 *    barge-in; the end-of-speech watchdog runs hands-free
 *    only; the release dispatches through
 *    dispatchSpokenFinal — the same doors the recognizer's
 *    own finals take (that shared function is pinned as
 *    the final branch's one dispatch).
 *  - The press is the barge-in: beginPushToTalk makes the
 *    same cut a voice barge-in makes.
 *  - The call screen: the hold button exists only when
 *    the call's inputMode is pushToTalk, inside the
 *    factored inCallSection — hands-free layout untouched.
 *  - The rider: build-ipa.sh prunes its preserved
 *    per-version archive logs to the newest 6, in the
 *    same EXIT trap as the preserve.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const settingsView = read("apps/ios/App/SettingsView.swift");
const callView = read("apps/ios/App/CallView.swift");
const callSession = read("apps/ios/Shared/CallSession.swift");
const buildIpa = read("hosts/ios-app/build-ipa.sh");

test("input mode: the one preference, hands-free by default", () => {
  assert.ok(callSession.includes("enum CallInputMode: String, CaseIterable, Identifiable"));
  assert.ok(callSession.includes("case handsFree"));
  assert.ok(callSession.includes("case pushToTalk"));
  assert.ok(callSession.includes('"Hands free"'));
  assert.ok(callSession.includes('"Push to talk"'));
  // One key; an unknown or unwritten value reads as
  // handsFree — today's behavior is the default.
  assert.ok(callSession.includes('UserDefaults.standard.string(forKey: "gus.call.inputMode")'));
  assert.ok(callSession.includes("CallInputMode(rawValue: raw) ?? .handsFree"));
  assert.ok(callSession.includes('UserDefaults.standard.set(newValue.rawValue, forKey: "gus.call.inputMode")'));
});

test("input mode: the Settings picker and its captions", () => {
  assert.ok(settingsView.includes("@State private var callInputMode: CallInputMode = CallInputMode.preferred"));
  assert.ok(settingsView.includes('Picker("Input mode", selection: $callInputMode)'));
  assert.ok(settingsView.includes("CallInputMode.preferred = newValue"));
  assert.ok(
    settingsView.includes("Hands free is best for quiet environments"),
    "the hands-free caption, in Claude's words",
  );
  assert.ok(
    settingsView.includes("hold to speak, release to send"),
    "the push-to-talk caption, in Claude's words",
  );
  assert.ok(
    settingsView.includes("Takes effect on your next call."),
    "the caption states the no-hot-swap rule",
  );
});

test("input mode: read once at call start", () => {
  assert.ok(callSession.includes("@Published private(set) var inputMode: CallInputMode = .handsFree"));
  assert.ok(callSession.includes("inputMode = CallInputMode.preferred"));
  assert.ok(callSession.includes("@Published private(set) var pttHolding = false"));
});

test("push to talk: transcripts are gated before dispatch and barge-in", () => {
  // The diversion sits in handleTranscript, ahead of the
  // hands-free flow it returns from.
  assert.ok(callSession.includes("if inputMode == .pushToTalk {"));
  assert.ok(callSession.includes("handlePushToTalkTranscript(text, isFinal: isFinal)"));
  assert.ok(callSession.includes("private func handlePushToTalkTranscript(_ text: String, isFinal: Bool)"));
  // The watchdog — the silence dispatch — is hands-free
  // only: a stale partial in push-to-talk is a held
  // thought, never a synthesized final.
  assert.ok(callSession.includes("self.inputMode == .handsFree"));
  // Finals during a hold accumulate as segments; the
  // baseline keeps pre-press words out of the turn.
  assert.ok(callSession.includes("private var pttCapturedText = \"\""));
  assert.ok(callSession.includes("private func pttEffectiveText(_ raw: String) -> String"));
});

test("push to talk: the press barges in; the release takes the spoken-final doors", () => {
  assert.ok(callSession.includes("func beginPushToTalk()"));
  assert.ok(callSession.includes("func endPushToTalk()"));
  // The press makes the barge-in cut: playback, the local
  // generation, and the core interrupt.
  const begin = callSession.slice(callSession.indexOf("func beginPushToTalk()"));
  assert.ok(begin.includes("cutSpeech()"));
  assert.ok(begin.includes("interruptLocalAnswer()"));
  assert.ok(begin.includes("client.voiceSessionInterrupt(sessionId: id)"));
  // The release dispatches the capture through
  // dispatchSpokenFinal — and the recognizer-final branch
  // dispatches through that SAME function, so a released
  // turn and a spoken final take identical doors (the
  // Shield gate on-device; persona sync + Watch refresh +
  // transcript post on the core).
  assert.ok(callSession.includes("private func dispatchSpokenFinal(_ text: String)"));
  const release = callSession.slice(callSession.indexOf("func endPushToTalk()"));
  assert.ok(release.includes("dispatchSpokenFinal(text)"));
  const finals = callSession.slice(callSession.indexOf("private func handleTranscript"));
  assert.ok(finals.includes("dispatchSpokenFinal(trimmed)"));
  // A capture never survives its own hold or call.
  assert.ok(callSession.includes("private func resetPushToTalkCapture()"));
});

test("push to talk: the hold button exists only in push-to-talk calls", () => {
  assert.ok(callView.includes("if call.inputMode == .pushToTalk {"));
  assert.ok(callView.includes("pushToTalkButton"));
  assert.ok(callView.includes("private var pushToTalkButton: some View"));
  assert.ok(callView.includes('"Hold to talk"'), "the resting label, in Claude's words");
  assert.ok(callView.includes('"Listening — release to send"'), "the while-holding state");
  assert.ok(callView.includes("call.beginPushToTalk()"));
  assert.ok(callView.includes("call.endPushToTalk()"));
  assert.ok(callView.includes("call.pttHolding"), "the button wears the hold state");
});

test("rider: build-ipa prunes preserved archive logs to the newest 6", () => {
  assert.ok(buildIpa.includes("prune_archive_logs() {"));
  assert.ok(buildIpa.includes("ls -t /tmp/gus-archive-*.log"));
  assert.ok(buildIpa.includes("tail -n +7"), "everything past the newest 6 goes");
  assert.ok(
    buildIpa.includes("preserve_archive_log; prune_archive_logs"),
    "the prune rides the same EXIT trap, after the preserve",
  );
});
