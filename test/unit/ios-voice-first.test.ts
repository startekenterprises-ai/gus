/**
 * v0.36.0: the voice-first pack pins.
 *
 * What is pinned here:
 *  - Start-in-call is a Settings toggle in the Call mode
 *    section, persisted through the ONE StartInCall
 *    preference (key gus.call.startInCall, default off —
 *    UserDefaults.bool is false until written), with the
 *    plain one-line promise as its caption.
 *  - RootView is the only reader: the signed-in shell's
 *    first appearance, behind a once-per-process latch, so
 *    a cold launch can open the call screen exactly once
 *    and warm foregrounding can never re-trigger it. The
 *    cover presents the SAME CallView(autoStart: true)
 *    Chat's phone button presents — one auto-start path.
 *  - The in-call camera: a Camera control beside Speaker /
 *    Devices / Mute / End; a permission gate that lands a
 *    denial as plain words in the transcript; the system
 *    camera (UIImagePickerController, sourceType .camera —
 *    one photo, no viewfinder of our own); the capture
 *    rides CallSession.sendPhotoTurn, which runs it through
 *    Chat's ONE transport treatment
 *    (ChatModel.transportPhotoData, no longer private) and
 *    records a CallPhotoEntry before dispatching anything.
 *  - On-device honesty: the photo is never dispatched and
 *    the entry + spoken line are the established words —
 *    the SAME string Chat stamps on an on-device photo.
 *    Core: the photo rides GUSClient.voiceSessionTranscript
 *    as base64 JPEG (the chat photo's wire shape), and a
 *    refusal rewrites the entry's note — never a silent
 *    drop, never a claimed delivery.
 *  - The plist carries NSCameraUsageDescription (the
 *    system's in-context ask), and the panel contract
 *    carries the images through to the session service.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const settingsView = read("apps/ios/App/SettingsView.swift");
const rootView = read("apps/ios/App/RootView.swift");
const callView = read("apps/ios/App/CallView.swift");
const callSession = read("apps/ios/Shared/CallSession.swift");
const chatView = read("apps/ios/App/ChatView.swift");
const client = read("apps/ios/Shared/GUSClient.swift");
const plist = read("apps/ios/Info.plist");
const panelTypes = read("packages/panel/src/types.ts");
const main = read("packages/control-plane/src/main.ts");

const HONEST_LINE =
  "This brain can't look at photos yet — switch to Core to ask about pictures.";
const CORE_NOTE = "Photo sent to your Mac — GUS can see it there.";

test("start-in-call: the Settings toggle and its one preference", () => {
  assert.ok(settingsView.includes('Toggle("Start in a voice call", isOn: $startInCall)'));
  assert.ok(settingsView.includes("@State private var startInCall: Bool = StartInCall.enabled"));
  assert.ok(settingsView.includes("StartInCall.enabled = newValue"));
  assert.ok(
    settingsView.includes("opening GUS fresh starts a voice call right away"),
    "the caption states the promise in one line",
  );
  assert.ok(
    settingsView.includes("Coming back to the app later never re-starts a call."),
    "the caption states the warm-foregrounding rule too",
  );
  // The preference itself: one key, read as a bool
  // (false until written — default OFF).
  assert.ok(callSession.includes("enum StartInCall"));
  assert.ok(callSession.includes('"gus.call.startInCall"'));
  assert.ok(callSession.includes("UserDefaults.standard.bool(forKey: \"gus.call.startInCall\")"));
});

test("start-in-call: RootView fires it once, cold only, through the one autoStart path", () => {
  assert.ok(rootView.includes("@State private var showStartCall = false"));
  assert.ok(rootView.includes("@State private var didStartInCall = false"));
  assert.ok(rootView.includes("if StartInCall.enabled && !didStartInCall"));
  assert.ok(rootView.includes("didStartInCall = true"));
  assert.ok(rootView.includes(".fullScreenCover(isPresented: $showStartCall)"));
  assert.ok(rootView.includes("CallView(autoStart: true)"),
    "the same one-tap call screen Chat's phone button presents");
  // The call wins over the brain-setup sheet when both
  // would fire — two presentations never race.
  assert.ok(rootView.includes("showBrainSetup = false"));
});

test("camera: the control, the permission gate, the system camera", () => {
  assert.ok(callView.includes('title: "Camera"'));
  assert.ok(callView.includes('systemImage: "camera.fill"'));
  assert.ok(callView.includes("private func openCamera()"));
  assert.ok(callView.includes("AVCaptureDevice.authorizationStatus(for: .video)"));
  assert.ok(
    callView.includes("Camera access is off for GUS"),
    "a denial lands as plain words in the transcript",
  );
  assert.ok(callView.includes("call.notePhotoProblem("));
  // The system camera, one photo per presentation.
  assert.ok(callView.includes("struct CallCameraPicker: UIViewControllerRepresentable"));
  assert.ok(callView.includes("picker.sourceType = .camera"));
  assert.ok(callView.includes("picker.allowsEditing = false"));
  assert.ok(callView.includes(".fullScreenCover(isPresented: $showCamera)"));
  assert.ok(callView.includes("call.sendPhotoTurn(rawImageData: raw)"));
  // The plist carries the system's in-context ask.
  assert.ok(plist.includes("<key>NSCameraUsageDescription</key>"));
});

test("camera: the photo turn — one pipeline, honest on-device, dispatched in Core", () => {
  assert.ok(callSession.includes("func sendPhotoTurn(rawImageData: Data)"));
  // One image pipeline: the capture runs through Chat's
  // transport treatment, which is no longer private.
  assert.ok(callSession.includes("ChatModel.transportPhotoData(rawImageData)"));
  assert.ok(chatView.includes("nonisolated static func transportPhotoData"));
  assert.ok(!chatView.includes("private static func transportPhotoData"));
  // The entry exists before anything is dispatched, and a
  // new call clears the last call's entries.
  assert.ok(callSession.includes("struct CallPhotoEntry: Identifiable"));
  assert.ok(callSession.includes("@Published private(set) var photoEntries: [CallPhotoEntry] = []"));
  assert.ok(callSession.includes("photoEntries = []"));
  // On-device: never dispatched; the established honest
  // line is the entry's note AND the spoken line — the
  // same string Chat stamps, pinned on both surfaces.
  assert.ok(callSession.includes(`note: "${HONEST_LINE}"`));
  assert.ok(callSession.includes(`canned: "${HONEST_LINE}"`));
  assert.ok(chatView.includes(HONEST_LINE), "chat carries the same honest line");
  assert.ok(callSession.includes('transcript: "[Photo]"'),
    "the spoken turn is recorded as a photo, chat's placeholder convention");
  // Core: the established note, and a refusal rewrites it.
  assert.ok(callSession.includes(`note: "${CORE_NOTE}"`));
  assert.ok(chatView.includes(CORE_NOTE), "chat carries the same Core note");
  assert.ok(callSession.includes('"The photo wasn\'t sent — \\(result.detail)"'));
  assert.ok(callSession.includes("func notePhotoProblem(_ note: String)"));
  // The transcript panel renders the entries at their
  // anchors and scrolls for them.
  assert.ok(callView.includes("call.photoEntries.filter { $0.turnAnchor == index }"));
  assert.ok(callView.includes("call.photoEntries.filter { $0.turnAnchor >= call.turns.count }"));
  assert.ok(callView.includes("private func photoEntryRow(_ entry: CallPhotoEntry)"));
  assert.ok(callView.includes(".onChange(of: call.photoEntries.count)"));
});

test("camera: the wire — the photo rides the voice transcript post as a chat photo does", () => {
  assert.ok(client.includes("func voiceSessionTranscript(sessionId: String, text: String, images: [Data] = [])"));
  assert.ok(client.includes('"mediaType": "image/jpeg", "data": $0.base64EncodedString()'));
  // The panel contract carries images to the session
  // service, and the turn record carries the count back.
  assert.ok(panelTypes.includes("images?: PanelChatImageData[]"));
  assert.ok(panelTypes.includes("photos?: number"));
  assert.ok(main.includes("voiceSessions.submitTranscript(sessionId, text, images)"));
  assert.ok(main.includes("photos: t.photos"));
});
