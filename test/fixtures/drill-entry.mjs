/**
 * Drill entrypoint — DRILL FIXTURE ONLY.
 *
 * Starts the egress test servers (the drill's "outside world") in THIS
 * process group, then boots the real control plane (./main.js). Used by
 * test/promise/phase1-drill.sh as the control-plane container's
 * entrypoint in place of main.js directly.
 *
 * Why the test servers share the control plane's container: in the
 * authoring VM a second container cannot join another container's
 * network namespace (setns is denied across user namespaces, the same
 * limitation that rules out `podman exec`). One container, one loopback,
 * both servers plus the control plane — the proxy still crosses a real
 * HTTP boundary on 127.0.0.1:8901 / 127.0.0.2:8902, and the sandbox
 * remains network-less throughout. See docs/LOCAL-DRILL.md.
 */
import { startTestServers } from "./egress-test-server.mjs";

startTestServers();
await import("./main.js");
