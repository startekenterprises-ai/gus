/**
 * Phase 4 drill entrypoint — DRILL FIXTURE ONLY.
 *
 * Starts the drill's whole "outside world" in this process group,
 * then boots the real control plane (./main.js):
 *   - the Phase 1 egress test world (test API + attacker sink),
 *   - the Phase 4 world (Shield recorded-replay stand-in, the
 *     exfiltration-directive article page, the model stand-in),
 *   - the panel driver (the harness's hands on the operator panel —
 *     podman exec is unavailable in this VM).
 * Production entrypoint remains main.js; see drill-entry.mjs for why
 * the fixtures share the control plane's network namespace.
 */
import { startTestServers } from "./egress-test-server.mjs";
import { startShieldStandin } from "./shield-standin.mjs";
import { startPhase4World } from "./phase4-world.mjs";
import { startPanelDriver } from "./panel-driver.mjs";

startTestServers();
startShieldStandin();
startPhase4World();
startPanelDriver();
await import("./main.js");
