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

// GUS v0.41.1 — the missing-argument pin. CallControlButton
// declared `let fillColor: Color` with no default, and the
// Camera call site (v0.36.0) — a button that is never
// filled, so the value is inert there — omitted it; the
// v0.40.1 archive failed on that one line, the only error
// in the log (CallView itself type-checked by then). The
// fix is the default on the declaration, so no call site
// can repeat the defect. Pin the exact declaration.
test("CallControlButton.fillColor carries a default (the v0.41.1 archive fix)", () => {
  assert.match(
    allSource,
    /let fillColor: Color = \.accentColor/
  );
});
