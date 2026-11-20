/**
 * v0.15.0 chunk 2 (R4 M1): the on-device model delivery pins.
 *
 * What is pinned here:
 *  - apps/ios/Models/manifest.json is well-formed: every
 *    app-downloaded weight carries a pinned https URL, a
 *    sha256, and a byte size (weights never ride git; the app
 *    downloads them on first launch and verifies before use).
 *  - The Swift manifest the app actually reads
 *    (Shared/ModelManifest.swift) embeds the SAME url, sha256,
 *    and byte size for the brain — the JSON is the record, the
 *    Swift is the runtime copy, and they must not drift.
 *  - The Xcode project pins its two inference packages exact:
 *    FluidAudio (Kokoro on CoreML) and LLM.swift (llama.cpp),
 *    so a build never floats to an unreviewed runtime.
 *  - The Kokoro engine's availability is gated on the real
 *    runtime's readiness — the chunk-1 stub (isAvailable
 *    hard-coded false) must not come back, and neither may a
 *    fake true: the gate is KokoroRuntime.shared.isReady.
 *  - The Swift spoken-form port carries the same whole-notice
 *    lines as the core's spoken-form.ts (the copy must not
 *    quietly diverge from the original's words).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const manifest = JSON.parse(
  readFileSync(join(root, "apps/ios/Models/manifest.json"), "utf8"),
);
const swiftManifest = readFileSync(
  join(root, "apps/ios/Shared/ModelManifest.swift"),
  "utf8",
);
const pbxproj = readFileSync(
  join(root, "apps/ios/GUS.xcodeproj/project.pbxproj"),
  "utf8",
);
const speechEngine = readFileSync(
  join(root, "apps/ios/Shared/SpeechEngine.swift"),
  "utf8",
);
const spokenFormSwift = readFileSync(
  join(root, "apps/ios/Shared/SpokenForm.swift"),
  "utf8",
);
const spokenFormTs = readFileSync(
  join(root, "packages/channels/voice/src/spoken-form.ts"),
  "utf8",
);

test("manifest: the brain download is pinned (https, sha256, size)", () => {
  // v0.15.4: the library may carry OPTIONAL alternative
  // brains alongside the one required brain (the abliterated
  // choice is the first). Exactly one entry is required, it
  // stays first, and EVERY entry carries the same pin
  // discipline — no unpinned weight ever joins the list.
  assert.equal(
    manifest.downloads.filter((d: { required: boolean }) => d.required).length,
    1,
    "exactly one required download: the brain",
  );
  for (const d of manifest.downloads) {
    assert.ok(d.url.startsWith("https://"), "download URL must be https");
    assert.match(d.sha256, /^[0-9a-f]{64}$/);
    assert.ok(d.fileName.endsWith(".gguf"));
    assert.ok(d.bytes > 1_000_000_000, "a 4B Q4_K_M GGUF is ~2.5 GB");
  }
  const brain = manifest.downloads[0];
  assert.equal(brain.required, true);
});

test("manifest: the Kokoro assets are inventoried as SDK-managed", () => {
  assert.equal(manifest.sdkManaged.length, 1);
  const kokoro = manifest.sdkManaged[0];
  assert.equal(kokoro.repository, "FluidInference/kokoro-82m-coreml");
  assert.ok(kokoro.files.length >= 90, "the ANE chain + G2P inventory");
  assert.ok(kokoro.totalBytes > 250_000_000, "~294 MB of CoreML assets");
  for (const f of kokoro.files) {
    assert.ok(f.url.startsWith("https://huggingface.co/"), f.path);
    assert.ok(f.bytes > 0, f.path);
  }
});

test("manifest <-> Swift: the embedded brain entry matches the record", () => {
  const brain = manifest.downloads[0];
  assert.ok(
    swiftManifest.includes(brain.url),
    "ModelManifest.swift must embed the manifest URL",
  );
  assert.ok(
    swiftManifest.includes(brain.sha256),
    "ModelManifest.swift must embed the manifest sha256",
  );
  const grouped = brain.bytes
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  assert.ok(
    swiftManifest.includes(grouped),
    "ModelManifest.swift must embed the manifest byte size",
  );
  assert.ok(swiftManifest.includes(brain.fileName));
});

test("project: inference packages are pinned exact", () => {
  assert.ok(
    pbxproj.includes("https://github.com/FluidInference/FluidAudio"),
  );
  assert.ok(pbxproj.includes("https://github.com/eastriverlee/LLM.swift"));
  assert.ok(pbxproj.includes("kind = exactVersion;"));
  assert.ok(pbxproj.includes("version = 0.18.4;"), "FluidAudio pin");
  assert.ok(pbxproj.includes("version = 3.0.3;"), "LLM.swift pin");
});

test("kokoro engine: availability is the runtime's real readiness", () => {
  assert.ok(
    speechEngine.includes("KokoroRuntime.shared.isReady"),
    "KokoroSpeechEngine.isAvailable must read the runtime's readiness",
  );
  const kokoroSection = speechEngine.slice(
    speechEngine.indexOf("final class KokoroSpeechEngine"),
    speechEngine.indexOf("final class StudioVoiceEngine"),
  );
  assert.ok(
    !kokoroSection.includes("isAvailable: Bool { false }"),
    "the chunk-1 stub must not return",
  );
});

test("spoken form: the Swift port carries the original's notice lines", () => {
  for (const line of [
    "I've hit my usage limit for today",
    "That action was blocked by my safety rules",
    "it was withheld because it looked like it contained a secret",
    "That hit a limit on my side",
  ]) {
    assert.ok(spokenFormTs.includes(line), `original carries: ${line}`);
    assert.ok(spokenFormSwift.includes(line), `port carries: ${line}`);
  }
});
