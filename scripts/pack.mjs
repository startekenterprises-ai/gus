/**
 * Assemble dist-bundle/ for the sandbox Dockerfiles:
 *   dist-bundle/control-plane/*.js   (control-plane dist, main.js at root)
 *   dist-bundle/runtime/*.js         (runtime dist, main.js at root)
 *   dist-bundle/node_modules/@gus/*  (shared, gate, telegram: pkg + dist)
 * Run after `npm run build`.
 */
import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-bundle");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "node_modules/@gus"), { recursive: true });

cpSync(join(root, "packages/control-plane/dist"), join(out, "control-plane"), { recursive: true });
cpSync(join(root, "packages/runtime/dist"), join(out, "runtime"), { recursive: true });

const libs = [
  ["packages/shared", "shared"],
  ["packages/gate", "gate"],
  ["packages/channels/telegram", "telegram"],
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
