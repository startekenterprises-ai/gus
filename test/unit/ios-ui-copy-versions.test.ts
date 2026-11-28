/**
 * v0.47.0: user-facing copy carries no version numbers.
 *
 * Glenn's screenshot verdict (2026-11-27): the Settings
 * "Gmail demo pitch" caption was a long paragraph ending
 * in "(v0.31.0)" — too detailed, and version-specific
 * copy rots the moment the next build ships. Settings
 * and UI copy now speaks in plain words only.
 *
 * What is pinned here:
 *  - No Swift string literal in the iOS app, its shared
 *    code, the Watch app, the broadcast extension, or
 *    the Mac app contains a version reference (a "(v0."
 *    tag or a bare "v0.31.0"-style token). String
 *    literals are extracted properly — comments, which
 *    carry the build history and SHOULD name versions,
 *    are not copy and are not scanned.
 *  - The Gmail demo pitch caption is the short plain
 *    sentence Glenn asked for.
 *  - The genuine version DISPLAYS stay: the About /
 *    status surfaces read the real version from the
 *    bundle / the core's status (interpolation and
 *    fields, never a hard-coded literal) — a person can
 *    still learn what they're running.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

function swiftFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...swiftFiles(p));
    else if (entry.name.endsWith(".swift")) out.push(p);
  }
  return out;
}

/** Every string literal in a Swift source: multiline
 * literals first-class, escapes honored in one-liners. */
function stringLiterals(source: string): string[] {
  return [...source.matchAll(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"/g)].map(
    (m) => m[0],
  );
}

const VERSION_IN_COPY = /\(v\d+\.\d+|\bv\d+\.\d+(\.\d+)?\b/;

test("copy: no version references inside any Swift string literal", () => {
  const files = [
    ...swiftFiles("apps/ios"),
    ...swiftFiles("hosts/mac-app/Sources"),
  ];
  assert.ok(files.length > 50, "the scan actually covers both apps");
  const offenders: string[] = [];
  for (const file of files) {
    for (const literal of stringLiterals(read(file))) {
      if (VERSION_IN_COPY.test(literal)) {
        offenders.push(`${file}: ${literal.slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("copy: the Gmail demo pitch caption is short and plain", () => {
  const settings = read("apps/ios/App/SettingsView.swift");
  assert.ok(
    settings.includes(
      'Text("On: the on-device brain introduces itself with the Gmail cleanup pitch. Off: a general-purpose assistant.")',
    ),
  );
  assert.ok(
    !settings.includes("introduces itself with the email pitch"),
    "the old long caption is gone",
  );
});

test("copy: real version displays stay — read live, never hard-coded", () => {
  // The Mac's General settings read the app version
  // from the bundle at runtime.
  const macSettings = read("hosts/mac-app/Sources/GusApp/SettingsSections.swift");
  assert.ok(
    macSettings.includes(
      'Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")',
    ),
    "the Mac shows the bundle's real version",
  );
  assert.ok(macSettings.includes('SettingsRow(title: "GUS version", value: s.version)'));
});
