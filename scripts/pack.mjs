/**
 * Assemble dist-bundle/ for the sandbox Dockerfiles:
 *   dist-bundle/control-plane/*.js   (control-plane dist, main.js at root)
 *   dist-bundle/runtime/*.js         (runtime dist, main.js at root)
 *   dist-bundle/node_modules/@gus/*  (shared, gate, telegram: pkg + dist)
 *   dist-bundle/VERSION              (the bundle's declared version —
 *                                     Phase 3: a slot IS a dist-bundle,
 *                                     and its VERSION is what the slot
 *                                     pointer and release manifests
 *                                     agree on)
 * Run after `npm run build`.
 */
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-bundle");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "node_modules/@gus"), { recursive: true });

// The bundle's version, extracted from the compiled @gus/shared
// version module (the source of truth is GUS_VERSION in
// packages/shared/src/version.ts).
const versionSrc = readFileSync(join(root, "packages/shared/dist/version.js"), "utf8");
const versionMatch = versionSrc.match(/GUS_VERSION\s*=\s*"([^"]+)"/);
if (!versionMatch) throw new Error("pack: could not find GUS_VERSION in packages/shared/dist/version.js");
writeFileSync(join(out, "VERSION"), versionMatch[1] + "\n");

cpSync(join(root, "packages/control-plane/dist"), join(out, "control-plane"), { recursive: true });
cpSync(join(root, "packages/runtime/dist"), join(out, "runtime"), { recursive: true });
// Phase 1 drill fixtures: the egress test servers + the entrypoint that
// starts them inside the control-plane container (drill use only — the
// production entrypoint remains main.js; see test/fixtures/drill-entry.mjs).
// Phase 3 adds drill3-entry.mjs (test servers + the slot launcher).
for (const f of [
  "egress-test-server.mjs",
  "drill-entry.mjs",
  "drill3-entry.mjs",
  // Phase 4: Shield recorded-replay stand-in + world + panel driver.
  "drill4-entry.mjs",
  "shield-standin.mjs",
  "phase4-world.mjs",
  "phase4-payloads.mjs",
  "panel-driver.mjs",
]) {
  cpSync(join(root, "test/fixtures", f), join(out, "control-plane", f));
}

const libs = [
  ["packages/shared", "shared"],
  ["packages/gate", "gate"],
  ["packages/vault", "vault"],
  ["packages/egress", "egress"],
  ["packages/channels/telegram", "telegram"],
  ["packages/panel", "panel"],
];
for (const [src, name] of libs) {
  const dest = join(out, "node_modules/@gus", name);
  mkdirSync(dest, { recursive: true });
  cpSync(join(root, src, "package.json"), join(dest, "package.json"));
  cpSync(join(root, src, "dist"), join(dest, "dist"), { recursive: true });
}
// Normalize permissions: build outputs can inherit restrictive modes
// from the build environment, but the images run as an unprivileged
// user that must be able to read every file.
const normalize = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) {
    chmodSync(p, 0o755);
    for (const e of readdirSync(p)) normalize(join(p, e));
  } else {
    chmodSync(p, 0o644);
  }
};
normalize(out);
console.log("dist-bundle assembled");
