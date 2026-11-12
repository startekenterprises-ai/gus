/**
 * Speech service clients (v0.9) — transcription (STT) and speech
 * synthesis (TTS) against the operator's OpenAI-compatible
 * endpoints (config.ts).
 *
 * Posture:
 *   - No silent fallback, ever. A service that errors, times out,
 *     or answers nonsense produces a thrown SpeechServiceError
 *     naming the service, the endpoint, and the HTTP status — the
 *     call surface shows that text to the operator verbatim. The
 *     channel never substitutes a different service, never guesses
 *     a transcript, and never ships the reply as text-only while
 *     pretending it spoke. (v0.9.6's built-in fallback is a
 *     different thing: a mode resolved at call start by probe,
 *     announced in the session state — never a mid-turn swap.)
 *   - No credentials: the reference local servers (faster-whisper,
 *     Kokoro-FastAPI) are unauthenticated on loopback, and adding a
 *     key here would put a secret in a settings file. If an
 *     operator fronts their speech services with an authenticating
 *     proxy on their own network, that is their layer, not this
 *     client's.
 *   - fetch is injectable so the tests run the real client code
 *     against scripted responses, and so main.ts could wrap it
 *     later without a client change.
 */

export class SpeechServiceError extends Error {
  constructor(
    readonly service: "stt" | "tts",
    detail: string,
  ) {
    super(detail);
    this.name = "SpeechServiceError";
  }
}

export type FetchFn = typeof fetch;

const DEFAULT_TIMEOUT_MS = 30_000;

/** v0.9.6: the call-start reachability probe for an endpoint the
 *  operator chose — GET {base}/models (the route both reference
 *  servers answer) with a short timeout. Boolean, never throws:
 *  the answer decides the call's resolved mode (endpoint, or
 *  built-in for this call), it is not itself a failure surface —
 *  the session state carries the fallback notice in words. */
export async function probeEndpoint(
  fetchFn: FetchFn,
  baseUrl: string,
  timeoutMs: number = 2_500,
): Promise<boolean> {
  const detailed = await probeEndpointDetailed(fetchFn, baseUrl, undefined, timeoutMs);
  return detailed.reachable;
}

/** v0.9.9: the probe's full answer, for Settings → Voice's Test
 *  Connection buttons — the same GET {base}/models the call-start
 *  probe makes, but reported instead of collapsed to a boolean:
 *  whether the endpoint answered, how long the round trip took,
 *  which models it lists (the OpenAI shape: { data: [{ id }] }),
 *  and whether the operator's configured model is among them.
 *  Never throws, for the same reason the boolean probe doesn't:
 *  "unreachable" is an answer, not an exception. modelPresent is
 *  null when no model was asked about, or when the endpoint
 *  answered without a readable model list — reachable but
 *  unverifiable is stated as exactly that, never rounded up to
 *  "model found". The clock is injectable so tests can pin the
 *  latency arithmetic instead of sleeping. */
export interface EndpointProbeResult {
  reachable: boolean;
  latencyMs: number;
  models: string[];
  modelPresent: boolean | null;
}

export async function probeEndpointDetailed(
  fetchFn: FetchFn,
  baseUrl: string,
  model?: string,
  timeoutMs: number = 5_000,
  now: () => number = Date.now,
): Promise<EndpointProbeResult> {
  const startedAt = now();
  try {
    const res = await fetchFn(`${baseUrl}/models`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.max(0, now() - startedAt);
    if (!res.ok) return { reachable: false, latencyMs, models: [], modelPresent: null };
    let models: string[] = [];
    let listReadable = false;
    try {
      const body = (await res.json()) as { data?: unknown };
      if (Array.isArray(body?.data)) {
        listReadable = true;
        models = body.data
          .map((m) => (m as { id?: unknown })?.id)
          .filter((id): id is string => typeof id === "string");
      }
    } catch { /* answered, but not in the OpenAI shape — listReadable stays false */ }
    return {
      reachable: true,
      latencyMs,
      models,
      modelPresent:
        model === undefined || !listReadable ? null : models.includes(model),
    };
  } catch {
    return { reachable: false, latencyMs: Math.max(0, now() - startedAt), models: [], modelPresent: null };
  }
}

async function errorDetail(res: Response): Promise<string> {
  let body = "";
  try {
    body = (await res.text()).slice(0, 200).replace(/\s+/g, " ").trim();
  } catch { /* an unreadable body still leaves the status */ }
  return body ? `HTTP ${res.status}: ${body}` : `HTTP ${res.status}`;
}

/**
 * Transcribe one utterance. POSTs the audio as multipart form data
 * to {sttBaseUrl}/audio/transcriptions (the OpenAI shape the
 * faster-whisper servers implement) and returns the transcript
 * text. Throws SpeechServiceError on any failure — including a
 * 200 with no usable text, which is a broken service, not an
 * empty utterance.
 */
export async function transcribe(
  fetchFn: FetchFn,
  opts: { baseUrl: string; model: string },
  audio: Uint8Array,
  contentType: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const url = `${opts.baseUrl}/audio/transcriptions`;
  const form = new FormData();
  const ext = contentType.includes("wav") ? "wav" : contentType.includes("mp4") || contentType.includes("m4a") ? "m4a" : contentType.includes("webm") ? "webm" : contentType.includes("ogg") ? "ogg" : "bin";
  form.append("file", new Blob([audio.buffer as ArrayBuffer], { type: contentType }), `utterance.${ext}`);
  form.append("model", opts.model);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new SpeechServiceError(
      "stt",
      `Transcription failed: could not reach the speech-to-text service at ${opts.baseUrl} (${e instanceof Error ? e.message : String(e)}). Nothing was sent to GUS.`,
    );
  }
  if (!res.ok) {
    throw new SpeechServiceError(
      "stt",
      `Transcription failed: the speech-to-text service at ${opts.baseUrl} answered ${await errorDetail(res)}. Nothing was sent to GUS.`,
    );
  }
  let text = "";
  try {
    const body = (await res.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch { /* fall through to the empty-text failure below */ }
  if (!text) {
    throw new SpeechServiceError(
      "stt",
      `Transcription failed: the speech-to-text service at ${opts.baseUrl} returned no transcript text. Nothing was sent to GUS — check the service and the recording.`,
    );
  }
  return text;
}

/**
 * Synthesize one spoken reply. POSTs JSON to
 * {ttsBaseUrl}/audio/speech (the OpenAI shape Kokoro-FastAPI
 * implements) and returns the audio bytes + content type. Throws
 * SpeechServiceError on any failure — the caller reports the
 * failure WITH the reply text, so the operator still reads what
 * GUS said and knows exactly why they didn't hear it.
 *
 * v0.9.1: an external AbortSignal may ride along (the live call's
 * barge-in) — combined with the timeout, whichever fires first.
 * An interrupted synthesis throws like any other failure; the
 * session layer checks its generation before enqueueing audio,
 * so an interrupt that lands a hair too late still never speaks.
 */
export async function synthesize(
  fetchFn: FetchFn,
  opts: { baseUrl: string; model: string; voice: string },
  text: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ audio: Uint8Array; contentType: string }> {
  const url = `${opts.baseUrl}/audio/speech`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        input: text,
        voice: opts.voice,
        response_format: "mp3",
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (signal?.aborted) {
      throw new SpeechServiceError(
        "tts",
        "Speech synthesis was interrupted before the service answered — the rest of that reply was not spoken.",
      );
    }
    throw new SpeechServiceError(
      "tts",
      `Speech synthesis failed: could not reach the text-to-speech service at ${opts.baseUrl} (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  if (!res.ok) {
    throw new SpeechServiceError(
      "tts",
      `Speech synthesis failed: the text-to-speech service at ${opts.baseUrl} answered ${await errorDetail(res)}.`,
    );
  }
  const audio = new Uint8Array(await res.arrayBuffer());
  if (audio.length === 0) {
    throw new SpeechServiceError(
      "tts",
      `Speech synthesis failed: the text-to-speech service at ${opts.baseUrl} returned no audio.`,
    );
  }
  return { audio, contentType: res.headers.get("content-type") ?? "audio/mpeg" };
}
