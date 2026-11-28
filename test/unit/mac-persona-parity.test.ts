/**
 * v0.43.0: the Mac persona parity pins.
 *
 * What is pinned here:
 *  - The roster sync: the Mac shelf (hosts/mac-app
 *    Persona.swift) and the iPhone shelf (LocalBrain
 *    .personaStarters) carry the same seven starters in
 *    the same order — ids, names, blurbs, default
 *    voices, preview lines, and the prompt texts
 *    themselves (compared whitespace-normalized, since
 *    the two files indent their literals differently;
 *    the words must be the same words).
 *  - The shared texts: styleBlock and generalPrompt are
 *    the same words in both apps, so the core hears one
 *    house style from either surface.
 *  - Memory discipline: the Mac store uses the same
 *    defaults key, the same caps (20 lines / 1500
 *    characters), and the same block framing header as
 *    the iPhone's PersonaMemoryStore.
 *  - Voice assignments: the same per-persona key shape
 *    (gus.voice.persona.<id>) and the same nine-voice
 *    catalog in both apps (v0.46.0: am_onyx joined for
 *    the restored Agent Shield persona).
 *  - The transport: the Mac submits its composed
 *    persona context through the v0.40.0 field — on
 *    /api/chat bodies, on voice-session start, and as
 *    mid-session context updates — and a pick applies
 *    the persona's voice through the existing
 *    setTtsVoice save.
 *  - The portraits: the Mac's Persona*.png.b64 masters
 *    are byte-identical copies of the iPhone imageset
 *    masters (no new artwork), and build-dmg.sh decodes
 *    them into the bundle.
 *  - The deliberate omissions stay omitted: no
 *    pairedBrainID field on the Mac roster (brain
 *    pairing is the iPhone's on-device concept).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const iosBrain = read("apps/ios/Shared/LocalBrain.swift");
const iosMemory = read("apps/ios/Shared/PersonaMemory.swift");
const iosTTS = read("apps/ios/Shared/KokoroTTS.swift");
const macPersona = read("hosts/mac-app/Sources/GusApp/Persona.swift");
const macViews = read("hosts/mac-app/Sources/GusApp/PersonaViews.swift");
const macModel = read("hosts/mac-app/Sources/GusApp/DesktopModel.swift");
const macClient = read("hosts/mac-app/Sources/GusApp/PanelClient.swift");
const macChat = read("hosts/mac-app/Sources/GusApp/ChatView.swift");
const macSidebar = read("hosts/mac-app/Sources/GusApp/SidebarView.swift");
const dmg = read("hosts/mac-app/build-dmg.sh");

/** The personaStarters array literal, sliced out of a
 * Swift source: from the declaration to the array's
 * closing bracket at four-space indent. */
function rosterBlock(source: string): string {
  const start = source.indexOf("static let personaStarters");
  assert.ok(start >= 0, "personaStarters not found");
  const end = source.indexOf("\n    ]", start);
  assert.ok(end > start, "personaStarters array end not found");
  return source.slice(start, end);
}

/** Whitespace-normalized text of a Swift multiline
 * literal's contents: line continuations removed, all
 * whitespace runs collapsed — the words, comparable
 * across files that indent differently. */
function normalizeLiteral(raw: string): string {
  return raw.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
}

function promptsOf(block: string): string[] {
  return [...block.matchAll(/prompt: """([\s\S]*?)"""/g)].map((m) =>
    normalizeLiteral(m[1]),
  );
}

const iosBlock = rosterBlock(iosBrain);
const macBlock = rosterBlock(macPersona);

test("roster sync: same seven starters, same order, ids/names/blurbs/voices", () => {
  const fields = (block: string, re: RegExp) =>
    [...block.matchAll(re)].map((m) => m[1]);
  const iosIds = fields(iosBlock, /id: "([^"]+)"/g);
  const macIds = fields(macBlock, /id: "([^"]+)"/g);
  assert.deepEqual(macIds, [
    "gus",
    "agent-shield",
    "therapist",
    "ai-doctor",
    "ai-priest",
    "debbie-downer",
    "devil",
  ]);
  assert.deepEqual(macIds, iosIds);
  assert.deepEqual(
    fields(macBlock, /blurb: "([^"]+)"/g),
    fields(iosBlock, /blurb: "([^"]+)"/g),
  );
  assert.deepEqual(
    fields(macBlock, /voiceID: "([^"]+)"/g),
    fields(iosBlock, /voiceID: "([^"]+)"/g),
  );
  // `name:` needs a non-letter boundary so the faces'
  // imageName: lines don't read as names.
  const names = (block: string) =>
    [...block.matchAll(/(?:^|\s)name: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names(macBlock), names(iosBlock));
});

test("roster sync: the prompt texts are the same words", () => {
  const iosPrompts = promptsOf(iosBlock);
  const macPrompts = promptsOf(macBlock);
  assert.equal(macPrompts.length, 7);
  assert.deepEqual(macPrompts, iosPrompts);
});

test("roster sync: preview lines match the iPhone's switch", () => {
  const switchStart = iosBrain.indexOf("var previewLine");
  assert.ok(switchStart >= 0);
  const switchEnd = iosBrain.indexOf("default:", switchStart);
  const iosLines = [
    ...iosBrain.slice(switchStart, switchEnd).matchAll(/return "([^"]+)"/g),
  ].map((m) => m[1]);
  const macLines = [...macBlock.matchAll(/previewLine: "([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(iosLines.length, 7);
  assert.deepEqual(macLines, iosLines);
});

test("shared texts: styleBlock and generalPrompt are the same words", () => {
  const literal = (source: string, name: string) => {
    const m = source.match(
      new RegExp(`static let ${name} = """([\\s\\S]*?)"""`),
    );
    assert.ok(m, `${name} literal not found`);
    return normalizeLiteral(m[1]);
  };
  assert.equal(
    literal(macPersona, "styleBlock"),
    literal(iosBrain, "styleBlock"),
  );
  assert.equal(
    literal(macPersona, "generalPrompt"),
    literal(iosBrain, "generalPrompt"),
  );
});

test("memory: same key, same caps, same framing header", () => {
  assert.ok(macPersona.includes('static let defaultsKey = "gus.personaMemory"'));
  assert.ok(iosMemory.includes('static let defaultsKey = "gus.personaMemory"'));
  assert.ok(macPersona.includes("static let maxLines = 20"));
  assert.ok(macPersona.includes("static let maxBlockCharacters = 1500"));
  const header = (source: string) =>
    source.match(/let header = "([^"]+)"/)?.[1];
  assert.ok(header(macPersona));
  assert.equal(header(macPersona), header(iosMemory));
  assert.ok(macPersona.includes("final class MacPersonaMemoryStore: ObservableObject"));
});

test("voices: same assignment key shape, same nine-voice catalog", () => {
  assert.ok(macPersona.includes('"gus.voice.persona.\\(id)"'));
  assert.ok(iosTTS.includes('"gus.voice.persona.\\(id)"'));
  const iosCatalog = new Set(
    [...iosTTS.matchAll(/KokoroVoice\(id: "([^"]+)"/g)].map((m) => m[1]),
  );
  const macCatalog = new Set(
    [...macPersona.matchAll(/MacKokoroVoice\(id: "([^"]+)"/g)].map((m) => m[1]),
  );
  assert.equal(macCatalog.size, 9);
  assert.deepEqual(macCatalog, iosCatalog);
});

test("transport: the Mac submits personaContext on chat, call start, and updates", () => {
  assert.ok(macModel.includes('body["personaContext"] = context'));
  assert.ok(macModel.includes("func composedPersonaContext() -> String?"));
  assert.ok(
    macModel.includes("startVoiceSession(personaContext: composedPersonaContext())"),
  );
  assert.ok(macClient.includes('"/api/voice/session/context"'));
  assert.ok(macClient.includes('body["personaContext"] = personaContext'));
  assert.ok(macModel.includes("func syncVoiceSessionPersonaContext()"));
});

test("pick and voice: a pick applies prompt + voice; previews use test-speech", () => {
  assert.ok(macModel.includes("func pickPersona(_ starter: MacPersonaStarter?)"));
  assert.ok(macModel.includes("setTtsVoice(starter.assignedVoiceID)"));
  assert.ok(macModel.includes("MacPersona.savedPrompt = starter?.prompt"));
  assert.ok(macModel.includes("func previewPersonaVoice(_ starter: MacPersonaStarter)"));
  assert.ok(macModel.includes("client.testVoiceSpeech("));
  assert.ok(macModel.includes("func setPersonaVoice(_ voiceID: String?, for starter: MacPersonaStarter)"));
});

test("surfaces: strip in Chat, block in Identity, name in the call strip", () => {
  assert.ok(macChat.includes("PersonaStripView(model: model, compact: true)"));
  assert.ok(macChat.includes("with \\(persona.name)"));
  assert.ok(macSidebar.includes("PersonaBlockView(model: model)"));
  assert.ok(macViews.includes("struct PersonaStripView: View"));
  assert.ok(macViews.includes("struct MacPersonaMemoryView: View"));
  // The memory page's honesty copy: the Mac's buckets
  // never sync with the iPhone's.
  assert.ok(macViews.includes("they never sync"));
});

test("portraits: Mac masters are byte-identical to the iPhone's, and ship", () => {
  for (const name of ["Priest", "Therapist", "Doctor", "Debbie", "Devil", "Shield"]) {
    const mac = readFileSync(
      join(root, `hosts/mac-app/Resources/Persona${name}.png.b64`),
    );
    const ios = readFileSync(
      join(
        root,
        `apps/ios/App/Assets.xcassets/Avatar${name}.imageset/Avatar${name}.png.b64`,
      ),
    );
    assert.ok(mac.equals(ios), `Persona${name} master diverged from the iPhone's`);
    assert.ok(macPersona.includes(`imageName: "Persona${name}"`));
  }
  // Gus wears the already-bundled DefaultAvatar — the
  // same art as the iPhone's Avatar master.
  assert.ok(macPersona.includes('imageName: "DefaultAvatar"'));
  assert.ok(dmg.includes("Persona$persona.png.b64"));
  assert.ok(dmg.includes("Persona$persona.png"));
});

test("omissions stay omitted: no brain pairing, no session-style composition", () => {
  assert.ok(!macBlock.includes("pairedBrainID:"));
  // The omission is documented in comments; what must
  // never appear is the composition itself.
  assert.ok(!macPersona.includes("PersonaSessionStyle."));
  assert.ok(!macPersona.includes("composedAppendix"));
});
