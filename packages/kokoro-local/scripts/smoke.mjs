/**
 * Live smoke test for @gus/kokoro-local — NOT a unit test.
 *
 *   node scripts/smoke.mjs [modelDir]
 *
 * Starts the bundled server from dist/ on a scratch port, waits
 * for the model (downloading it on first run — fp32 is ~330 MB),
 * synthesizes one sentence through the real HTTP surface, and
 * writes smoke.wav beside this script. Prints the WAV size, the
 * synthesis wall time, the audio duration, and the RTF.
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KokoroBackend } from "../dist/backend.js";
import { createKokoroServer } from "../dist/server.js";

const modelDir = process.argv[2] ?? join(homedir(), ".gus", "models");
const port = 18_880;
const backend = new KokoroBackend({ modelDir });
const handle = createKokoroServer({ backend, port });
await handle.listen();
console.log(`smoke: server on ${handle.baseUrl}, model dir ${modelDir}`);

const deadline = Date.now() + 600_000;
for (;;) {
  const s = backend.state();
  if (s.ready) break;
  if (s.error) {
    console.error(`smoke: model failed to load: ${s.error}`);
    process.exit(1);
  }
  if (Date.now() > deadline) {
    console.error("smoke: model not ready in 10 minutes");
    process.exit(1);
  }
  if (s.downloading && s.progress !== null) {
    process.stdout.write(`\rdownloading ${Math.floor(s.progress * 100)}%`);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("\nsmoke: model ready");

const text = "Hello from GUS. This is the built-in Kokoro voice, running entirely on this machine.";
const t0 = Date.now();
const res = await fetch(`${handle.baseUrl}/audio/speech`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "kokoro", input: text, voice: "af_heart", response_format: "mp3" }),
});
if (!res.ok) {
  console.error(`smoke: speech request failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
const wav = new Uint8Array(await res.arrayBuffer());
const wallMs = Date.now() - t0;
const out = join(dirname(fileURLToPath(import.meta.url)), "smoke.wav");
writeFileSync(out, wav);
const dataBytes = wav.length - 44;
const durationS = dataBytes / 2 / 24_000;
console.log(
  `smoke: WAV ${wav.length} bytes -> ${out}; synth wall ${wallMs} ms; audio ${durationS.toFixed(2)} s; RTF ${(wallMs / 1000 / durationS).toFixed(3)}`,
);
await handle.close();
process.exit(0);
