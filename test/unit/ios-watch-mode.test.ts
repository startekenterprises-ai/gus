// GUS v0.37.0 — Watch mode, live vision calls. The Swift
// cannot be compiled on this machine, so the call screen's
// contract is pinned from source (the established pattern
// of the ios-*.test.ts files): the Watch toggle exists and
// never starts itself, the on-device explanation is the
// plain-words line, the sampler cadence is 12 s, frames
// refresh at turn end, backgrounding suspends the camera,
// the capture is a real AVCaptureSession (single + multi
// cam) with a torch and a perceptual hash, and the core's
// watch routes exist and are wired.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const callView = read("apps/ios/App/CallView.swift");
const callSession = read("apps/ios/Shared/CallSession.swift");
const watchCapture = read("apps/ios/Shared/WatchCapture.swift");
const gusClient = read("apps/ios/Shared/GUSClient.swift");
const panelServer = read("packages/panel/src/server.ts");
const controlMain = read("packages/control-plane/src/main.ts");

test("Watch toggle: video icon beside Camera, filled while watching, operator-tapped only", () => {
  assert.match(callView, /title: call\.watchOn \? "Watching" : "Watch"/);
  assert.match(callView, /systemImage: "video\.fill"/);
  assert.match(callView, /\{ call\.setWatch\(on: !call\.watchOn\) \}/);
  // The toggle is the ONLY watch starter on the call
  // screen: nothing in the view turns Watch on by itself.
  assert.equal(callView.match(/setWatch\(on:/g)?.length, 1);
  // start-in-call (v0.36.0) does not start Watch: the
  // session's startCall only ever stops a leftover watch.
  const startCall = callSession.slice(
    callSession.indexOf("func startCall()"),
    callSession.indexOf("func startCall()") + 3000
  );
  assert.match(startCall, /if watchOn \{ stopWatch\(announce: false\) \}/);
  assert.doesNotMatch(startCall, /startWatch\(\)/);
});

test("Watch layout: persona stays a tile beside the camera, with the on-air pill", () => {
  assert.match(callView, /personaFaceButton\(side: 104\)/);
  assert.match(callView, /personaFaceButton\(side: 232\)/);
  assert.match(callView, /WatchPreviewHost\(view: call\.watchPreviewView\)/);
  assert.match(callView, /Text\("Watching"\)/);
  assert.match(callView, /frames aren't saved/);
  assert.match(callView, /private struct WatchPreviewHost: UIViewRepresentable/);
});

test("Watch controls: flip, both (only when supported), and torch (only when usable)", () => {
  assert.match(callView, /arrow\.triangle\.2\.circlepath\.camera/);
  assert.match(callView, /if call\.watchBothSupported/);
  assert.match(callView, /rectangle\.split\.2x1/);
  assert.match(callView, /flashlight\.on\.fill/);
  assert.match(callView, /\.disabled\(!call\.watchTorchUsable\)/);
});

test("on-device Watch: the plain-words explanation, and no capture at all", () => {
  assert.match(
    callSession,
    /Watching needs Core mode — this brain can't see yet\./
  );
  // The explanation path returns before any capture work:
  // beginWatch is only reachable through the Core branch.
  const startWatch = callSession.slice(
    callSession.indexOf("private func startWatch()"),
    callSession.indexOf("private func watchPermissionDenied()")
  );
  assert.match(startWatch, /guard transport == \.core, let id = sessionId else/);
  assert.match(startWatch, /beginWatch\(sessionId: id\)/);
});

test("sampling: 12 s baseline, fresh frame first at turn end, frames small with a hash", () => {
  assert.match(callSession, /watchSampleSeconds: UInt64 = 12/);
  // Both Core dispatch paths await the fresh frame before
  // the transcript, so the turn is grounded in the current
  // view; the baseline sampler marks its frames ordinary.
  assert.equal(
    callSession.match(/await self\.uploadWatchFrames\(turnRefresh: true\)/g)?.length,
    2
  );
  assert.match(callSession, /uploadWatchFrames\(turnRefresh: false\)/);
  assert.match(watchCapture, /maxLongEdge: CGFloat = 768/);
  assert.match(watchCapture, /jpegQuality: CGFloat = 0\.4/);
  assert.match(watchCapture, /String\(format: "%016llx", bits\)/);
});

test("backgrounding: the camera suspends away and resumes on return; the call does not", () => {
  assert.match(callSession, /UIApplication\.didEnterBackgroundNotification/);
  assert.match(callSession, /UIApplication\.willEnterForegroundNotification/);
  assert.match(callSession, /watchCapture\.suspend\(\)/);
  assert.match(callSession, /watchCapture\.resume\(\)/);
  // Ending the call stops the watch first — the camera
  // never outlives the call it belongs to.
  const endCall = callSession.slice(
    callSession.indexOf("func endCall()"),
    callSession.indexOf("func endCall()") + 1200
  );
  assert.match(endCall, /stopWatch\(announce: false\)/);
});

test("capture: real AVCaptureSession, multi-cam when supported, torch on the back camera", () => {
  assert.match(watchCapture, /AVCaptureMultiCamSession\(\)/);
  assert.match(watchCapture, /AVCaptureMultiCamSession\.isMultiCamSupported/);
  assert.match(watchCapture, /AVCaptureVideoDataOutput\(\)/);
  assert.match(watchCapture, /setSampleBufferDelegate/);
  assert.match(watchCapture, /device\.hasTorch/);
  assert.match(watchCapture, /device\.torchMode = on \? \.on : \.off/);
  // Programmatic frames only — the system picker is the
  // still camera's tool, never Watch's.
  assert.doesNotMatch(watchCapture, /UIImagePickerController/);
});

test("client + routes: the watch calls exist on both ends and are wired to the session", () => {
  assert.match(gusClient, /func voiceSessionWatch\(/);
  assert.match(gusClient, /func voiceSessionWatchFrame\(/);
  assert.match(gusClient, /"\/api\/voice\/session\/watch"/);
  assert.match(gusClient, /"\/api\/voice\/session\/watch-frame"/);
  assert.match(panelServer, /"\/api\/voice\/session\/watch"/);
  assert.match(panelServer, /"\/api\/voice\/session\/watch-frame"/);
  assert.match(controlMain, /voiceSessions\.submitWatch\(/);
  assert.match(controlMain, /voiceSessions\.submitWatchFrame\(/);
});

test("transcript: ambient observations are labelled as GUS looking, never as speech", () => {
  assert.match(callView, /turn\.watch == true/);
  assert.match(callView, /GUS LOOKED — WATCH/);
  assert.match(callSession, /Watching on — GUS can see what the/);
  assert.match(callSession, /note: "Watching off\."/);
});
