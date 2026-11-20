/**
 * The bundled Kokoro server, standalone (v0.17.2) — the entry
 * point the control plane's supervisor spawns:
 *
 *   node server-main.js
 *
 * Configuration is environment only:
 *   GUS_KOKORO_PORT       port to bind on 127.0.0.1 (default 8880)
 *   GUS_KOKORO_MODEL_DIR  model cache directory (default ~/.gus/models)
 *   GUS_KOKORO_DTYPE      fp32 (default) | fp16 | q8 | q4 | q4f16
 *
 * Lifecycle: the server is a child of the control plane and must
 * never outlive it. SIGTERM/SIGINT close it — and because a
 * parent can also die without signaling (a crash, a kill -9),
 * the server watches its own parentage: reparented to init
 * (ppid 1), it exits on its own. An orphaned speech server
 * holding the port and 330 MB of model is exactly the failure
 * this file exists to prevent.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { KokoroBackend, kokoroDtype } from "./backend.js";
import { createKokoroServer, kokoroPort } from "./server.js";

const port = kokoroPort(process.env.GUS_KOKORO_PORT);
const modelDir = process.env.GUS_KOKORO_MODEL_DIR ?? join(homedir(), ".gus", "models");

const backend = new KokoroBackend({ modelDir, dtype: kokoroDtype(process.env.GUS_KOKORO_DTYPE) });
const handle = createKokoroServer({ backend, port });

const parentPid = process.ppid;
const watchdog = setInterval(() => {
  if (process.ppid !== parentPid) {
    // The control plane is gone (we were reparented) — exit
    // rather than linger as an orphan.
    void shutdown(0);
  }
}, 2_000);
watchdog.unref?.();

let closing = false;
async function shutdown(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(watchdog);
  try {
    await handle.close();
  } catch { /* closing anyway */ }
  process.exit(code);
}

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

handle.listen().catch((e: unknown) => {
  console.error(
    `gus-kokoro-local: failed to listen on 127.0.0.1:${port}: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
});
