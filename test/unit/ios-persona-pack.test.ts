/**
 * v0.31.0: the persona pack pins. v0.32.0: the polish pins.
 *
 * What is pinned here:
 *  - LocalBrain.personaStarters carries exactly the six
 *    starters of the consolidated roster (v0.32.0: the
 *    email helper, injection shield, and everyday assistant
 *    folded into the one Gus persona; the therapist is male
 *    now), each with a Kokoro voice that EXISTS in the
 *    app's catalog (Shared/KokoroTTS.swift) — a persona
 *    pointing at a voice the engine doesn't have would
 *    fail silently in the picker and loudly nowhere.
 *  - The persona mouth centers are the v0.32.0 MEASURED
 *    ones (vision-grounded in full art, converted into
 *    crop space) — the v0.31.0 eyeballed values let the
 *    doctor's flap sit visibly off her mouth.
 *  - The pick is observable: LocalBrain.customPrompt's
 *    setter reports to PersonaSelection, one display-name
 *    derivation (activeDisplayName) serves every surface,
 *    and the call screen shows that name under the face —
 *    the v0.31.0 lag (name stale until an unrelated
 *    redraw) and the nameless call screen are the defects
 *    these pins guard.
 *  - The tab bar is pinned visible: every RootView tab
 *    root asserts it, and the TabView refuses the iOS 26
 *    contextual minimize — the 0.30.0+ vanishing bar.
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
const rootView = readFileSync(join(root, "apps/ios/App/RootView.swift"), "utf8");

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

test("personas: exactly six starters — the consolidated roster", () => {
  const block = startersBlock();
  const ids = [...block.matchAll(/PersonaStarter\(\s*id: "([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(ids, [
    "gus",
    "therapist",
    "ai-doctor",
    "ai-priest",
    "debbie-downer",
    "devil",
  ]);
  // The retired three are gone from the shelf (a saved
  // prompt in their words now reads as Custom — the app
  // never rewrites the operator's saved text to fit).
  for (const retired of ["email-helper", "injection-shield", "everyday-assistant"]) {
    assert.ok(!block.includes(`id: "${retired}"`), `${retired} must be retired`);
  }
  // And their portraits left the build with them.
  assert.ok(
    buildIpa.includes("for PERSONA_FACE in Priest Devil Therapist Debbie Doctor"),
    "build-ipa.sh decodes exactly the five surviving portraits",
  );
});

test("personas: every declared voice exists in the Kokoro catalog", () => {
  const catalog = new Set(
    [...kokoroTTS.matchAll(/KokoroVoice\(id: "([^"]+)"/g)].map((m) => m[1]),
  );
  assert.ok(catalog.size >= 8, "the catalog should carry the full voice list");
  const block = startersBlock();
  const voices = [...block.matchAll(/voiceID: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(voices.length, 6, "every starter declares a voice");
  for (const voice of voices) {
    assert.ok(catalog.has(voice), `persona voice ${voice} is not in the catalog`);
  }
  // The mapping's load-bearing picks (v0.32.0 lock-in):
  // Gus keeps the default feel (af_heart); the therapist is
  // a warm MALE now (am_michael — distinct from the
  // priest's bm_george and the Devil's am_puck); the Devil
  // moved to am_puck; Debbie moved off the doctor's
  // af_bella to af_nicole, so no two personas share a voice.
  const byId = new Map(
    [...block.matchAll(/id: "([^"]+)"[\s\S]*?voiceID: "([^"]+)"/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  assert.equal(byId.get("gus"), "af_heart");
  assert.equal(byId.get("therapist"), "am_michael");
  assert.equal(byId.get("devil"), "am_puck");
  assert.equal(byId.get("debbie-downer"), "af_nicole");
  assert.equal(byId.get("ai-doctor"), "af_bella");
  assert.equal(new Set(voices).size, 6, "no two personas share a voice");
  assert.notEqual(byId.get("devil"), byId.get("ai-priest"));
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
  assert.equal(unpaired, 5, "the other five starters ride the active brain");
});

const PERSONA_FACES = ["Priest", "Devil", "Therapist", "Debbie", "Doctor"];

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

test("mouths: the v0.32.0 measured centers, converted into crop space", () => {
  // Ground truth (full-art fractions, vision-measured):
  // priest (0.505, 0.618), devil (0.500, 0.685),
  // debbie (0.503, 0.605), doctor (0.532, 0.597),
  // therapist-male (0.505, 0.603). In crop space each is
  // (measured − cropOrigin) / cropSide against that face's
  // own window — the values pinned here are those
  // conversions, so a future "eyeball" can't silently
  // drift the flap off the mouth again.
  const block = startersBlock();
  // Parse per starter chunk — a whole-block lazy match
  // would hand the therapist's mouth to Gus (his face is
  // the stock .boy, with no constants of its own inline).
  const mouths = new Map<string, [number, number]>();
  for (const chunk of block.split("PersonaStarter(").slice(1)) {
    const id = /id: "([^"]+)"/.exec(chunk)?.[1];
    const mouth = /mouthCenterX: ([\d.]+), mouthCenterY: ([\d.]+)/.exec(chunk);
    if (id && mouth) mouths.set(id, [Number(mouth[1]), Number(mouth[2])]);
  }
  assert.deepEqual(mouths.get("ai-priest"), [0.5, 0.785]);
  assert.deepEqual(mouths.get("devil"), [0.543, 0.864]);
  assert.deepEqual(mouths.get("debbie-downer"), [0.505, 0.784]);
  assert.deepEqual(mouths.get("ai-doctor"), [0.52, 0.778]);
  assert.deepEqual(mouths.get("therapist"), [0.516, 0.795]);
});

test("pick: observable, one display-name derivation, named call screen", () => {
  // The setter reports every write — the single funnel
  // both writers (picker, Settings editor) already use.
  assert.ok(localBrain.includes("PersonaSelection.notePromptChanged()"));
  assert.ok(localBrain.includes("final class PersonaSelection: ObservableObject"));
  // One derivation for who is on: starter name, "Gus" for
  // the no-persona state, "Custom" for edited words.
  assert.ok(localBrain.includes("static var activeDisplayName"));
  // The call screen shows that name under the face.
  assert.ok(callView.includes("Text(LocalBrain.activeDisplayName)"));
  // The surfaces that show the persona observe the pick:
  // Chat, the call screen, the picker, the shared avatar.
  const picker = readFileSync(
    join(root, "apps/ios/App/PersonaPickerView.swift"),
    "utf8",
  );
  const chat = readFileSync(join(root, "apps/ios/App/ChatView.swift"), "utf8");
  for (const [surface, src] of [
    ["picker", picker],
    ["chat", chat],
    ["call", callView],
  ] as const) {
    assert.ok(
      src.includes("PersonaSelection.shared"),
      `${surface} must observe PersonaSelection`,
    );
  }
});

test("flap: the mouth follows a smoother, not the raw level", () => {
  assert.ok(callView.includes("private final class MouthFlap"));
  assert.ok(callView.includes("flap.advance(toward:"));
  // Shorter travel than v0.31.0's 0.085 and a softened
  // patch (blur + lower opacity) — the polish, pinned so
  // it isn't quietly reverted.
  assert.ok(callView.includes("eased * 0.058"));
  assert.ok(callView.includes(".blur(radius:"));
});

test("tab bar: pinned visible on every root, minimize refused", () => {
  const assertions = rootView.match(/\.toolbar\(\.visible, for: \.tabBar\)/g) ?? [];
  assert.equal(assertions.length, 5, "one visibility assertion per tab root");
  assert.ok(rootView.includes("tabBarMinimizeBehavior(.never)"));
  assert.ok(rootView.includes("if #available(iOS 26.0, *)"));
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
