/**
 * v0.44.0: the custom-persona pins (roadmap item 14 —
 * customize personas, create your own; sharing is a
 * later build and is NOT here).
 *
 * What is pinned here:
 *  - Starter edits are OVERRIDES: one defaults key per
 *    starter id (gus.personaPromptOverride.<id>), and
 *    PersonaStarter.effectivePrompt is override ?? shipped.
 *    The shipped literals in personaStarters are never
 *    rewritten at runtime — the Mac roster parity test
 *    reads those literals from SOURCE, so runtime state
 *    cannot disturb it (and this file pins that the
 *    parity test does read sources).
 *  - The whole shelf is a COMPUTED pool: allPersonas =
 *    personaStarters + the created personas vended as
 *    starters. Identity resolution (activeStarter, the
 *    starter-by-id door) reads the pool and matches on
 *    effective words — so a created persona resolves its
 *    face, name, voice, and memory bucket through the
 *    exact derivations the shipped six use, and an edited
 *    starter keeps its identity.
 *  - Created personas persist as Codable JSON under
 *    gus.personas.custom with custom- ids; the store
 *    trims name/words on write (identity is a text match
 *    against a pick store that trims on read); deleting
 *    one forgets its memory bucket and clears its voice
 *    assignment — no orphaned state.
 *  - Faces are borrowed, never uploaded: the catalog is
 *    the stock pair plus the starters' portraits, deduped
 *    by image, with the stock boy as the fallback.
 *  - The picker: created personas ride the strip after
 *    the shipped shelf, picks write effective words, and
 *    the "Make it yours" card indexes the editor (New
 *    persona + one Edit row per persona, an "Edited"
 *    marker where an override stands).
 *  - The editor: a starter edit saves as an override
 *    (saving the shipped words verbatim clears it), Reset
 *    removes it, and saving while the persona is picked
 *    refreshes the pick to the new words; a create is
 *    picked the moment it exists, defaulting to
 *    am_michael over a template skeleton; a delete sits
 *    behind a confirm that names the memories, and
 *    deleting the persona that is on clears the pick.
 *  - Debate enumerates the whole shelf and composes
 *    effective prompts (the memory test pins the bucket
 *    side of that line).
 *  - Personas are configuration, not chat content:
 *    neither the store nor the editor consults
 *    IncognitoMode — creating and editing work the same
 *    while incognito is on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const custom = read("apps/ios/Shared/CustomPersonas.swift");
const localBrain = read("apps/ios/Shared/LocalBrain.swift");
const picker = read("apps/ios/App/PersonaPickerView.swift");
const editor = read("apps/ios/App/PersonaEditorView.swift");
const chatView = read("apps/ios/App/ChatView.swift");
const settings = read("apps/ios/App/SettingsView.swift");
const parity = read("test/unit/mac-persona-parity.test.ts");

test("overrides: one key per starter, effective = override ?? shipped", () => {
  assert.ok(custom.includes('"gus.personaPromptOverride.\\(personaID)"'));
  assert.ok(custom.includes("enum PersonaPromptOverrides"));
  assert.ok(custom.includes("static func prompt(for personaID: String) -> String?"));
  assert.ok(custom.includes("static func setPrompt(_ prompt: String?, for personaID: String)"));
  assert.ok(
    localBrain.includes("PersonaPromptOverrides.prompt(for: id) ?? prompt"),
    "effectivePrompt falls back to the shipped words",
  );
  assert.ok(localBrain.includes("var effectivePrompt: String"));
  assert.ok(localBrain.includes("var hasPromptOverride: Bool"));
});

test("the shelf: a computed pool — shipped starters plus created personas", () => {
  assert.ok(localBrain.includes("static var allPersonas: [PersonaStarter]"));
  assert.ok(
    localBrain.includes("personaStarters + CustomPersonaStore.shared.starters"),
    "starters first, then the operator's own in creation order",
  );
  // The shipped array itself stays a stored literal —
  // runtime customs never write into it.
  assert.ok(localBrain.includes("static let personaStarters: [PersonaStarter]"));
});

test("identity: the pick and the by-id door resolve the whole shelf", () => {
  assert.ok(
    localBrain.includes("return allPersonas.first { $0.effectivePrompt == prompt }"),
    "activeStarter matches on effective words, pool-wide",
  );
  assert.ok(
    localBrain.includes("allPersonas.first { $0.id == id }"),
    "starter(id:) resolves created personas for debate and attribution",
  );
  // The bucket derivation still keys off the resolved
  // persona's id (the memory test pins its exact shape);
  // a created persona's id is its bucket.
  assert.ok(localBrain.includes("if let starter = activeStarter { return starter.id }"));
});

test("the store: Codable records, custom- ids, its own defaults key", () => {
  assert.ok(custom.includes("final class CustomPersonaStore: ObservableObject"));
  assert.ok(custom.includes("static let shared = CustomPersonaStore()"));
  assert.ok(custom.includes('static let defaultsKey = "gus.personas.custom"'));
  assert.ok(custom.includes("struct CustomPersona: Codable, Identifiable, Equatable"));
  assert.ok(custom.includes('"custom-" + UUID().uuidString.lowercased()'));
  assert.ok(custom.includes("decode([CustomPersona].self, from: data)"));
  // Trimmed on write: the pick store trims on read, so
  // an untrimmed record would never match its own pick.
  assert.ok(
    custom.includes("prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines)"),
    "create stores the words trimmed",
  );
  assert.ok(custom.includes("record.prompt = record.prompt.trimmingCharacters(in: .whitespacesAndNewlines)"));
});

test("the store vends starters: borrowed face, no paired brain, own blurb", () => {
  assert.ok(custom.includes("var starters: [PersonaStarter]"));
  assert.ok(custom.includes('blurb: "Your own persona."'));
  assert.ok(custom.includes("pairedBrainID: nil"));
  assert.ok(custom.includes("face: PersonaFaceCatalog.face(forImageName: record.faceImageName)"));
});

test("delete: the bucket and the voice assignment go with the persona", () => {
  assert.ok(custom.includes("PersonaMemoryStore.shared.removeAll(for: id)"));
  assert.ok(custom.includes("PersonaVoiceAssignment.setVoiceID(nil, forPersona: id)"));
});

test("faces: the catalog is the portraits already on the phone", () => {
  assert.ok(custom.includes("enum PersonaFaceCatalog"));
  assert.ok(custom.includes("[PersonaFace.boy, PersonaFace.girl]"));
  assert.ok(custom.includes("+ LocalBrain.personaStarters.map(\\.face)"));
  assert.ok(custom.includes("if seen.insert(face.imageName).inserted"));
  assert.ok(custom.includes("choices.first { $0.imageName == name } ?? .boy"));
});

test("picker: created personas ride the strip after the shipped shelf", () => {
  assert.ok(picker.includes("@ObservedObject private var customStore = CustomPersonaStore.shared"));
  assert.ok(picker.includes("ForEach(customStore.starters) { starter in"));
  assert.ok(
    picker.includes("LocalBrain.customPrompt = starter?.effectivePrompt"),
    "a pick writes the persona's effective words",
  );
  assert.ok(
    picker.includes("!LocalBrain.allPersonas.contains { $0.effectivePrompt == currentPrompt }"),
    "the anonymous Custom cell shows only when NO persona on the shelf matches",
  );
});

test("picker: the make-it-yours card indexes the editor", () => {
  assert.ok(picker.includes("private var manageCard: some View"));
  assert.ok(picker.includes('Text("Make it yours")'));
  assert.ok(picker.includes("editorTarget = .new"));
  assert.ok(picker.includes("editorTarget = .starter(starter)"));
  assert.ok(picker.includes("editorTarget = .custom(record)"));
  assert.ok(picker.includes("starter.hasPromptOverride"), "the Edited marker reads the override");
  assert.ok(picker.includes(".sheet(item: $editorTarget) { target in"));
  assert.ok(picker.includes("PersonaEditorView(target: target)"));
});

test("editor: a starter edit is an override; shipped words verbatim = reset", () => {
  assert.ok(editor.includes("enum PersonaEditorTarget: Identifiable"));
  assert.ok(editor.includes("_promptText = State(initialValue: starter.effectivePrompt)"));
  assert.ok(editor.includes("PersonaPromptOverrides.setPrompt(promptText, for: starter.id)"));
  assert.ok(editor.includes("PersonaPromptOverrides.setPrompt(nil, for: starter.id)"));
  assert.ok(editor.includes('Button("Reset to shipped words", role: .destructive)'));
  // Saving while picked refreshes the pick to the new
  // words — identity is the text, so an unrefreshed edit
  // would unpick the persona into anonymous Custom.
  assert.ok(editor.includes("LocalBrain.customPrompt = starter.effectivePrompt"));
});

test("editor: create — template seed, am_michael default, picked on save", () => {
  assert.ok(editor.includes("static let newPersonaTemplate"));
  assert.ok(editor.includes("[Write who this persona is here"));
  assert.ok(editor.includes('_voiceID = State(initialValue: "am_michael")'));
  assert.ok(editor.includes("customStore.create("));
  assert.ok(
    editor.includes("LocalBrain.customPrompt = record.prompt"),
    "a new persona is picked the moment it exists",
  );
  // The face picker offers the catalog and nothing else.
  assert.ok(editor.includes("ForEach(PersonaFaceCatalog.choices, id: \\.imageName)"));
  assert.ok(!editor.includes("PhotosPicker"), "no image upload in this build");
});

test("editor: delete — confirm names the memories; deleting the pick falls back", () => {
  assert.ok(editor.includes("its saved memories are deleted with it"));
  assert.ok(editor.includes("customStore.delete(id: record.id)"));
  assert.ok(editor.includes("if wasActive {\n            LocalBrain.customPrompt = nil"));
});

test("debate: the menus enumerate the whole shelf", () => {
  assert.ok(chatView.includes("ForEach(LocalBrain.allPersonas) { starter in"));
  assert.ok(chatView.includes("@ObservedObject private var customPersonas = CustomPersonaStore.shared"));
  assert.ok(
    chatView.includes("LocalBrain.composedPrompt(starter.effectivePrompt, personaID: starter.id)"),
    "a debate pass thinks with the persona's effective words",
  );
});

test("settings shelf: a tap fills the field with the persona's current words", () => {
  assert.ok(settings.includes("personaText = starter.effectivePrompt"));
});

test("personas are configuration: no incognito consult in store or editor", () => {
  // The store's header COMMENT names IncognitoMode to
  // document the non-consult; what must never appear is
  // the consultation itself — a reference to the shared
  // flag or a read of its state.
  assert.ok(!custom.includes("IncognitoMode.shared"));
  assert.ok(!editor.includes("IncognitoMode.shared"));
  assert.ok(!custom.includes("incognitoMode.isOn"));
  assert.ok(!editor.includes("incognitoMode.isOn"));
});

test("parity honesty: the Mac roster pin reads sources, not runtime state", () => {
  // The v0.43.0 parity test slices the shipped literals
  // out of the Swift SOURCES — runtime overrides and
  // created personas live in defaults, never in the
  // literal it reads, so the pin stays honest untouched.
  assert.ok(parity.includes('read("apps/ios/Shared/LocalBrain.swift")'));
  assert.ok(parity.includes('source.indexOf("static let personaStarters")'));
});
