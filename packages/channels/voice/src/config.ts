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
 *
 * v0.9.6 ("Voice, built in"): each service ALSO has an engine —
 * "local" (the speech lives in the app on the operator's Mac:
 * the Speech framework transcribes, AVSpeechSynthesizer speaks)
 * or "endpoint" (the HTTP services above). Built-in is the
 * default and the migration: a voice.json written before engines
 * existed has no engine fields, and it upgrades to built-in —
 * the 0.9.5 field failure (an unreachable LAN endpoint silently
 * eating every turn of a call) is exactly what the default now
 * routes around. Endpoints stay as optional extras; session.ts
 * probes a chosen endpoint at call start and falls back to
 * built-in for that call when it doesn't answer.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** v0.9.6: where one half of the call's speech lives — in the
 *  app on the operator's Mac ("local") or at the configured
 *  OpenAI-compatible endpoint ("endpoint"). */
export type VoiceEngine = "local" | "endpoint";

/** v0.9.11: how a call's spoken turns meet the Shield — "fast"
 *  when the operator's Shield-scan switch is on (voice scans run
 *  the gate's fast mode, v0.9.10), "off" when the switch is off
 *  and spoken turns skip the ingress scan (v0.9.9). There is no
 *  third state: a voice scan is never the full semantic review.
 *  The session state carries it so the app can SHOW the state
 *  in the call strip instead of leaving it buried in Settings. */
export type VoiceShieldMode = "off" | "fast";

export interface VoiceConfig {
  /** The master switch. Off = the call endpoint refuses, loudly. */
  enabled: boolean;
  /** v0.9.6: the transcription engine. Anything in the file that
   *  isn't literally "endpoint" resolves to "local" — built-in
   *  is the default, the same defensive shape as bargeIn. */
  sttEngine: VoiceEngine;
  /** OpenAI-compatible base URL of the transcription service,
   *  e.g. "http://127.0.0.1:8000/v1" — POST {base}/audio/transcriptions.
   *  Used only when sttEngine is "endpoint". */
  sttBaseUrl: string;
  sttModel: string;
  /** v0.9.6: the speech engine — same rule as sttEngine. */
  ttsEngine: VoiceEngine;
  /** OpenAI-compatible base URL of the speech service,
   *  e.g. "http://127.0.0.1:8880/v1" — POST {base}/audio/speech.
   *  Used only when ttsEngine is "endpoint". */
  ttsBaseUrl: string;
  ttsModel: string;
  ttsVoice: string;
  /** v0.9.1: barge-in — in a live call, talking over a spoken
   *  reply cuts the speech off (the app stops playback and the
   *  control plane drops pending synthesis). Default ON: only a
   *  literal `false` in the file turns it off, because the safe
   *  failure for a mis-typed value is the shipped behavior, not
   *  a silently different call. */
  bargeIn: boolean;
  /** v0.9.9: the operator's Shield-scan switch for SPOKEN turns
   *  only. ON (the default, and the failure direction for any
   *  malformed value): a voice transcript crosses the Agent-Shield
   *  ingress scan before it can become a job, exactly like typed
   *  text. OFF: the ChannelHost skips ONLY the voice channel's
   *  ingress scan — the words become a job unscanned, which is
   *  faster and is the troubleshooting position Glenn asked for.
   *  Nothing else moves: the ingress secret-guard still screens
   *  the words, Telegram/panel messages are still scanned, and
   *  the Governor's caps, approvals, and vault rules for ACTIONS
   *  are untouched. Every skipped turn is recorded as
   *  scan-skipped-by-operator in voice-turns.jsonl — the record
   *  never has a silent gap where a scan should be. */
  shieldScan: boolean;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: false,
  sttEngine: "local",
  sttBaseUrl: "http://127.0.0.1:8000/v1",
  sttModel: "whisper-1",
  ttsEngine: "local",
  ttsBaseUrl: "http://127.0.0.1:8880/v1",
  ttsModel: "kokoro",
  ttsVoice: "af_heart",
  bargeIn: true,
  shieldScan: true,
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
    sttEngine: r.sttEngine === "endpoint" ? "endpoint" : "local",
    sttBaseUrl: urlOr(r.sttBaseUrl, DEFAULT_VOICE_CONFIG.sttBaseUrl),
    sttModel: textOr(r.sttModel, DEFAULT_VOICE_CONFIG.sttModel),
    ttsEngine: r.ttsEngine === "endpoint" ? "endpoint" : "local",
    ttsBaseUrl: urlOr(r.ttsBaseUrl, DEFAULT_VOICE_CONFIG.ttsBaseUrl),
    ttsModel: textOr(r.ttsModel, DEFAULT_VOICE_CONFIG.ttsModel),
    ttsVoice: textOr(r.ttsVoice, DEFAULT_VOICE_CONFIG.ttsVoice),
    bargeIn: r.bargeIn === false ? false : true,
    // v0.9.9: only a literal `false` turns the voice Shield scan
    // off — the same defensive shape as bargeIn, because the safe
    // failure for a mis-typed value is the scanned behavior.
    shieldScan: r.shieldScan === false ? false : true,
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
 *  and each half either runs built-in or names an endpoint
 *  service. Presence only — the readout never carries the URLs
 *  themselves into the status summary. */
export function voiceConfigured(config: VoiceConfig): boolean {
  if (!config.enabled) return false;
  const sttOk = config.sttEngine === "local" || config.sttBaseUrl.length > 0;
  const ttsOk = config.ttsEngine === "local" || config.ttsBaseUrl.length > 0;
  return sttOk && ttsOk;
}
