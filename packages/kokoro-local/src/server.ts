/**
 * The bundled Kokoro speech server (v0.17.2) — a small HTTP
 * service on loopback ONLY, speaking the slice of the OpenAI
 * speech surface the Mac voice layer already consumes:
 *
 *   POST /v1/audio/speech  { model, input, voice, response_format }
 *                          → audio bytes (WAV)
 *   GET  /v1/models        the model list the call-start probe reads
 *   GET  /health           { ok, modelReady, downloading, progress }
 *
 * Posture, inherited from the voice layer it serves:
 *   - Loopback only. The server binds 127.0.0.1 and nothing else —
 *     it is a component of the app on this machine, never a
 *     network service.
 *   - No silent substitution. A request the engine can't honor
 *     is an HTTP error naming the reason: 400 for a malformed
 *     request or an unknown voice, 503 while the model is still
 *     downloading ("voice model downloading" — the words the
 *     voice layer surfaces to the operator), 503 with the load
 *     error when the model failed to load.
 *   - response_format is accepted and answered honestly: the
 *     engine produces WAV, so WAV is what comes back, labeled
 *     audio/wav — the voice layer plays what the content type
 *     says, and a caller asking for mp3 gets WAV bytes labeled
 *     as WAV, never mp3-labeled PCM.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { KokoroNotReadyError, KOKORO_MODEL_ID, KOKORO_MODEL_NAME, type SpeechBackend } from "./backend.js";
import { DEFAULT_KOKORO_VOICE, isKokoroVoice, KOKORO_VOICES } from "./voices.js";

export const KOKORO_SERVICE_MARKER = "gus-kokoro-local";
export const DEFAULT_KOKORO_PORT = 8880;

/** The port the bundled server binds: GUS_KOKORO_PORT when it
 *  names a usable port, else the conventional Kokoro port the
 *  shipped voice defaults already point at. */
export function kokoroPort(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_KOKORO_PORT;
}

export function kokoroBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

const MAX_BODY_BYTES = 128 * 1024;
const MAX_INPUT_CHARS = 4_000;

export interface KokoroServerOptions {
  backend: SpeechBackend;
  port?: number;
  /** Defaults to 127.0.0.1 — loopback is the design, the option
   *  exists only so tests can say so explicitly. */
  host?: string;
}

export interface KokoroServerHandle {
  server: Server;
  port: number;
  baseUrl: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function errorBody(message: string): { error: { message: string } } {
  return { error: { message } };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createKokoroServer(opts: KokoroServerOptions): KokoroServerHandle {
  const port = opts.port ?? DEFAULT_KOKORO_PORT;
  const host = opts.host ?? "127.0.0.1";
  const backend = opts.backend;

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) {
        json(res, 500, errorBody(`Kokoro server error: ${e instanceof Error ? e.message : String(e)}`));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      if (req.method !== "GET") return json(res, 405, errorBody("GET only"));
      const s = backend.state();
      return json(res, 200, {
        ok: true,
        service: KOKORO_SERVICE_MARKER,
        modelReady: s.ready,
        downloading: s.downloading,
        loading: s.loading,
        progress: s.progress,
        ...(s.error ? { error: s.error } : {}),
      });
    }

    if (path === "/v1/models") {
      if (req.method !== "GET") return json(res, 405, errorBody("GET only"));
      return json(res, 200, {
        object: "list",
        data: [{ id: KOKORO_MODEL_NAME, object: "model", created: 0, owned_by: "gus" }],
      });
    }

    if (path === "/v1/audio/speech") {
      if (req.method !== "POST") return json(res, 405, errorBody("POST only"));
      let raw: string;
      try {
        raw = await readBody(req);
      } catch {
        return json(res, 413, errorBody("Request body too large."));
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, errorBody("Request body must be JSON: { model, input, voice, response_format }."));
      }
      if (!body || typeof body !== "object") {
        return json(res, 400, errorBody("Request body must be a JSON object."));
      }
      const b = body as { model?: unknown; input?: unknown; voice?: unknown };
      if (b.model !== undefined && b.model !== KOKORO_MODEL_NAME && b.model !== KOKORO_MODEL_ID) {
        return json(res, 400, errorBody(`Unknown model "${String(b.model)}" — this engine serves "${KOKORO_MODEL_NAME}".`));
      }
      if (typeof b.input !== "string" || b.input.trim().length === 0) {
        return json(res, 400, errorBody("Field \"input\" must be a non-empty string."));
      }
      if (b.input.length > MAX_INPUT_CHARS) {
        return json(res, 400, errorBody(`Field \"input\" is ${b.input.length} characters — the limit is ${MAX_INPUT_CHARS}.`));
      }
      const voice = b.voice === undefined ? DEFAULT_KOKORO_VOICE : b.voice;
      if (!isKokoroVoice(voice)) {
        return json(
          res,
          400,
          errorBody(`Unknown voice "${String(voice)}" — voices: ${KOKORO_VOICES.join(", ")}.`),
        );
      }
      let audio: Uint8Array;
      try {
        audio = await backend.synthesize(b.input, voice);
      } catch (e) {
        if (e instanceof KokoroNotReadyError) {
          return json(res, 503, errorBody(e.message));
        }
        return json(res, 500, errorBody(`Speech synthesis failed: ${e instanceof Error ? e.message : String(e)}`));
      }
      res.writeHead(200, { "content-type": "audio/wav", "content-length": audio.length });
      res.end(audio);
      return;
    }

    return json(res, 404, errorBody(`No such route: ${req.method} ${path}`));
  }

  return {
    server,
    port,
    baseUrl: kokoroBaseUrl(port),
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        const onError = (e: Error) => reject(e);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.removeListener("error", onError);
          // Listening is the engine's "first enable" moment: the
          // model download/loading starts now, in the background —
          // /health reports it, and speech requests 503 until it
          // lands. Nothing here blocks the listen on the model.
          backend.ensureStarted();
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
