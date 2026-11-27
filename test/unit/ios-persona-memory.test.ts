/**
 * v0.39.0: the per-persona memory pins.
 *
 * What is pinned here:
 *  - The store: one ObservableObject singleton, buckets
 *    keyed by persona id, persisted as JSON
 *    [String: [String]] under gus.personaMemory — the
 *    library's own persistence habit, in its own store,
 *    separate from chat history, sync, and receipts.
 *  - The caps: at most 20 lines and a 1500-character
 *    framed block ride a prompt; selection walks newest
 *    first and takes whole lines (a line that cannot fit
 *    whole is skipped, never truncated mid-way).
 *  - The framing: the block presents the lines as
 *    background to use naturally and explicitly NOT a
 *    list to read out or recite.
 *  - Injection lives at the one composition point:
 *    composedPrompt's personaID door. activePrompt passes
 *    the active bucket; the demo pitch passes none (a
 *    pitch is a mode, not a persona); each debate pass
 *    passes its own starter's id, so a debater carries
 *    only its own bucket.
 *  - The bucket derivation is single-sourced:
 *    LocalBrain.activeMemoryPersonaID — starter id, else
 *    "general" (no pick), else "custom" (edited words).
 *  - Remember: the operator's own messages only, never
 *    held or blocked (Shield-stopped words earn no road
 *    into a system prompt), never offered in incognito;
 *    the write lands in the active bucket and a notice
 *    names where it went and that it never syncs.
 *  - The Memory page: reached from the Personas tab's
 *    memory card (keyed by the same derivation), with
 *    add/edit/forget-one/forget-all; incognito disables
 *    the writing with the reason shown, while reading
 *    stays open.
 *  - Separation: Settings → Privacy (chat history) never
 *    references the memory store — delete-all leaves
 *    curated memory standing, by design.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const memory = read("apps/ios/Shared/PersonaMemory.swift");
const memoryView = read("apps/ios/App/PersonaMemoryView.swift");
const localBrain = read("apps/ios/Shared/LocalBrain.swift");
const chatView = read("apps/ios/App/ChatView.swift");
const picker = read("apps/ios/App/PersonaPickerView.swift");
const settingsView = read("apps/ios/App/SettingsView.swift");

test("store: one singleton, persona-id buckets, its own defaults key", () => {
  assert.ok(memory.includes("final class PersonaMemoryStore: ObservableObject"));
  assert.ok(memory.includes("static let shared = PersonaMemoryStore()"));
  assert.ok(memory.includes('static let defaultsKey = "gus.personaMemory"'));
  assert.ok(
    memory.includes("decode([String: [String]].self, from: data)"),
    "the persisted shape is persona id -> ordered lines",
  );
  assert.ok(memory.includes("func removeAll(for personaID: String)"));
});

test("store: nothing leaves through sync, history, or receipts", () => {
  for (const banned of ["ChatHistoryStore", "chatSync", "SyncedChatRecord", "ShieldReceipt"]) {
    assert.ok(!memory.includes(banned), `PersonaMemory.swift must not reference ${banned}`);
  }
  assert.ok(!memoryView.includes("ChatHistoryStore"));
});

test("caps: 20 lines, 1500 characters, newest first, whole lines only", () => {
  assert.ok(memory.includes("static let maxLines = 20"));
  assert.ok(memory.includes("static let maxBlockCharacters = 1500"));
  assert.ok(
    memory.includes("for line in lines.reversed()"),
    "selection walks most-recent first",
  );
  assert.ok(
    memory.includes("if length + cost > maxBlockCharacters { continue }"),
    "a line that cannot fit whole is skipped, never cut",
  );
  assert.ok(memory.includes("let cost = line.count + 3"));
});

test("framing: background to use naturally, never a list to recite", () => {
  assert.ok(
    memory.includes(
      "Things the person asked you to remember — background for this conversation: use it naturally when it fits, and never read the list out or recite it back.",
    ),
  );
  assert.ok(memory.includes("func memoryBlock(for personaID: String) -> String?"));
  assert.ok(
    memory.includes("guard !lines.isEmpty else { return nil }"),
    "an empty bucket appends nothing — the prompt is byte-identical to before",
  );
});

test("buckets: one derivation — starter id, else general, else custom", () => {
  assert.ok(localBrain.includes("static var activeMemoryPersonaID: String"));
  assert.ok(localBrain.includes("if let starter = activeStarter { return starter.id }"));
  assert.ok(localBrain.includes('return customPrompt == nil ? "general" : "custom"'));
});

test("injection: the composedPrompt personaID door, fed by activePrompt and debate", () => {
  assert.ok(
    localBrain.includes("static func composedPrompt(_ base: String, personaID: String? = nil) -> String"),
  );
  assert.ok(localBrain.includes("PersonaMemoryStore.shared.memoryBlock(for: personaID)"));
  assert.ok(
    localBrain.includes("personaID: activeMemoryPersonaID"),
    "the active persona's bucket rides chat and calls via activePrompt",
  );
  assert.ok(
    localBrain.includes("if demoPitchEnabled { return composedPrompt(emailDemoPrompt) }"),
    "the demo pitch composes with no persona id — no memories ride a pitch",
  );
  // v0.44.0: the debate pass composes the persona's
  // EFFECTIVE prompt (its saved edit when one stands) —
  // the bucket discipline this pin guards is unchanged:
  // the pass still carries its own persona's id, and
  // only its own bucket.
  assert.ok(
    chatView.includes("LocalBrain.composedPrompt(starter.effectivePrompt, personaID: starter.id)"),
    "each debate pass carries its own persona's bucket",
  );
});

test("remember: own, allowed, non-incognito messages only — into the active bucket", () => {
  assert.ok(
    chatView.includes(
      'Label("Remember for \\(LocalBrain.activeDisplayName)", systemImage: "brain.head.profile")',
    ),
    "the menu names the persona it will remember for",
  );
  assert.ok(
    chatView.includes("!message.held, !message.blocked, !incognitoMode.isOn"),
    "held, blocked, and incognito messages are never offered the action",
  );
  assert.ok(chatView.includes("func remember(_ message: ChatMessage)"));
  assert.ok(
    chatView.includes("PersonaMemoryStore.shared.add(text, to: LocalBrain.activeMemoryPersonaID)"),
  );
  assert.ok(
    chatView.includes("never syncs to your Mac"),
    "the confirmation notice names where the words went and that they stay on the phone",
  );
});

test("memory page: curation surface with forget-all behind a confirm", () => {
  assert.ok(memoryView.includes("struct PersonaMemoryView: View"));
  assert.ok(memoryView.includes("let personaID: String"));
  assert.ok(memoryView.includes("store.update(at: index, in: personaID, with: editingText)"));
  assert.ok(memoryView.includes("store.remove(at: index, from: personaID)"));
  assert.ok(memoryView.includes("store.removeAll(for: personaID)"));
  assert.ok(memoryView.includes('"Forget everything here"'));
  assert.ok(
    memoryView.includes("deleting your chat history doesn't touch them"),
    "the page states the separation from chat-history deletion in its own copy",
  );
});

test("memory page: incognito locks writing, with the reason, and leaves reading open", () => {
  assert.ok(memoryView.includes("private var locked: Bool { incognitoMode.isOn }"));
  assert.ok(
    memoryView.includes("incognito never writes anything down"),
    "the lock explains itself in plain words",
  );
  assert.ok(memoryView.includes(".disabled(locked)"), "the write controls disable");
});

test("personas tab: the memory card opens the picked persona's page", () => {
  assert.ok(picker.includes("PersonaMemoryView(personaID: bucket.id, personaName: bucket.name)"));
  assert.ok(
    picker.includes("let id = LocalBrain.activeMemoryPersonaID"),
    "the card's bucket is the same derivation injection uses",
  );
  assert.ok(picker.includes('Text("Memory for \\(bucket.name)")'));
});

test("privacy separation: chat-history delete-all never touches persona memory", () => {
  assert.ok(
    !settingsView.includes("PersonaMemory"),
    "Settings → Privacy deletes chat history only; curated memory is deleted on its own page",
  );
});
