/**
 * Built-in Kokoro (v0.17.2) — the bundled speech engine, pinned:
 *
 *  - The server surface, with the TTS backend mocked: health
 *    states (ready / downloading + progress / failed), request
 *    validation (missing input, unknown voice, unknown model,
 *    malformed JSON), the models list the call-start probe
 *    reads, and the 503-while-downloading the voice layer
 *    surfaces as "voice model downloading".
 *  - The backend's state machine, with the library load behind
 *    its test seam: not-ready synthesis refuses with the typed
 *    error, download progress aggregates, a ready backend
 *    returns real WAV bytes, long inputs synthesize in chunks.
 *  - The supervisor, with spawn + fetch faked: it adopts a
 *    healthy server already on the port, spawns when none
 *    answers, refuses a foreign server on the port, stops its
 *    child on stop(), and reports an unexpected exit.
 *  - The engine-selection logic: a stored "bundled" resolves
 *    as written on the TTS side, never resolves on the STT
 *    side, and every pre-existing file shape resolves exactly
 *    as it did before the value existed.
 *  - The call's mode resolution: bundled + ready speaks
 *    through the loopback URL; bundled + downloading or
 *    unavailable resolves to the app voice with the reason in
 *    the notice — the endpoint fallback discipline, unchanged
 *    for the engines that predates it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  KokoroBackend,
  KokoroNotReadyError,
  KokoroServerManager,
  createKokoroServer,
  encodeWavPcm16,
  type KokoroModelState,
  type SpeechBackend,
} from "../../packages/kokoro-local/src/index.js";
import {
  VoiceAdapter,
  VoiceSessionService,
  parseVoiceConfig,
  voiceConfigured,
  writeVoiceConfig,
  type BundledTtsStatus,
  type VoiceConfig,
} from "../../packages/channels/voice/src/index.js";

// ---------------------------------------------------------------- backend fake

class FakeBackend implements SpeechBackend {
  modelState: KokoroModelState = { ready: true, loading: false, downloading: false, progress: 1 };
  calls: { text: string; voice: string }[] = [];
  started = 0;
  state(): KokoroModelState {
    return { ...this.modelState };
  }
  ensureStarted(): void {
    this.started++;
  }
  async synthesize(text: string, voice: string): Promise<Uint8Array> {
    if (!this.modelState.ready) throw new KokoroNotReadyError(this.state());
    this.calls.push({ text, voice });
    return encodeWavPcm16(new Float32Array(2_400).fill(0.25));
  }
}

async function withServer<T>(backend: SpeechBackend, run: (base: string) => Promise<T>): Promise<T> {
  const handle = createKokoroServer({ backend, port: 0 });
  await handle.listen();
  const port = (handle.server.address() as AddressInfo).port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await handle.close();
  }
}

async function speech(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------- server surface

test("health reports the ready state with the service marker", async () => {
  await withServer(new FakeBackend(), async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.service, "gus-kokoro-local");
    assert.equal(body.modelReady, true);
    assert.equal(body.downloading, false);
  });
});

test("health reports downloading with progress, and the load error when failed", async () => {
  const backend = new FakeBackend();
  backend.modelState = { ready: false, loading: true, downloading: true, progress: 0.42 };
  await withServer(backend, async (base) => {
    const body = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    assert.equal(body.modelReady, false);
    assert.equal(body.downloading, true);
    assert.equal(body.progress, 0.42);
  });
  backend.modelState = { ready: false, loading: false, downloading: false, progress: null, error: "disk full" };
  await withServer(backend, async (base) => {
    const body = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    assert.equal(body.error, "disk full");
  });
});

test("the models list names the one model the engine serves", async () => {
  await withServer(new FakeBackend(), async (base) => {
    const body = (await (await fetch(`${base}/v1/models`)).json()) as { data: { id: string }[] };
    assert.deepEqual(body.data.map((m) => m.id), ["kokoro"]);
  });
});

test("a speech request returns WAV bytes and passes input + voice through", async () => {
  const backend = new FakeBackend();
  await withServer(backend, async (base) => {
    const res = await speech(base, { model: "kokoro", input: "Hello there.", voice: "bm_george", response_format: "mp3" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/wav");
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "RIFF");
    assert.deepEqual(backend.calls, [{ text: "Hello there.", voice: "bm_george" }]);
  });
});

test("speech validation: missing/empty input, unknown voice, unknown model, malformed JSON", async () => {
  await withServer(new FakeBackend(), async (base) => {
    assert.equal((await speech(base, { model: "kokoro" })).status, 400);
    assert.equal((await speech(base, { input: "   " })).status, 400);
    assert.equal((await speech(base, { input: "Hi.", voice: "xx_nope" })).status, 400);
    assert.equal((await speech(base, { input: "Hi.", model: "gpt-4o-mini-tts" })).status, 400);
    assert.equal((await speech(base, "{not json")).status, 400);
    const tooLong = await speech(base, { input: "x".repeat(4_001) });
    assert.equal(tooLong.status, 400);
  });
});

test("unknown routes 404 and wrong methods 405", async () => {
  await withServer(new FakeBackend(), async (base) => {
    assert.equal((await fetch(`${base}/v1/audio/transcriptions`)).status, 404);
    assert.equal((await fetch(`${base}/v1/audio/speech`)).status, 405);
    assert.equal((await fetch(`${base}/health`, { method: "POST" })).status, 405);
  });
});

test("synthesis while the model downloads is a 503 the voice layer can surface", async () => {
  const backend = new FakeBackend();
  backend.modelState = { ready: false, loading: true, downloading: true, progress: 0.25 };
  await withServer(backend, async (base) => {
    const res = await speech(base, { input: "Hello." });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { message: string } };
    assert.equal(body.error.message, "voice model downloading");
  });
});

test("synthesis after a failed load is a 503 naming the failure", async () => {
  const backend = new FakeBackend();
  backend.modelState = { ready: false, loading: false, downloading: false, progress: null, error: "network unreachable" };
  await withServer(backend, async (base) => {
    const res = await speech(base, { input: "Hello." });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /network unreachable/);
  });
});

// ---------------------------------------------------------------- backend state machine

test("backend: not-ready synthesis refuses typed, progress aggregates, ready synthesis returns WAV", async () => {
  let releaseLoad: (() => void) | undefined;
  const backend = new KokoroBackend({
    modelDir: "/unused",
    loader: async (onProgress) => {
      onProgress({ status: "progress", file: "onnx/model.onnx", loaded: 25, total: 100 });
      await new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      return {
        generate: async () => new Float32Array(4_800).fill(0.1),
      };
    },
  });
  await assert.rejects(() => backend.synthesize("Hello.", "af_heart"), KokoroNotReadyError);
  const mid = backend.state();
  assert.equal(mid.loading, true);
  assert.equal(mid.downloading, true);
  assert.equal(mid.progress, 0.25);
  releaseLoad!();
  // Let the load promise settle into the ready state.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(backend.state().ready, true);
  const wav = await backend.synthesize("Hello.", "af_heart");
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(wav.length, 44 + 4_800 * 2);
});

test("backend: an unknown voice is refused before the model is touched", async () => {
  const backend = new KokoroBackend({
    modelDir: "/unused",
    loader: async () => ({ generate: async () => new Float32Array(10) }),
  });
  backend.ensureStarted();
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(() => backend.synthesize("Hello.", "not_a_voice"), /Unknown Kokoro voice/);
});

test("backend: a long input synthesizes in chunks and concatenates", async () => {
  const chunkLengths: number[] = [];
  const backend = new KokoroBackend({
    modelDir: "/unused",
    loader: async () => ({
      generate: async (text: string) => {
        chunkLengths.push(text.length);
        return new Float32Array(1_200).fill(0.1);
      },
    }),
  });
  backend.ensureStarted();
  await new Promise((r) => setTimeout(r, 10));
  const sentence = "This is one fairly long sentence that keeps going with more words in it.";
  const wav = await backend.synthesize(Array(12).fill(sentence).join(" "), "af_heart");
  assert.ok(chunkLengths.length > 1, `expected chunking, got ${chunkLengths.length} call(s)`);
  assert.ok(chunkLengths.every((n) => n <= 480));
  assert.equal(wav.length, 44 + chunkLengths.length * 1_200 * 2);
});

// ---------------------------------------------------------------- supervisor

class FakeChild extends EventEmitter {
  killedWith: string[] = [];
  kill(signal?: string): boolean {
    this.killedWith.push(signal ?? "SIGTERM");
    return true;
  }
  unref(): void {}
}

function healthResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const READY_HEALTH = { ok: true, service: "gus-kokoro-local", modelReady: true, downloading: false, progress: 1 };

test("manager: adopts a healthy bundled server already on the port — no spawn", async () => {
  let spawns = 0;
  const manager = new KokoroServerManager({
    modelDir: "/unused",
    port: 19_101,
    spawnFn: (() => {
      spawns++;
      return new FakeChild();
    }) as never,
    fetchFn: (async () => healthResponse(READY_HEALTH)) as never,
  });
  const status = await manager.ensureRunning();
  assert.equal(status.state, "ready");
  assert.equal(spawns, 0);
});

test("manager: spawns when nothing answers, then reports the health it finds", async () => {
  const child = new FakeChild();
  let healthCalls = 0;
  const manager = new KokoroServerManager({
    modelDir: "/unused",
    port: 19_102,
    spawnFn: (() => child) as never,
    fetchFn: (async () => {
      healthCalls++;
      if (healthCalls < 3) throw new Error("connect ECONNREFUSED");
      return healthResponse({ ...READY_HEALTH, modelReady: false, downloading: true, progress: 0.5 });
    }) as never,
  });
  const status = await manager.ensureRunning();
  assert.equal(status.state, "downloading");
  assert.equal(status.progress, 0.5);
  assert.match(status.detail, /50%/);
});

test("manager: a foreign server on the port is refused, in words", async () => {
  const manager = new KokoroServerManager({
    modelDir: "/unused",
    port: 19_103,
    startTimeoutMs: 700,
    spawnFn: (() => new FakeChild()) as never,
    // A Kokoro-FastAPI-shaped health answer: fine server, not ours.
    fetchFn: (async () => healthResponse({ status: "ok" })) as never,
  });
  const status = await manager.ensureRunning();
  assert.equal(status.state, "unavailable");
  assert.match(status.detail, /another program/);
});

test("manager: stop() kills the child it spawned and reports stopped", async () => {
  const child = new FakeChild();
  let healthCalls = 0;
  const manager = new KokoroServerManager({
    modelDir: "/unused",
    port: 19_104,
    spawnFn: (() => child) as never,
    fetchFn: (async () => {
      healthCalls++;
      if (healthCalls < 2) throw new Error("connect ECONNREFUSED");
      return healthResponse(READY_HEALTH);
    }) as never,
  });
  await manager.ensureRunning();
  manager.stop();
  assert.deepEqual(child.killedWith, ["SIGTERM"]);
  assert.equal(manager.statusSync().state, "stopped");
});

test("manager: an unexpected child exit is reported, with a restart coming", async () => {
  const child = new FakeChild();
  let healthCalls = 0;
  const manager = new KokoroServerManager({
    modelDir: "/unused",
    port: 19_105,
    spawnFn: (() => child) as never,
    fetchFn: (async () => {
      healthCalls++;
      if (healthCalls < 2) throw new Error("connect ECONNREFUSED");
      return healthResponse(READY_HEALTH);
    }) as never,
  });
  await manager.ensureRunning();
  child.emit("exit", 1, null);
  const status = manager.statusSync();
  assert.equal(status.state, "unavailable");
  assert.match(status.detail, /restarting/);
  manager.stop();
});

// ---------------------------------------------------------------- engine selection

test("config: a stored bundled TTS engine resolves as written, marker or not", () => {
  assert.equal(parseVoiceConfig({ ttsEngine: "bundled", enginesChosen: true }).ttsEngine, "bundled");
  assert.equal(parseVoiceConfig({ ttsEngine: "bundled" }).ttsEngine, "bundled");
  assert.equal(
    parseVoiceConfig({ ttsEngine: "bundled", ttsBaseUrl: "http://192.168.2.42:8880/v1" }).ttsEngine,
    "bundled",
  );
});

test("config: bundled never resolves on the STT side", () => {
  assert.equal(parseVoiceConfig({ sttEngine: "bundled" }).sttEngine, "local");
  assert.equal(
    parseVoiceConfig({ sttEngine: "bundled", sttBaseUrl: "http://192.168.2.42:8000/v1" }).sttEngine,
    "endpoint",
  );
});

test("config: pre-existing file shapes resolve exactly as before (v0.17.5: the empty shape takes the new shipped TTS default)", () => {
  // The shipped defaults — v0.17.5: an empty file is a fresh
  // install, so the mouth takes the new default, bundled
  // Kokoro; the ears are unchanged. Every CHOSEN shape below
  // resolves exactly as before — the flip moves only the
  // un-chosen fallback.
  const d = parseVoiceConfig({});
  assert.equal(d.sttEngine, "local");
  assert.equal(d.ttsEngine, "bundled");
  // An explicitly chosen endpoint pair.
  const e = parseVoiceConfig({ sttEngine: "endpoint", ttsEngine: "endpoint", enginesChosen: true });
  assert.equal(e.sttEngine, "endpoint");
  assert.equal(e.ttsEngine, "endpoint");
  // A configured LAN stack with no engine fields (the v0.15.6 case).
  const lan = parseVoiceConfig({
    sttBaseUrl: "http://192.168.2.42:8000/v1",
    ttsBaseUrl: "http://192.168.2.42:8880/v1",
  });
  assert.equal(lan.sttEngine, "endpoint");
  assert.equal(lan.ttsEngine, "endpoint");
  // A chosen local sticks even with URLs on file.
  const chosen = parseVoiceConfig({
    ttsEngine: "local",
    enginesChosen: true,
    ttsBaseUrl: "http://192.168.2.42:8880/v1",
  });
  assert.equal(chosen.ttsEngine, "local");
});

test("config: a bundled mouth counts as configured with no URL on file", () => {
  const config: VoiceConfig = {
    ...parseVoiceConfig({}),
    enabled: true,
    ttsEngine: "bundled",
    ttsBaseUrl: "",
  };
  assert.equal(voiceConfigured(config), true);
});

// ---------------------------------------------------------------- call resolution

function sessionHarness(bundled: BundledTtsStatus | undefined) {
  const stateDir = mkdtempSync(join(tmpdir(), "gus-kokoro-session-"));
  writeVoiceConfig(
    stateDir,
    {
      enabled: true,
      sttEngine: "local",
      sttBaseUrl: "http://127.0.0.1:8000/v1",
      sttModel: "whisper-1",
      ttsEngine: "bundled",
      ttsBaseUrl: "http://127.0.0.1:8880/v1",
      ttsModel: "kokoro",
      ttsVoice: "af_heart",
      enginesChosen: true,
      bargeIn: true,
      shieldScan: true,
    },
    "test",
  );
  const speechUrls: string[] = [];
  const fetchFn = (async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "kokoro" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/audio/speech")) {
      speechUrls.push(u);
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  const service = new VoiceSessionService(stateDir, new VoiceAdapter(), { pendingFor: () => undefined }, {
    fetchFn,
    bundledTts:
      bundled === undefined
        ? undefined
        : {
            baseUrl: "http://127.0.0.1:18881/v1",
            ensureRunning: async () => bundled,
          },
  });
  return { service, speechUrls };
}

test("session: bundled + ready speaks the greeting through the loopback URL", async () => {
  const { service, speechUrls } = sessionHarness({
    serverUp: true,
    modelReady: true,
    downloading: false,
    progress: 1,
    detail: "Ready — Kokoro runs on this Mac.",
  });
  const state = await service.start();
  assert.equal(state.ok, true);
  assert.equal(state.ttsMode, "bundled");
  assert.deepEqual(speechUrls, ["http://127.0.0.1:18881/v1/audio/speech"]);
  if (state.sessionId) service.end(state.sessionId);
});

test("session: bundled + downloading resolves to the app voice, saying why", async () => {
  const { service } = sessionHarness({
    serverUp: true,
    modelReady: false,
    downloading: true,
    progress: 0.5,
    detail: "Downloading the voice model — 50%.",
  });
  const state = await service.start();
  assert.equal(state.ok, true);
  assert.equal(state.ttsMode, "local");
  assert.match(state.speechNotice ?? "", /still downloading \(50%\)/);
  if (state.sessionId) service.end(state.sessionId);
});

test("session: bundled + unavailable resolves to the app voice, saying why", async () => {
  const { service } = sessionHarness({
    serverUp: false,
    modelReady: false,
    downloading: false,
    progress: null,
    detail: "Unavailable — the built-in Kokoro server failed to start (exit code 1).",
  });
  const state = await service.start();
  assert.equal(state.ok, true);
  assert.equal(state.ttsMode, "local");
  assert.match(state.speechNotice ?? "", /Built-in Kokoro is unavailable/);
  if (state.sessionId) service.end(state.sessionId);
});

test("session: bundled picked but no resolver wired resolves to the app voice", async () => {
  const { service } = sessionHarness(undefined);
  const state = await service.start();
  assert.equal(state.ok, true);
  assert.equal(state.ttsMode, "local");
  assert.match(state.speechNotice ?? "", /isn't available in this build/);
  if (state.sessionId) service.end(state.sessionId);
});
