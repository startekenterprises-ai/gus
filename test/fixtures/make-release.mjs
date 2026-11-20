#!/usr/bin/env node
/**
 * Build a signed GUS release bundle from a packed dist-bundle —
 * publisher-side tooling for the Phase 3 drill (test/promise/
 * phase3-drill.sh) and the reference shape of the real release
 * process.
 *
 *   node make-release.mjs --src <dist-bundle> --out <releaseDir> \
 *        --version <v> --key <releasePrivateKey.pem> [--sabotage <mode>]
 *
 * What a release is: the bundle tree, version-patched (the GUS_VERSION
 * constant in the packed @gus/shared, the bundle VERSION file, and —
 * the visible, harmless change a user can see — the stub provider's
 * greeting line), plus manifest.json (per-file sha256) and
 * manifest.sig (Ed25519 over the manifest's canonical form; the
 * canonicalization MUST agree with packages/control-plane/src/
 * approvals.ts's canonicalize, which release.ts verifies against).
 *
 * Sabotage modes build the drill's bad releases. All but `tamper` are
 * applied BEFORE signing — they are genuinely signed bad releases,
 * which is the honest test: signature verification cannot save you
 * from a bad build, only the canary replay and rollback can.
 *   runtime-crash   runtime/main.js throws at boot (drill case b)
 *   write-tamper    the write tool appends junk to file content, so
 *                   the digest post-condition fails (drill case c)
 *   cp-crash        control-plane/main.js throws at boot (watchdog
 *                   rollback path)
 *   tamper          a file is altered AFTER signing, so the manifest
 *                   hash check must refuse it (drill case a)
 */
import { createHash, sign } from "node:crypto";
import { cpSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const src = arg("src");
const out = arg("out");
const version = arg("version");
const keyPath = arg("key");
const sabotage = arg("sabotage");
if (!src || !out || !version || !keyPath) {
  console.error("usage: node make-release.mjs --src <bundle> --out <dir> --version <v> --key <priv.pem> [--sabotage <mode>]");
  process.exit(2);
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

function patch(rel, from, to, expect = 1) {
  const p = join(out, ...rel.split("/"));
  const text = readFileSync(p, "utf8");
  const count = text.split(from).length - 1;
  if (count !== expect) {
    console.error(`make-release: patch target in ${rel}: found ${count} occurrence(s) of ${JSON.stringify(from)}, expected ${expect}`);
    process.exit(1);
  }
  writeFileSync(p, text.split(from).join(to));
}

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

const srcVersion = readFileSync(join(src, "VERSION"), "utf8").trim();

// --- version patches -------------------------------------------------
patch("node_modules/@gus/shared/dist/version.js", `"${srcVersion}"`, `"${version}"`);
writeFileSync(join(out, "VERSION"), version + "\n");
patch("control-plane/provider.js", "GUS here (offline stub provider)", `GUS ${version} here (offline stub provider)`);

// --- sabotage (pre-signing modes) ------------------------------------
if (sabotage === "runtime-crash") {
  const p = join(out, "runtime", "main.js");
  writeFileSync(p, `throw new Error("release fixture: crashy runtime — boots and dies");\n` + readFileSync(p, "utf8"));
} else if (sabotage === "cp-crash") {
  const p = join(out, "control-plane", "main.js");
  writeFileSync(p, `throw new Error("release fixture: crashy control plane — dies at boot");\n` + readFileSync(p, "utf8"));
} else if (sabotage === "write-tamper") {
  patch("runtime/tools.js", "writeFileSync(full, content);", 'writeFileSync(full, content + " [tampered]");');
} else if (sabotage && sabotage !== "tamper") {
  console.error(`make-release: unknown sabotage mode ${sabotage}`);
  process.exit(2);
}

// --- manifest + signature ---------------------------------------------
const files = {};
const walk = (d) => {
  for (const name of readdirSync(d).sort()) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const rel = relative(out, p).split(sep).join("/");
      if (rel === "manifest.json" || rel === "manifest.sig") continue;
      files[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  }
};
walk(out);
const manifest = { version, createdAt: Date.now(), files };
writeFileSync(join(out, "manifest.json"), canonicalize(manifest) + "\n");
const sig = sign(null, Buffer.from(canonicalize(manifest), "utf8"), readFileSync(keyPath, "utf8"));
writeFileSync(join(out, "manifest.sig"), sig.toString("base64") + "\n");

// --- sabotage (post-signing) -------------------------------------------
if (sabotage === "tamper") {
  const p = join(out, "runtime", "main.js");
  writeFileSync(p, readFileSync(p, "utf8") + "\n// altered after signing — the hash check must refuse this bundle\n");
}

console.log(`release v${version} built at ${out} (${Object.keys(files).length} files, sabotage: ${sabotage ?? "none"})`);
