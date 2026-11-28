/**
 * v0.31.0: the persona pack pins. v0.32.0: the polish pins.
 * v0.33.0: the voice pack + conversation-quality pins.
 *
 * What is pinned here:
 *  - LocalBrain.personaStarters carries exactly the seven
 *    starters of the consolidated roster (v0.32.0: the
 *    email helper, injection shield, and everyday assistant
 *    folded into the one Gus persona; the therapist is male
 *    now) plus the restored Agent Shield (v0.46.0: the
 *    dedicated security persona back as a first-class
 *    starter, second on the shelf, with the catalog widened
 *    by am_onyx so he has a male voice of his own), each with a Kokoro voice that EXISTS in the
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

test("personas: the Secret Agent — stable id, new name, suave security prompt (v0.47.0)", () => {
  const block = startersBlock();
  // The id MUST NOT change: memory buckets, voice
  // assignments, and personaContext all key off it.
  const start = block.indexOf('id: "agent-shield"');
  assert.ok(start >= 0, "the agent-shield starter is still on the shelf");
  const end = block.indexOf("PersonaStarter(", start);
  const entry = block.slice(start, end > start ? end : undefined);
  assert.ok(entry.includes('name: "Secret Agent"'), "he answers to Secret Agent now");
  assert.ok(!entry.includes('name: "Agent Shield"'), "the old display name is gone from the starter");
  assert.ok(entry.includes('voiceID: "am_onyx"'), "the voice does not move with the name");
  // The flavor: 1960s secret agent — dry wit, mission
  // language, cool under pressure.
  for (const flavor of ["Suave", "dry-witted", "cool under pressure", "mission", "brief"]) {
    assert.ok(entry.includes(flavor), `the prompt carries the flavor: ${flavor}`);
  }
  // The job does not move: plain-words security help,
  // paste anything suspicious, the receipt in the
  // Shield tab.
  for (const job of ["Shield checks for", "receipt in the Shield tab", "hand you"]) {
    assert.ok(entry.includes(job), `the prompt keeps the job: ${job}`);
  }
  // The word "demo" appears nowhere in his entry.
  assert.ok(!/demo/i.test(entry), "no 'demo' in the Secret Agent's starter entry");
  // The preview line wears the new name too.
  assert.ok(
    localBrain.includes(
      'return "Secret Agent, at your service — hand me anything that looks off and I\'ll check it."',
    ),
  );
});

test("personas: exactly seven starters — the consolidated roster plus Agent Shield", () => {
  const block = startersBlock();
  const ids = [...block.matchAll(/PersonaStarter\(\s*id: "([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(ids, [
    "gus",
    "agent-shield",
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
    buildIpa.includes("for PERSONA_FACE in Priest Devil Therapist Debbie Doctor Shield"),
    "build-ipa.sh decodes exactly the six surviving portraits",
  );
});

test("personas: every declared voice exists in the Kokoro catalog", () => {
  const catalog = new Set(
    [...kokoroTTS.matchAll(/KokoroVoice\(id: "([^"]+)"/g)].map((m) => m[1]),
  );
  assert.ok(catalog.size >= 9, "the catalog should carry the full voice list");
  const block = startersBlock();
  const voices = [...block.matchAll(/voiceID: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(voices.length, 7, "every starter declares a voice");
  for (const voice of voices) {
    assert.ok(catalog.has(voice), `persona voice ${voice} is not in the catalog`);
  }
  // The mapping's load-bearing picks (v0.33.0 lock-in,
  // Glenn's calls after hearing the v0.32.0 roster):
  // Gus takes am_michael — the boy's face with af_heart's
  // female voice was the mismatch he named; the Devil
  // takes bm_george, the deep British voice he picked;
  // the Priest yields George to am_fenrir, the catalog's
  // other deep male; the Therapist yields Michael to
  // am_puck, the one male left. Debbie keeps af_nicole
  // (moved off the doctor's af_bella in v0.32.0), the
  // doctor keeps af_bella — no two personas share a voice.
  // v0.46.0: Agent Shield takes am_onyx, the deep male
  // voice the catalog was widened by one to give him —
  // the four male voices it carried were all assigned.
  const byId = new Map(
    [...block.matchAll(/id: "([^"]+)"[\s\S]*?voiceID: "([^"]+)"/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  assert.equal(byId.get("gus"), "am_michael");
  assert.equal(byId.get("agent-shield"), "am_onyx");
  assert.equal(byId.get("therapist"), "am_puck");
  assert.equal(byId.get("devil"), "bm_george");
  assert.equal(byId.get("ai-priest"), "am_fenrir");
  assert.equal(byId.get("debbie-downer"), "af_nicole");
  assert.equal(byId.get("ai-doctor"), "af_bella");
  assert.equal(new Set(voices).size, 7, "no two personas share a voice");
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
  assert.equal(unpaired, 6, "the other six starters ride the active brain");
});

const PERSONA_FACES = ["Priest", "Devil", "Therapist", "Debbie", "Doctor", "Shield"];

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
  // v0.39.0: the persona branch also passes the active
  // memory bucket's persona id (the demo pitch passes
  // none — see ios-persona-memory.test.ts).
  assert.ok(localBrain.includes("return composedPrompt(emailDemoPrompt)"));
  assert.ok(localBrain.includes("composedPrompt(customPrompt ?? generalPrompt,"));
  // The block's jobs, in its own words: short by default,
  // conversational, the person can ask for more detail —
  // and (v0.33.0) anti-template: no repeated stock phrases.
  const blockStart = localBrain.indexOf("static let styleBlock");
  const block = localBrain.slice(blockStart, blockStart + 1600);
  assert.match(block, /short/i);
  assert.match(block, /conversation/i);
  assert.match(block, /deeper|more detail/i);
  assert.match(block, /stock phrases/i);
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
  // therapist-male (0.505, 0.603), agent-shield-male
  // (0.491, 0.634) (v0.46.0). In crop space each is
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
  assert.deepEqual(mouths.get("agent-shield"), [0.487, 0.859]);
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
  // v0.35.0: four roots — Settings left the tab bar for
  // Chat's hamburger menu (the hub pins live in
  // ios-shield-hub.test.ts).
  assert.equal(assertions.length, 4, "one visibility assertion per tab root");
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

test("voices: the no-pick default is the male voice (v0.33.0)", () => {
  // Gus IS the no-persona state (his name, the boy's
  // face), and Glenn's verdict was that the boy's face
  // with the female Heart voice is a mismatch — so the
  // never-picked fallback moved to Michael. A saved pick
  // still wins (the getter reads the key first).
  assert.ok(
    kokoroTTS.includes('KokoroVoice(id: "am_michael", displayName: "Michael — male (default)")'),
    "Michael carries the (default) marker in the catalog",
  );
  assert.ok(
    kokoroTTS.includes('?? all.first(where: { $0.id == "am_michael" })'),
    "the selected getter falls back to am_michael",
  );
  assert.ok(
    !kokoroTTS.includes('displayName: "Heart — female (default)")'),
    "Heart no longer claims the default marker",
  );
});

test("previews: real synthesis in a named voice, its own player, never in a call", () => {
  // The named-voice synthesis is the runtime's own path —
  // same manager, same gate — so a preview sounds like a
  // call in that voice because it IS the call's synthesis.
  assert.ok(kokoroTTS.includes("func synthesize(_ text: String, voice voiceID: String)"));
  assert.ok(kokoroTTS.includes("final class VoicePreviewPlayer: ObservableObject"));
  // Its own KokoroPlayer (private engine) — never the
  // call's shared graph, prime, or shim path.
  assert.ok(kokoroTTS.includes("private let player = KokoroPlayer()"));
  // The call-live guard lives in both the player and the
  // button, and CallSession keeps the flag.
  assert.ok(kokoroTTS.includes("guard !CallSession.isAnyCallLive else { return }"));
  assert.ok(callSession.includes("static private(set) var isAnyCallLive = false"));
  assert.ok(callSession.includes("Self.isAnyCallLive = true"));
  assert.ok(callSession.includes("Self.isAnyCallLive = false"));
  // Every voice list carries the audition: Settings'
  // rows and the Personas voice card share VoiceChoiceRow,
  // and the preview button hides while a call is live.
  const settings = readFileSync(
    join(root, "apps/ios/App/SettingsView.swift"),
    "utf8",
  );
  const picker = readFileSync(
    join(root, "apps/ios/App/PersonaPickerView.swift"),
    "utf8",
  );
  assert.ok(settings.includes("VoiceChoiceRow("), "Settings voices are previewable rows");
  assert.ok(settings.includes("voicePreviewLine(voice)"));
  assert.ok(picker.includes("VoiceChoiceRow("), "the persona voice card is previewable rows");
  assert.ok(picker.includes("struct VoicePreviewButton: View"));
  assert.ok(picker.includes("if !CallSession.isAnyCallLive"));
  // Previewing must not select: the player's toggle never
  // writes the persisted pick.
  const playerStart = kokoroTTS.indexOf("final class VoicePreviewPlayer");
  const playerBlock = kokoroTTS.slice(playerStart);
  assert.ok(
    !playerBlock.includes("KokoroVoice.selected ="),
    "a preview never changes the selected voice",
  );
});

test("persona voices: per-persona assignment storage, defaults as fallback", () => {
  assert.ok(kokoroTTS.includes("enum PersonaVoiceAssignment"));
  assert.ok(kokoroTTS.includes('"gus.voice.persona.\\(id)"'));
  // A starter's effective voice is assignment-or-shipped,
  // and the picker applies the effective one on a pick.
  assert.ok(localBrain.includes("var assignedVoiceID: String"));
  assert.ok(localBrain.includes("PersonaVoiceAssignment.voiceID(forPersona: id) ?? voiceID"));
  const picker = readFileSync(
    join(root, "apps/ios/App/PersonaPickerView.swift"),
    "utf8",
  );
  assert.ok(picker.includes("starter.assignedVoiceID"));
  assert.ok(picker.includes("PersonaVoiceAssignment.setVoiceID(voice.id, forPersona: starter.id)"));
  assert.ok(picker.includes("PersonaVoiceAssignment.setVoiceID(nil, forPersona: starter.id)"));
  // Each persona has its own preview line to audition with.
  assert.ok(localBrain.includes("var previewLine: String"));
});

test("session style: rotation, suppression, and stance live at composition", () => {
  assert.ok(localBrain.includes("final class PersonaSessionStyle"));
  // Composition appends the session's lines after the
  // standing block — one composition path, as before.
  assert.ok(localBrain.includes("PersonaSessionStyle.composedAppendix()"));
  assert.ok(localBrain.includes("static func noteUserTurn"));
  assert.ok(localBrain.includes("static func noteReply"));
  // The offer's discipline, in the state's own words:
  // suppression exists, and the offer text tells the model
  // to phrase it in its own words.
  assert.ok(localBrain.includes("offersSuppressed"));
  assert.ok(localBrain.includes("Phrase the"));
  assert.ok(localBrain.includes("never the same wording twice"));
  // The holders report through the two doors: chat
  // (answers + debate), the call (answers), and the
  // session boundaries reset (call connect, debate start).
  const chat = readFileSync(join(root, "apps/ios/App/ChatView.swift"), "utf8");
  assert.ok(chat.includes("PersonaSessionStyle.noteUserTurn(text)"));
  assert.ok(chat.includes("PersonaSessionStyle.noteReply(reply)"));
  assert.ok(chat.includes("PersonaSessionStyle.noteReply(replies)"));
  assert.ok(chat.includes("PersonaSessionStyle.reset()"));
  assert.ok(callSession.includes("PersonaSessionStyle.reset()"));
  assert.ok(callSession.includes("PersonaSessionStyle.noteUserTurn(text)"));
  assert.ok(callSession.includes("PersonaSessionStyle.noteReply(reply)"));
});
