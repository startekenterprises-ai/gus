/**
 * v0.45.0: the screen-viewing pins (roadmap item 18 —
 * GUS sees the operator's SCREEN during a call, the
 * ReplayKit sibling of Watch mode).
 *
 * The Swift cannot be compiled on this machine, so the
 * contract is pinned from source (the established
 * ios-*.test.ts pattern), and the PROJECT FILE is pinned
 * structurally: the broadcast extension target exists and
 * is wired — a future edit that silently drops the
 * target, its embed phase, or its dependency fails here,
 * not at Glenn's archive.
 *
 * What is pinned:
 *  - pbxproj: the GUSBroadcast target (broadcast-
 *    extension product type, its own bundle id), its
 *    synchronized Broadcast group, its three build
 *    phases, its configuration list and both configs
 *    (INFOPLIST_FILE at BroadcastInfo.plist — OUTSIDE the
 *    synchronized group, the v0.17.3 lesson — plus the
 *    group entitlements), the app target's Embed App
 *    Extensions phase + build file, the target
 *    dependency + proxy, and the app's own entitlements.
 *    Every BB-id in the file is defined, braces and
 *    parens balance.
 *  - The extension's plist: the documented minimal
 *    NSExtension set (upload point identifier, principal
 *    class, sample-buffer process mode), physically at
 *    apps/ios/BroadcastInfo.plist — NOT inside Broadcast/.
 *  - Both entitlements files name the one app group, and
 *    the group literals agree across the app's bridge
 *    (Shared/ScreenShare.swift) and the extension's own
 *    copy (Broadcast/SampleHandler.swift).
 *  - The extension's discipline: SampleHandler subclass;
 *    absent/stale session info finishes with the plain
 *    explanation; ~5 s throttle; drop-rather-than-queue;
 *    ≤768 px / q0.4 frames; posts to the watch-frame
 *    route as camera "screen"; one rolling preview file;
 *    broadcastFinished clears flag + preview; the token
 *    is never logged (no print/NSLog anywhere in it).
 *  - The app's side: session info written when a Core
 *    call goes live and cleared when it ends; the group
 *    poll (flag + heartbeat) drives screenSharing and
 *    the core's screen-share posts; the client route
 *    exists; CallView hosts the system picker with our
 *    extension preferred, shows the explainer BEFORE the
 *    picker, the "Your screen" tile + sharing pill while
 *    sharing, and the on-device refusal presents no
 *    picker at all.
 *  - The core's side: the screen-share route exists in
 *    the panel server and is wired through the
 *    control-plane backend to the session service.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const pbxproj = read("apps/ios/GUS.xcodeproj/project.pbxproj");
const broadcastPlist = read("apps/ios/BroadcastInfo.plist");
const appEntitlements = read("apps/ios/GUS.entitlements");
const extEntitlements = read("apps/ios/GUSBroadcast.entitlements");
const handler = read("apps/ios/Broadcast/SampleHandler.swift");
const bridge = read("apps/ios/Shared/ScreenShare.swift");
const callSession = read("apps/ios/Shared/CallSession.swift");
const callView = read("apps/ios/App/CallView.swift");
const gusClient = read("apps/ios/Shared/GUSClient.swift");
const panelServer = read("packages/panel/src/server.ts");
const controlMain = read("packages/control-plane/src/main.ts");

const GROUP_ID = "group.com.startekenterprises.gus";
const BUNDLE_ID = "com.startekenterprises.gus.broadcast";

test("pbxproj: balanced, and every referenced id is defined", () => {
  const stripped = pbxproj
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  const count = (s: string, ch: string) => s.split(ch).length - 1;
  assert.equal(count(stripped, "{"), count(stripped, "}"), "braces balance");
  assert.equal(count(stripped, "("), count(stripped, ")"), "parens balance");
  const ids = new Set(pbxproj.match(/\bBB[0-9A-F]{22}\b/g) ?? []);
  const defined = new Set(
    [...pbxproj.matchAll(/^\s*(BB[0-9A-F]{22})(?:\s*\/\*[^*]*\*\/)?\s*=/gm)].map((m) => m[1]),
  );
  for (const id of ids) {
    assert.ok(defined.has(id), `${id} is referenced but never defined`);
  }
});

test("pbxproj: the broadcast extension target exists, wired end to end", () => {
  // The target: its product reference, its synchronized
  // group, its config list. The product type pairing
  // (v0.47.1): a ReplayKit broadcast upload extension is a
  // PLAIN app extension to Xcode — the productType is
  // app-extension, and the broadcast KIND comes from the
  // plist's extension point. Pinning
  // "com.apple.product-type.broadcast-extension" here in
  // v0.45.0 shipped a product type Xcode 26 does not know,
  // and the archive died before compiling; the two halves
  // are pinned together so neither drifts alone again.
  assert.match(pbxproj, /BB0000000000000000000103 \/\* GUSBroadcast \*\/ = \{\n\t\t\tisa = PBXNativeTarget;/);
  assert.match(pbxproj, /productType = "com\.apple\.product-type\.app-extension";/);
  assert.doesNotMatch(pbxproj, /product-type\.broadcast-extension/);
  assert.match(broadcastPlist, /<key>NSExtensionPointIdentifier<\/key>\s*<string>com\.apple\.broadcast-services-upload<\/string>/);
  assert.match(pbxproj, /productReference = BB0000000000000000000101 \/\* GUSBroadcast\.appex \*\/;/);
  assert.match(pbxproj, /BB0000000000000000000102 \/\* Broadcast \*\/ = \{\n\t\t\tisa = PBXFileSystemSynchronizedRootGroup;/);
  assert.match(pbxproj, /buildConfigurationList = BB0000000000000000000104 \/\* Build configuration list for PBXNativeTarget "GUSBroadcast" \*\/;/);
  // Its build phases ride the target.
  assert.match(pbxproj, /BB0000000000000000000107 \/\* Sources \*\/,\n\t\t\t\tBB0000000000000000000108 \/\* Frameworks \*\/,\n\t\t\t\tBB0000000000000000000109 \/\* Resources \*\//);
  // The project lists it as a target.
  assert.match(pbxproj, /targets = \(\n\t\t\t\tBB0000000000000000000005 \/\* GUS \*\/,\n\t\t\t\tBB0000000000000000000014 \/\* GUSWatch \*\/,\n\t\t\t\tBB0000000000000000000103 \/\* GUSBroadcast \*\/,\n\t\t\t\);/);
  // The app embeds it: copy-files phase (PlugIns, spec 13),
  // its build file, and the target dependency + proxy.
  assert.match(pbxproj, /BB0000000000000000000112 \/\* Embed App Extensions \*\/ = \{\n\t\t\tisa = PBXCopyFilesBuildPhase;/);
  assert.match(pbxproj, /dstSubfolderSpec = 13;/);
  assert.match(pbxproj, /BB0000000000000000000113 \/\* GUSBroadcast\.appex in Embed App Extensions \*\/ = \{isa = PBXBuildFile; fileRef = BB0000000000000000000101/);
  assert.match(pbxproj, /BB0000000000000000000110 \/\* PBXTargetDependency \*\/ = \{\n\t\t\tisa = PBXTargetDependency;\n\t\t\ttarget = BB0000000000000000000103 \/\* GUSBroadcast \*\/;\n\t\t\ttargetProxy = BB0000000000000000000111 \/\* PBXContainerItemProxy \*\/;/);
  assert.match(pbxproj, /remoteGlobalIDString = BB0000000000000000000103;/);
  // Both extension configs: bundle id, plist by path,
  // entitlements by path, SKIP_INSTALL.
  const extConfigs = pbxproj.match(/PRODUCT_BUNDLE_IDENTIFIER = com\.startekenterprises\.gus\.broadcast;/g) ?? [];
  assert.equal(extConfigs.length, 2, "Debug + Release carry the extension bundle id");
  const plistRefs = pbxproj.match(/INFOPLIST_FILE = BroadcastInfo\.plist;/g) ?? [];
  assert.equal(plistRefs.length, 2);
  const entRefs = pbxproj.match(/CODE_SIGN_ENTITLEMENTS = GUSBroadcast\.entitlements;/g) ?? [];
  assert.equal(entRefs.length, 2);
  const skip = pbxproj.match(/SKIP_INSTALL = YES;/g) ?? [];
  assert.ok(skip.length >= 2, "the extension (and the watch app) skip install");
  // The app target gained its own entitlements (both configs).
  const appEnt = pbxproj.match(/CODE_SIGN_ENTITLEMENTS = GUS\.entitlements;/g) ?? [];
  assert.equal(appEnt.length, 2, "the app target signs with the group entitlement");
});

test("extension plist: the minimal NSExtension set, outside the synchronized group", () => {
  assert.match(broadcastPlist, /<string>com\.apple\.broadcast-services-upload<\/string>/);
  assert.match(broadcastPlist, /<key>NSExtensionPrincipalClass<\/key>/);
  assert.match(broadcastPlist, /<string>\$\(PRODUCT_MODULE_NAME\)\.SampleHandler<\/string>/);
  assert.match(broadcastPlist, /<key>RPBroadcastProcessMode<\/key>/);
  assert.match(broadcastPlist, /<string>RPBroadcastProcessModeSampleBuffer<\/string>/);
  assert.equal(
    existsSync(join(root, "apps/ios/Broadcast/Info.plist")),
    false,
    "no physical plist inside the synchronized Broadcast group (the v0.17.3 trap)",
  );
  assert.equal(
    existsSync(join(root, "apps/ios/Broadcast/SampleHandler.swift")),
    true,
    "the handler source lives in the synchronized group",
  );
});

test("entitlements + group literals agree across app, extension, and bridge", () => {
  for (const file of [appEntitlements, extEntitlements]) {
    assert.match(file, /com\.apple\.security\.application-groups/);
    assert.ok(file.includes(GROUP_ID), "both targets are entitled to the one group");
  }
  for (const src of [bridge, handler]) {
    assert.ok(src.includes(`"${GROUP_ID}"`), "the group id literal agrees");
    for (const key of ["screenShare.sessionInfo", "screenShare.active", "screenShare.heartbeat", "screen-preview.jpg"]) {
      assert.ok(src.includes(`"${key}"`), `the shared literal ${key} agrees`);
    }
  }
  assert.ok(handler.includes(`"${BUNDLE_ID}"`) === false, "the extension never hardcodes its own bundle id");
  assert.match(callView, new RegExp(`preferredExtension = "${BUNDLE_ID.replaceAll(".", "\\.")}"`),
    "the picker prefers the extension by its bundle id");
});

test("extension discipline: throttle, drop-don't-queue, small frames, one preview, quiet finish", () => {
  assert.match(handler, /final class SampleHandler: RPBroadcastSampleHandler/);
  assert.match(handler, /frameIntervalSeconds: TimeInterval = 5/);
  assert.match(handler, /maxLongEdge: CGFloat = 768/);
  assert.match(handler, /jpegQuality = 0\.4/);
  assert.match(handler, /drop, never queue/);
  assert.match(handler, /"camera": "screen"/);
  assert.match(handler, /\/api\/voice\/session\/watch-frame/);
  assert.match(handler, /finishBroadcastWithError/);
  assert.match(handler, /start a call in Core mode first/);
  assert.match(handler, /override func broadcastFinished\(\)/);
  assert.match(handler, /removeItem\(at: url\)/, "the preview is removed when the broadcast finishes");
  assert.doesNotMatch(handler, /\bprint\(|NSLog\(/, "the extension logs nothing — the token can never reach a log");
  assert.doesNotMatch(handler, /UserDefaults\.standard/, "nothing goes to the standard defaults — the group only");
});

test("app side: session info armed at Core-call live, cleared at end; the poll drives the core posts", () => {
  assert.match(callSession, /armScreenShare\(sessionId: id\)/);
  assert.match(callSession, /ScreenShareSessionInfo\.write\(/);
  assert.match(callSession, /ScreenShareSessionInfo\.clear\(\)/);
  assert.match(callSession, /stopScreenShare\(\)/);
  assert.match(callSession, /ScreenShareGroup\.broadcastActive/);
  assert.match(callSession, /voiceSessionScreenShare\(sessionId: id, on: true\)/);
  assert.match(callSession, /voiceSessionScreenShare\(sessionId: id, on: false\)/);
  assert.match(bridge, /heartbeatStaleSeconds: TimeInterval = 12/);
  assert.match(bridge, /static var broadcastActive: Bool/);
  assert.match(gusClient, /"\/api\/voice\/session\/screen-share"/);
  assert.match(gusClient, /func voiceSessionScreenShare\(sessionId: String, on: Bool\)/);
});

test("call screen: picker with explainer first, tile + pill while sharing, honest on-device refusal", () => {
  assert.match(callView, /private struct BroadcastPickerHost: UIViewRepresentable/);
  assert.match(callView, /RPSystemBroadcastPickerView/);
  assert.match(callView, /showsMicrophoneButton = false/);
  assert.match(callView, /GUS sees your screen only while sharing is on\. iOS shows a red indicator the whole time you share/);
  assert.match(callView, /Text\("Sharing your screen"\)/);
  assert.match(callView, /call\.screenPreview/);
  assert.match(callView, /Your screen — waiting for the first frame…/);
  assert.match(callView, /call\.screenSharing \|\| call\.watchOn|call\.watchOn \|\| call\.screenSharing/,
    "sharing takes the FaceTime tile layout beside the persona");
  // On-device: the row is a refusal button — the picker
  // exists only in the Core branch of the row.
  assert.match(callView, /if call\.callMode == \.onDevice \{\s*\n\s*Button \{ call\.screenShareRefused\(\) \}/);
  assert.match(callSession, /Sharing your screen needs Core mode — this brain can't see yet\./);
});

test("core side: the screen-share route exists and is wired to the session", () => {
  assert.match(panelServer, /path === "\/api\/voice\/session\/screen-share"/);
  assert.match(panelServer, /this\.backend\.voiceSessionScreenShare/);
  assert.match(controlMain, /voiceSessionScreenShare: \(sessionId, on\) =>\s*\n?\s*voiceSessions\.submitScreenShare\(sessionId, on\)/);
});
