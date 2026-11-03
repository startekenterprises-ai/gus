/**
 * Phase 3 drill entrypoint — DRILL FIXTURE ONLY.
 *
 * Starts the egress test servers (the drill's "outside world", same
 * fixture as Phases 1/2), then runs the slot LAUNCHER in the control
 * role as a child process and stays alive with it. The launcher —
 * not this file — owns starting, promoting, and rolling back control
 * plane processes from the install slots; the test servers must
 * survive those restarts, which is why they live here, one level up.
 *
 * Used by test/promise/phase3-drill.sh as the control-plane
 * container's entrypoint. Production entrypoint remains main.js via
 * the launcher (see packages/sandbox/docker-compose.yml).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestServers } from "./egress-test-server.mjs";

startTestServers();

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.GUS_LAUNCHER_PATH,
  join(here, "launcher.mjs"),
  "/app/launcher.mjs",
].filter(Boolean);
const launcher = candidates.find((p) => existsSync(p));
if (!launcher) {
  console.error(`drill3-entry: no launcher found (looked: ${candidates.join(", ")})`);
  process.exit(1);
}
console.log(`drill3-entry: starting launcher at ${launcher}`);
const child = spawn(process.execPath, [launcher, "control"], { stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => child.kill(sig));
}
child.on("exit", (code, signal) => {
  console.log(`drill3-entry: launcher exited code=${code} signal=${signal}`);
  process.exit(code ?? 0);
});
