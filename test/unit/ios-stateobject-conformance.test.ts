// GUS v0.37.1 — the @StateObject conformance pin. The
// v0.32.0 mouth-flap rework held a plain smoothing-state
// class in an @StateObject without ObservableObject
// conformance; Swift's generic constraint rejected it and
// every iOS archive from 0.32.0 through 0.37.0 failed on
// that one line (0.31.0 was the last build that archived).
// The Swift cannot be compiled on this machine, so the
// contract is pinned from source: MouthFlap conforms, and
// EVERY type held by a @StateObject / @ObservedObject /
// @EnvironmentObject anywhere in apps/ios declares
// ObservableObject conformance in its class declaration.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function swiftFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...swiftFiles(p));
    else if (entry.name.endsWith(".swift")) out.push(p);
  }
  return out;
}

const files = swiftFiles(join(root, "apps/ios"));
const sources = files.map((f) => readFileSync(f, "utf8"));
const allSource = sources.join("\n");

/** Type names held by SwiftUI's object wrappers, from both
 *  spellings: `var x = TypeName()` / `var x = TypeName.shared`
 *  and `var x: TypeName`. */
function wrappedTypes(): Set<string> {
  const types = new Set<string>();
  const wrapper =
    /@(?:StateObject|ObservedObject|EnvironmentObject)\b[^\n]*?\bvar\s+\w+\s*(?::\s*(\w+)|=\s*(\w+)\s*[.(])/g;
  for (const src of sources) {
    for (const m of src.matchAll(wrapper)) {
      const t = m[1] ?? m[2];
      if (t) types.add(t);
    }
  }
  return types;
}

function declaresObservableObject(type: string): boolean {
  const decl = new RegExp(
    `(?:final\\s+|private\\s+|public\\s+|open\\s+)*class\\s+${type}\\s*:[^{]*\\bObservableObject\\b`
  );
  return decl.test(allSource);
}

test("MouthFlap conforms to ObservableObject (the v0.37.1 archive fix)", () => {
  assert.match(
    allSource,
    /private final class MouthFlap: ObservableObject \{/
  );
});

test("every @StateObject/@ObservedObject/@EnvironmentObject type conforms", () => {
  const types = wrappedTypes();
  assert.ok(types.size >= 8, `expected a real audit set, got ${types.size}`);
  for (const t of types) {
    assert.ok(
      declaresObservableObject(t),
      `${t} is held by a SwiftUI object wrapper but does not declare ObservableObject conformance`
    );
  }
});

// GUS v0.38.1 — the actor-isolation pin. CallSession is
// @MainActor-isolated, and the v0.33.0 voice-preview gate
// (VoicePreviewPlayer.toggle, a nonisolated context) reads
// its isAnyCallLive flag; Swift rejected the read and the
// v0.37.1 archive failed on that one line — the only error
// in the log. The flag is an advisory gate (writes happen
// only on the main actor inside CallSession; a stale read
// is harmless), so the declaration carries
// nonisolated(unsafe). Pin the exact declaration so the
// isolation is never silently reintroduced.
test("CallSession.isAnyCallLive is readable off-actor (the v0.38.1 archive fix)", () => {
  assert.match(
    allSource,
    /nonisolated\(unsafe\) static private\(set\) var isAnyCallLive = false/
  );
});

// GUS v0.43.1 — the fillColor pins, corrected. The
// v0.40.1 archive failed because the Camera call site
// (v0.36.0) omitted fillColor, which CallControlButton
// declared with no default. The v0.41.1 "fix" — a default
// on the declaration — was WRONG: a defaulted parameter
// immediately before the trailing-closure `action`
// parameter breaks trailing-closure matching at the call
// sites that DO pass it, and the v0.41.1 archive failed
// at the Speaker site (extra arguments / missing
// `action` / cannot infer `.accentColor`). The real fix:
// fillColor stays REQUIRED, and every call site passes
// it explicitly — Camera included, though its button is
// never filled and never reads the value. These pins
// guard that shape, so a future "helpful default"
// refactor fails this suite instead of Glenn's archive.
test("CallControlButton.fillColor is declared WITHOUT a default (the v0.43.1 correction)", () => {
  assert.match(allSource, /let fillColor: Color\n/);
  assert.doesNotMatch(allSource, /let fillColor: Color\s*=/);
});

test("every CallControlButton call site in callControlsRow passes fillColor", () => {
  const rowStart = allSource.indexOf("private var callControlsRow");
  assert.ok(rowStart >= 0, "callControlsRow not found");
  const rowEnd = allSource.indexOf("private var ", rowStart + 1);
  const row = allSource.slice(rowStart, rowEnd > rowStart ? rowEnd : undefined);
  const callSites = [...row.matchAll(/CallControlButton\(/g)].length;
  const fillArgs = [...row.matchAll(/fillColor:/g)].length;
  assert.ok(
    callSites >= 5,
    `expected at least 5 CallControlButton call sites in callControlsRow, got ${callSites}`
  );
  assert.equal(
    fillArgs,
    callSites,
    `callControlsRow has ${callSites} CallControlButton call sites but only ${fillArgs} fillColor arguments`
  );
});
