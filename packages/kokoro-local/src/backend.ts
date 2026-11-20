/**
 * The Kokoro speech backend (v0.17.2) — the real Kokoro-82M model
 * running in-process via kokoro-js (transformers.js + onnxruntime,
 * espeak-ng phonemization — the same model and the same class of
 * phonemizer the reference Kokoro servers use; no shortcut model,
 * no stub).
 *
 * The library is loaded LAZILY, on first use: importing this
 * package (as the control plane does for the manager, and the
 * tests do for the server) must never drag onnxruntime into a
 * process that hasn't selected the bundled engine. The model
 * itself downloads on first enable into the operator's model
 * directory (~/.gus/models by the manager's wiring) — never at
 * app startup — and the download's progress is part of the state
 * the health surface reports.
 *
 * Synthesis is serialized: the model session is one shared
 * resource, and the voice layer speaks sentence by sentence
 * anyway — a queue here keeps concurrent HTTP callers honest
 * instead of racing the same session.
 */
import { encodeWavPcm16, concatWavPcm16 } from "./wav.js";
import { DEFAULT_KOKORO_VOICE, isKokoroVoice, type KokoroVoice } from "./voices.js";

export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** The model name the speech surface answers to — voice.json's
 *  shipped default (ttsModel "kokoro"), so an operator's existing
 *  config names this engine without an edit. */
export const KOKORO_MODEL_NAME = "kokoro";

export type KokoroDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

const DTYPES: readonly string[] = ["fp32", "fp16", "q8", "q4", "q4f16"];

/** fp32 is the default: the model's own weights, unquantized —
 *  the quality reference the endpoint servers serve. An operator
 *  on a slower machine can trade for the quantized build with
 *  GUS_KOKORO_DTYPE=q8. */
export function kokoroDtype(raw: string | undefined): KokoroDtype {
  return raw && DTYPES.includes(raw) ? (raw as KokoroDtype) : "fp32";
}

export interface KokoroModelState {
  /** The model is loaded and can synthesize now. */
  ready: boolean;
  /** A load (first-enable download or a cache read) is in flight. */
  loading: boolean;
  /** Bytes are actually moving — the load is a network download,
   *  not just a read from the local cache. */
  downloading: boolean;
  /** Overall download progress 0..1 when the downloader reports
   *  totals; null when unknown (e.g. a pure cache read). */
  progress: number | null;
  /** The load failure, when the last attempt failed. A failed
   *  engine says why, in words, everywhere its state is shown. */
  error?: string;
}

export interface SpeechBackend {
  state(): KokoroModelState;
  /** Begin loading the model if it isn't loaded or loading.
   *  Idempotent; never throws — the outcome lands in state(). */
  ensureStarted(): void;
  /** Synthesize one input to WAV bytes. Rejects with a
   *  KokoroNotReadyError while the model isn't ready (the server
   *  maps that to its 503), and with a plain Error naming the
   *  failure otherwise. */
  synthesize(text: string, voice: string): Promise<Uint8Array>;
}

export class KokoroNotReadyError extends Error {
  constructor(readonly modelState: KokoroModelState) {
    super(
      modelState.error
        ? `Kokoro model failed to load: ${modelState.error}`
        : modelState.downloading
          ? "voice model downloading"
          : "voice model is still loading",
    );
    this.name = "KokoroNotReadyError";
  }
}

/** Inputs are synthesized in sentence chunks under this length:
 *  the model's phoneme window is finite, and the voice layer's
 *  sentence-at-a-time calls sit far below it — the chunking is
 *  for direct callers (the Settings test sentence, a long typed
 *  reply) so a long input is spoken whole instead of truncated. */
const MAX_CHUNK_CHARS = 480;

export function splitForSynthesis(text: string, maxChars: number = MAX_CHUNK_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed ? [trimmed] : [];
  const sentences = trimmed.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [trimmed];
  const chunks: string[] = [];
  let current = "";
  const push = (piece: string) => {
    if (current && (current.length + 1 + piece.length > maxChars)) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  };
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length <= maxChars) {
      push(sentence);
      continue;
    }
    // One very long sentence: cut at the last space under the cap.
    let rest = sentence;
    while (rest.length > maxChars) {
      const cut = rest.lastIndexOf(" ", maxChars);
      const at = cut > 0 ? cut : maxChars;
      push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) push(rest);
  }
  if (current) chunks.push(current);
  return chunks;
}

interface ProgressEvent {
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

export interface KokoroBackendOptions {
  /** Where the model lives / downloads to (the transformers.js
   *  cache dir). The manager passes ~/.gus/models. */
  modelDir: string;
  dtype?: KokoroDtype;
  /** Test seam: replace the library load (kokoro-js + the model
   *  download) with a fake generator. Production never sets it. */
  loader?: (onProgress: (event: ProgressEvent) => void) => Promise<{
    generate: (text: string, voice: KokoroVoice) => Promise<Float32Array>;
  }>;
}

export class KokoroBackend implements SpeechBackend {
  private modelState: KokoroModelState = {
    ready: false,
    loading: false,
    downloading: false,
    progress: null,
  };
  private generateFn?: (text: string, voice: KokoroVoice) => Promise<Float32Array>;
  private loadPromise?: Promise<void>;
  /** Synthesis serialization: one generation at a time, in
   *  arrival order. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly files = new Map<string, { loaded: number; total: number; done: boolean }>();

  constructor(private readonly opts: KokoroBackendOptions) {}

  state(): KokoroModelState {
    return { ...this.modelState };
  }

  ensureStarted(): void {
    if (this.modelState.ready || this.loadPromise) return;
    this.modelState = { ready: false, loading: true, downloading: false, progress: null };
    this.loadPromise = this.load()
      .then(() => {
        this.modelState = { ready: true, loading: false, downloading: false, progress: 1 };
      })
      .catch((e: unknown) => {
        this.modelState = {
          ready: false,
          loading: false,
          downloading: false,
          progress: null,
          error: e instanceof Error ? e.message : String(e),
        };
        // A later ensureStarted may retry — a transient network
        // failure on first download must not brick the engine
        // for the life of the process.
        this.loadPromise = undefined;
      });
  }

  private onProgress(event: ProgressEvent): void {
    if (!event || typeof event.file !== "string") return;
    const entry = this.files.get(event.file) ?? { loaded: 0, total: 0, done: false };
    if (event.status === "progress" || event.status === "download") {
      if (typeof event.loaded === "number") entry.loaded = event.loaded;
      if (typeof event.total === "number" && event.total > 0) entry.total = event.total;
      // Bytes moving with a known total is a download; a cached
      // file reports done without progress events at all.
      if (entry.total > 0 && entry.loaded < entry.total) {
        this.modelState.downloading = true;
      }
    }
    if (event.status === "done") {
      entry.done = true;
      if (entry.total > 0) entry.loaded = entry.total;
    }
    this.files.set(event.file, entry);
    let loaded = 0;
    let total = 0;
    for (const f of this.files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    this.modelState.progress = total > 0 ? Math.min(1, loaded / total) : this.modelState.progress;
  }

  private async load(): Promise<void> {
    if (this.opts.loader) {
      const gen = await this.opts.loader((e) => this.onProgress(e));
      this.generateFn = gen.generate;
      return;
    }
    const { KokoroTTS } = await import("kokoro-js");
    const { env } = await import("@huggingface/transformers");
    // The model cache lives in the operator's GUS directory, not
    // inside node_modules: a reinstall must not re-download
    // 300+ MB, and the operator can see (and delete) what the
    // engine fetched.
    env.cacheDir = this.opts.modelDir;
    const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
      dtype: this.opts.dtype ?? "fp32",
      device: "cpu",
      progress_callback: (event) => this.onProgress(event as ProgressEvent),
    });
    this.generateFn = async (text, voice) => {
      const audio = await tts.generate(text, { voice });
      return audio.audio;
    };
  }

  async synthesize(text: string, voice: string): Promise<Uint8Array> {
    if (!isKokoroVoice(voice)) {
      throw new Error(`Unknown Kokoro voice "${voice}".`);
    }
    this.ensureStarted();
    if (!this.modelState.ready) {
      throw new KokoroNotReadyError(this.state());
    }
    const run = this.queue.then(async () => {
      // Re-check inside the queue: readiness could have been
      // lost to a failed load while this request waited.
      if (!this.generateFn) throw new KokoroNotReadyError(this.state());
      const chunks = splitForSynthesis(text);
      if (chunks.length === 0) throw new Error("Nothing to synthesize: the input was empty.");
      const parts: Uint8Array[] = [];
      for (const chunk of chunks) {
        const samples = await this.generateFn(chunk, voice as KokoroVoice);
        parts.push(encodeWavPcm16(samples));
      }
      return parts.length === 1 ? parts[0]! : concatWavPcm16(parts);
    });
    // The queue survives a failed generation — one bad input
    // must not wedge every later sentence.
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export { DEFAULT_KOKORO_VOICE };
