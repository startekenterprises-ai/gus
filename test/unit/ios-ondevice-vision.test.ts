/**
 * v0.48.0: on-device vision, baby step 1 — the pins.
 *
 * What is pinned here:
 *  - The curated vision brain is a PAIR in the manifest of
 *    record (model + nested projector, both pinned https /
 *    sha256 / bytes), the Swift manifest embeds the same
 *    pins for BOTH files, and the combined size is the
 *    number the fit gate judges.
 *  - The pair machinery: ModelStore presence/removal is
 *    pair-aware, the projector leg resolves through
 *    GUSModelManifest.entry(id:), ModelLibrary downloads
 *    leg by leg with the combined BrainFit gate at its
 *    door, auto-starts the projector leg when the model
 *    lands, and derives the pair's shown state.
 *  - The engine's isolation: chat reaches vision only
 *    through the VisionDescribing protocol; the engine
 *    reaches llama.cpp only through the GUSVisionShim C
 *    door (bridging header import, mtmd entry points, no
 *    fatalError on the path); NO second llama package or
 *    framework was vendored into the project — the shim
 *    calls the mtmd API inside the llama.framework that
 *    the already-pinned LLM.swift 3.0.3 xcframework
 *    (llama.cpp b10068) carries.
 *  - The routing decision's factors (kill switch + vision
 *    brain active + pair present) and the honest paths'
 *    survival, byte-identical, on both the ordinary and
 *    the incognito dispatch.
 *  - The Settings kill switch: exists, defaults ON, and
 *    its caption carries the never-leaves-the-phone fact.
 *  - The library's not-offered gate for a pair that
 *    doesn't fit this phone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const manifest = JSON.parse(read("apps/ios/Models/manifest.json"));
const swiftManifest = read("apps/ios/Shared/ModelManifest.swift");
const downloader = read("apps/ios/Shared/ModelDownloader.swift");
const visionEngine = read("apps/ios/Shared/VisionEngine.swift");
const shimHeader = read("apps/ios/Shared/GUSVisionShim.h");
const shimImpl = read("apps/ios/Shared/GUSVisionShim.mm");
const playShimHeader = read("apps/ios/Shared/GUSPlayShim.h");
const chatView = read("apps/ios/App/ChatView.swift");
const settingsView = read("apps/ios/App/SettingsView.swift");
const brainViews = read("apps/ios/App/BrainViews.swift");
const pbxproj = read("apps/ios/GUS.xcodeproj/project.pbxproj");

const vision = manifest.downloads.find(
  (d: { id: string }) => d.id === "brain-qwen25-vl-3b-instruct-q4km",
);

test("manifest: the vision brain is a pinned pair, not a lone file", () => {
  assert.ok(vision, "the vision entry exists in manifest.json");
  assert.equal(vision.required, false, "an optional choice, never the required brain");
  assert.equal(
    manifest.downloads.filter((d: { required: boolean }) => d.required).length,
    1,
    "still exactly one required download",
  );
  assert.equal(manifest.downloads[0].id, "brain-qwen3-4b-instruct-2507-q4km",
    "the standard brain stays first");
  assert.ok(vision.url.startsWith("https://huggingface.co/ggml-org/"), "the llama.cpp project's own repo");
  assert.match(vision.sha256, /^[0-9a-f]{64}$/);
  assert.equal(vision.bytes, 1_929_901_056);
  const projector = vision.projector;
  assert.ok(projector, "the entry carries its projector");
  assert.equal(projector.fileName, "mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf");
  assert.ok(projector.url.startsWith("https://huggingface.co/ggml-org/"));
  assert.match(projector.sha256, /^[0-9a-f]{64}$/);
  assert.equal(projector.bytes, 844_757_728);
  assert.equal(
    vision.bytes + projector.bytes,
    2_774_658_784,
    "the combined pair size the fit gate judges",
  );
});

test("manifest <-> Swift: the vision pair's pins match the record, both files", () => {
  for (const pin of [
    vision.url,
    vision.sha256,
    vision.fileName,
    vision.projector.url,
    vision.projector.sha256,
    vision.projector.fileName,
  ]) {
    assert.ok(swiftManifest.includes(pin), `ModelManifest.swift embeds: ${pin}`);
  }
  const grouped = (n: number) =>
    n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  assert.ok(swiftManifest.includes(grouped(vision.bytes)), "model byte size embedded");
  assert.ok(swiftManifest.includes(grouped(vision.projector.bytes)), "projector byte size embedded");
});

test("pair machinery: presence, removal, and leg resolution are pair-aware", () => {
  assert.ok(swiftManifest.includes("struct ProjectorFile"), "the projector has a type");
  assert.ok(swiftManifest.includes('static let projectorLegSuffix = "#mmproj"'), "the leg id scheme");
  assert.ok(swiftManifest.includes("var totalBytes: Int64"), "combined size is a manifest-level fact");
  assert.ok(
    swiftManifest.includes("bytes + (projector?.bytes ?? 0)"),
    "totalBytes is model + projector",
  );
  // isPresent demands the projector file too; remove takes both.
  const store = swiftManifest.slice(swiftManifest.indexOf("enum ModelStore"));
  assert.ok(store.includes("filePresent(fileName: projector.fileName, bytes: projector.bytes)"),
    "isPresent checks the projector file at its pinned size");
  assert.ok(store.includes("projectorURL(for: entry)"), "remove reaches the projector file");
  // The leg resolves through the one entry door.
  assert.ok(swiftManifest.includes("downloads.first(where: { $0.projectorLegID == id })?.projectorLegEntry()"),
    "entry(id:) resolves a projector leg id");
  assert.ok(swiftManifest.includes("projectorLegEntry()"), "the leg dresses as an entry");
  // The vision brain is in the downloads list, last (order matters: first stays the standard brain).
  const downloadsLine = swiftManifest.slice(
    swiftManifest.indexOf("static let downloads"),
    swiftManifest.indexOf("static func entry"),
  );
  assert.ok(downloadsLine.includes("brainVision"), "brainVision joins the library");
});

test("pair downloads: legs, the combined fit gate, and the self-completing pair", () => {
  assert.ok(downloader.includes("private func startLeg"), "one-file downloads are a leg operation");
  assert.ok(
    downloader.includes("BrainFit.fitsOnThisDevice(fileBytes: entry.totalBytes)"),
    "the fit gate judges model + projector combined",
  );
  assert.ok(downloader.includes("private func legLanded"), "a landed leg can complete the pair");
  assert.ok(
    downloader.includes("startLeg(legEntry)"),
    "the model leg landing starts the projector leg",
  );
  assert.ok(
    downloader.includes("startLeg(leg)"),
    "a resumed pair starts with its missing leg",
  );
  // The pair's shown state is derived, and both files verify.
  const stateOf = downloader.slice(
    downloader.indexOf("func state(of entry: ModelDownloadEntry)"),
    downloader.indexOf("private func isDownloading"),
  );
  assert.ok(stateOf.includes("entry.projectorLegID"), "state(of:) reads the projector leg");
  assert.ok(stateOf.includes("ModelStore.isPresent(entry)"), "state(of:) defers to pair presence");
  const verify = downloader.slice(
    downloader.indexOf("func verify(_ entry: ModelDownloadEntry)"),
    downloader.indexOf("// MARK: - Completion"),
  );
  assert.ok(verify.includes("projector.sha256"), "verify hashes the projector too");
});

test("engine isolation: one protocol, one C door, no traps", () => {
  assert.ok(visionEngine.includes("protocol VisionDescribing"), "chat's only door is the protocol");
  assert.ok(visionEngine.includes("final class LlamaVisionEngine: VisionDescribing"));
  assert.ok(visionEngine.includes('DispatchQueue(label: "gus.vision.serial")'),
    "all vision work serializes on one queue");
  assert.ok(visionEngine.includes("static let timeoutSeconds: UInt64 = 240"), "the watchdog is bounded");
  assert.ok(visionEngine.includes("static let maxLongEdge: CGFloat = 768"), "the downscale cap");
  assert.ok(!visionEngine.includes("fatalError"), "no traps on the vision path");
  assert.ok(!visionEngine.includes("LocalBrain("), "the engine never constructs the text path");
  // The C door: two functions, reached through the existing bridging header.
  assert.ok(shimHeader.includes("char *GUSVisionDescribe("), "the one operation");
  assert.ok(shimHeader.includes("void GUSVisionFree("), "its free");
  assert.ok(playShimHeader.includes('#import "GUSVisionShim.h"'),
    "the bridging header carries the vision door");
  for (const symbol of [
    "mtmd_init_from_file",
    "mtmd_helper_bitmap_init_from_buf",
    "mtmd_tokenize",
    "mtmd_helper_eval_chunks",
    "llama_chat_apply_template",
    "llama_sampler_init_greedy",
  ]) {
    assert.ok(shimImpl.includes(symbol), `the shim calls ${symbol}`);
  }
  assert.ok(shimImpl.includes("catch"), "C++ exceptions are contained in the shim");
  assert.ok(shimImpl.includes("@catch"), "ObjC exceptions are contained in the shim");
  assert.ok(!shimImpl.includes("fatalError"), "no traps in the shim");
  // No second llama was vendored: the project gains no new
  // package, and the mtmd surface rides the framework the
  // pinned LLM.swift already embeds.
  assert.ok(!pbxproj.includes("ggml-org"), "no llama.cpp package was added to the project");
  assert.ok(!pbxproj.includes("LlamaVision"), "no wrapper package duplicates the framework");
});

test("routing: the decision's factors, and the honest paths byte-identical", () => {
  const routing = visionEngine.slice(visionEngine.indexOf("enum VisionRouting"));
  assert.ok(routing.includes("VisionSettings.enabled"), "factor 1: the kill switch");
  assert.ok(routing.includes("GUSModelManifest.brainVision.id"), "factor 2: the vision brain is active");
  assert.ok(routing.includes("ModelStore.isPresent(active)"), "factor 3: the pair is on disk");
  // The ordinary dispatch consults routing BEFORE the honest note.
  const dispatch = chatView.slice(
    chatView.indexOf("private func dispatch(exchangeID: UUID, text: String, photo: Data?)"),
    chatView.indexOf("private func setPhotoNote"),
  );
  assert.ok(dispatch.includes("VisionRouting.useVisionEngine()"), "dispatch consults routing");
  assert.ok(
    dispatch.indexOf("VisionRouting.useVisionEngine()") <
      dispatch.indexOf("This brain can't look at photos yet"),
    "routing is asked before the honest note is set",
  );
  // The honest lines survive word for word, in both dispatches.
  assert.ok(chatView.includes(
    "This brain can't look at photos yet — switch to Core to ask about pictures."));
  assert.ok(chatView.includes(
    "Incognito stays on this iPhone, and this brain can't look at photos — the photo wasn't sent anywhere."));
  // Incognito routes through the same decision.
  const incognito = chatView.slice(
    chatView.indexOf("private func dispatchIncognito"),
    chatView.indexOf("// MARK: Debate (v0.31.0)"),
  );
  assert.ok(incognito.includes("VisionRouting.useVisionEngine()"),
    "incognito consults the same routing");
  // The vision turn itself: chained like a text answer,
  // reached only through the protocol, with a default ask.
  assert.ok(chatView.includes("private func dispatchVision"), "the vision dispatch exists");
  assert.ok(chatView.includes("let engine: VisionDescribing = LlamaVisionEngine()"),
    "chat holds the engine by the protocol, never the type's innards");
  assert.ok(chatView.includes("Describe what you see in this photo, briefly."),
    "the default observation prompt");
  // The composer's attached-photo note tells the truth in the vision case.
  assert.ok(chatView.includes(
    "Photo attached — the vision brain will look at it right here on this iPhone."));
  assert.ok(chatView.includes(
    "Photo attached — photos need Core mode; this brain can't see pictures."),
    "and keeps the old words when it can't see");
});

test("kill switch: exists in Settings, defaults on, caption carries the privacy fact", () => {
  assert.ok(visionEngine.includes('static let defaultsKey = "gus.vision.onDevice"'));
  assert.ok(visionEngine.includes("as? Bool ?? true"), "absent key means ON");
  assert.ok(settingsView.includes('Toggle("On-device vision", isOn: $onDeviceVision)'),
    "the Settings toggle");
  assert.ok(settingsView.includes("VisionSettings.enabled = newValue"), "the toggle writes the setting");
  assert.ok(settingsView.includes("never leaves it"),
    "the caption states the photo never leaves the phone");
});

test("library gate: a pair that doesn't fit this phone is not offered", () => {
  assert.ok(
    brainViews.includes("BrainFit.fitsOnThisDevice(fileBytes: entry.totalBytes)"),
    "the row judges the pair by its combined size",
  );
  assert.ok(brainViews.includes("isn't offered here"), "the plain not-offered line");
});
