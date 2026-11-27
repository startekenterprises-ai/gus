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
