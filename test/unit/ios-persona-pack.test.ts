/**
 * v0.31.0: the persona pack pins.
 *
 * What is pinned here:
 *  - LocalBrain.personaStarters carries exactly the eight
 *    starters (the Devil joined in v0.31.0), each with a
 *    Kokoro voice that EXISTS in the app's catalog
 *    (Shared/KokoroTTS.swift) — a persona pointing at a
 *    voice the engine doesn't have would fail silently in
 *    the picker and loudly nowhere.
 *  - Brain pairing: exactly ONE starter pairs with a brain
 *    (the Devil → the Most open brain), and the id it names
 *    is a real entry in the Swift model manifest — a typo'd
 *    pairing would never offer the download or the switch.
 *  - Every persona portrait rides the repo as a base64
 *    master that decodes to a 1024×1024 PNG, its imageset
 *    Contents.json names that PNG, and build-ipa.sh decodes
 *    every one of them (the established v0.20.0 pattern) —
 *    a portrait that isn't decoded at build time is a
 *    missing face on the call screen.
 *  - The shared style block lives at the prompt-composition
 *    layer (one place: composedPrompt over activePrompt),
 *    not pasted into the starters.
 *  - Calls continue in the background: the Info.plist
 *    declares the audio background mode (in place — the
 *    plist must never move into the synchronized group).
 *  - The speaker route has ONE owner in CallSession
 *    (applySelectedRoute) and the call screen carries the
 *    system route picker; the button's face follows the
 *    actual route (outputRouteIsSpeaker), not the toggle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const localBrain = readFileSync(
  join(root, "apps/ios/Shared/LocalBrain.swift"),
  "utf8",
);
const kokoroTTS = readFileSync(
  join(root, "apps/ios/Shared/KokoroTTS.swift"),
  "utf8",
);
const modelManifest = readFileSync(
  join(root, "apps/ios/Shared/ModelManifest.swift"),
  "utf8",
);
const buildIpa = readFileSync(
  join(root, "hosts/ios-app/build-ipa.sh"),
  "utf8",
);
const infoPlist = readFileSync(join(root, "apps/ios/Info.plist"), "utf8");
const callSession = readFileSync(
  join(root, "apps/ios/Shared/CallSession.swift"),
  "utf8",
);
const callView = readFileSync(join(root, "apps/ios/App/CallView.swift"), "utf8");

/** The personaStarters array literal, sliced out of the
 *  Swift source so the starter pins below read the
 *  definitions themselves, not lookalike strings elsewhere
 *  in the file. */
function startersBlock(): string {
  const start = localBrain.indexOf("static let personaStarters");
  assert.ok(start >= 0, "personaStarters not found in LocalBrain.swift");
  const end = localBrain.indexOf("\n    ]", start);
  assert.ok(end > start, "personaStarters array end not found");
  return localBrain.slice(start, end);
}

test("personas: exactly eight starters, the Devil among them", () => {
  const block = startersBlock();
  const ids = [...block.matchAll(/PersonaStarter\(\s*id: "([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(ids, [
    "email-helper",
    "injection-shield",
    "everyday-assistant",
    "therapist",
    "ai-doctor",
    "ai-priest",
    "debbie-downer",
    "devil",
  ]);
});

test("personas: every declared voice exists in the Kokoro catalog", () => {
  const catalog = new Set(
    [...kokoroTTS.matchAll(/KokoroVoice\(id: "([^"]+)"/g)].map((m) => m[1]),
  );
  assert.ok(catalog.size >= 8, "the catalog should carry the full voice list");
  const block = startersBlock();
  const voices = [...block.matchAll(/voiceID: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(voices.length, 8, "every starter declares a voice");
  for (const voice of voices) {
    assert.ok(catalog.has(voice), `persona voice ${voice} is not in the catalog`);
  }
  // The mapping's load-bearing picks: the default feel stays
  // af_heart, the therapist stays bf_emma, and the Devil's
  // sly male differs from the priest's calm one.
  const byId = new Map(
    [...block.matchAll(/id: "([^"]+)"[\s\S]*?voiceID: "([^"]+)"/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  assert.equal(byId.get("everyday-assistant"), "af_heart");
  assert.equal(byId.get("therapist"), "bf_emma");
  assert.equal(byId.get("devil"), "am_michael");
  assert.notEqual(byId.get("devil"), byId.get("ai-priest"));
  assert.notEqual(byId.get("ai-doctor"), byId.get("therapist"));
});

test("personas: only the Devil pairs with a brain, and it is a real manifest entry", () => {
  const block = startersBlock();
  const paired = [...block.matchAll(/pairedBrainID: "([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(paired.length, 1, "exactly one starter pairs with a brain");
  assert.equal(
    paired[0],
    "brain-qwen3-4b-instruct-2507-hauhaucs-aggressive-q4km",
  );
  assert.ok(
    modelManifest.includes(`id: "${paired[0]}"`),
    "the Devil's paired brain must exist in ModelManifest.swift",
  );
  const unpaired = [...block.matchAll(/pairedBrainID: nil/g)].length;
  assert.equal(unpaired, 7, "the other seven starters ride the active brain");
});

const PERSONA_FACES = [
  "Priest",
  "Devil",
  "Therapist",
  "Debbie",
  "Doctor",
  "Email",
  "Shield",
];

for (const face of PERSONA_FACES) {
  test(`portraits: Avatar${face} master decodes to a 1024×1024 PNG and is built`, () => {
    const dir = join(
      root,
      `apps/ios/App/Assets.xcassets/Avatar${face}.imageset`,
    );
    const contents = JSON.parse(
      readFileSync(join(dir, "Contents.json"), "utf8"),
    );
    assert.equal(contents.images[0].filename, `Avatar${face}.png`);
    const png = Buffer.from(
      readFileSync(join(dir, `Avatar${face}.png.b64`), "utf8").trim(),
      "base64",
    );
    // PNG signature + IHDR width/height (big-endian at 16/20).
    assert.deepEqual(
      [...png.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      "the master must decode to a PNG",
    );
    assert.equal(png.readUInt32BE(16), 1024, "portrait width");
    assert.equal(png.readUInt32BE(20), 1024, "portrait height");
    assert.ok(
      buildIpa.includes(face),
      `build-ipa.sh must decode the ${face} portrait`,
    );
  });
}

test("style: one shared style block at the composition layer", () => {
  assert.ok(localBrain.includes("static let styleBlock"));
  assert.ok(localBrain.includes("static func composedPrompt"));
  // activePrompt's precedence survives composition: demo
  // pitch first, then the persona prompt, then general —
  // and every branch goes through composedPrompt.
  assert.ok(localBrain.includes("return composedPrompt(emailDemoPrompt)"));
  assert.ok(localBrain.includes("composedPrompt(customPrompt ?? generalPrompt)"));
  // The block's three jobs, in its own words: short by
  // default, conversational, and the occasional depth offer.
  const blockStart = localBrain.indexOf("static let styleBlock");
  const block = localBrain.slice(blockStart, blockStart + 1600);
  assert.match(block, /short/i);
  assert.match(block, /conversation/i);
  assert.match(block, /deeper|more detail/i);
});

test("background calls: the plist declares the audio background mode", () => {
  assert.ok(infoPlist.includes("<key>UIBackgroundModes</key>"));
  const modes = infoPlist.slice(
    infoPlist.indexOf("<key>UIBackgroundModes</key>"),
  );
  assert.ok(
    modes.slice(0, 200).includes("<string>audio</string>"),
    "audio must be a declared background mode",
  );
});

test("routes: one owner in CallSession, the picker on the call screen", () => {
  assert.ok(callSession.includes("private func applySelectedRoute()"));
  assert.ok(callSession.includes("var outputRouteIsSpeaker"));
  // The reassertion points route through the owner rather
  // than writing overrides of their own: no direct
  // overrideOutputAudioPort call survives outside it.
  const directWrites =
    callSession.match(/overrideOutputAudioPort/g) ?? [];
  assert.equal(
    directWrites.length,
    1,
    "applySelectedRoute is the only overrideOutputAudioPort call site",
  );
  assert.ok(callView.includes("AVRoutePickerView"));
  assert.ok(callView.includes("call.outputRouteIsSpeaker"));
});
