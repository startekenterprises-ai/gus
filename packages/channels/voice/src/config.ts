/**
 * Voice channel configuration (v0.9) — where the speech services
 * live, in the operator's settings, never in code.
 *
 * The voice channel talks to two OpenAI-compatible HTTP services
 * the OPERATOR runs (local-first, per the product's privacy
 * posture): a transcription endpoint (default shape: a
 * faster-whisper server) and a speech endpoint (default shape:
 * Kokoro-FastAPI). Both are plain config — base URL + model (+
 * voice for TTS) — persisted in <stateDir>/voice.json and re-read
 * per call, the same pattern as approver-policy.json and
 * governor-mode.json: an edit in Settings lands on the next call
 * with no restart, and a missing or malformed file means the
 * channel is OFF with the shipped defaults, never half-configured.
 *
 * The defaults below are the conventional local ports of the two
 * reference servers; they are starting points the operator edits,
 * not hosts the code depends on.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface VoiceConfig {
  /** The master switch. Off = the call endpoint refuses, loudly. */
  enabled: boolean;
  /** OpenAI-compatible base URL of the transcription service,
   *  e.g. "http://127.0.0.1:8000/v1" — POST {base}/audio/transcriptions. */
  sttBaseUrl: string;
  sttModel: string;
  /** OpenAI-compatible base URL of the speech service,
   *  e.g. "http://127.0.0.1:8880/v1" — POST {base}/audio/speech. */
  ttsBaseUrl: string;
  ttsModel: string;
  ttsVoice: string;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: false,
  sttBaseUrl: "http://127.0.0.1:8000/v1",
  sttModel: "whisper-1",
  ttsBaseUrl: "http://127.0.0.1:8880/v1",
  ttsModel: "kokoro",
  ttsVoice: "af_heart",
};

const CONFIG_FILE = "voice.json";

function urlOr(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/.test(trimmed)) return fallback;
  return trimmed;
}

function textOr(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 200) : fallback;
}

/** Parse defensively: only a literal `true` enables the channel,
 *  URLs must be http(s), and every field falls back to its default
 *  rather than to a half-typed value. A typo fails toward OFF. */
export function parseVoiceConfig(raw: unknown): VoiceConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_VOICE_CONFIG };
  const r = raw as Partial<VoiceConfig>;
  return {
    enabled: r.enabled === true,
    sttBaseUrl: urlOr(r.sttBaseUrl, DEFAULT_VOICE_CONFIG.sttBaseUrl),
    sttModel: textOr(r.sttModel, DEFAULT_VOICE_CONFIG.sttModel),
    ttsBaseUrl: urlOr(r.ttsBaseUrl, DEFAULT_VOICE_CONFIG.ttsBaseUrl),
    ttsModel: textOr(r.ttsModel, DEFAULT_VOICE_CONFIG.ttsModel),
    ttsVoice: textOr(r.ttsVoice, DEFAULT_VOICE_CONFIG.ttsVoice),
  };
}

export function loadVoiceConfig(stateDir: string): VoiceConfig {
  try {
    return parseVoiceConfig(JSON.parse(readFileSync(join(stateDir, CONFIG_FILE), "utf8")));
  } catch {
    return { ...DEFAULT_VOICE_CONFIG };
  }
}

export function writeVoiceConfig(stateDir: string, config: VoiceConfig, setBy: string): void {
  writeFileSync(
    join(stateDir, CONFIG_FILE),
    JSON.stringify({ ...parseVoiceConfig(config), setBy, ts: Date.now() }, null, 2) + "\n",
  );
}

/** "Configured" for the settings readout: the channel is enabled
 *  and both endpoints name a service. Presence only — the readout
 *  never carries the URLs themselves into the status summary. */
export function voiceConfigured(config: VoiceConfig): boolean {
  return config.enabled && config.sttBaseUrl.length > 0 && config.ttsBaseUrl.length > 0;
}
