/**
 * The Kokoro voice catalog (v0.17.2) — the voice ids the bundled
 * engine can speak, mirroring kokoro-js's own VOICES table (the
 * library validates against the same list and throws for anything
 * else; the server pre-validates so a bad pick is a clean 400 with
 * the list, not a stack trace).
 *
 * The Settings picker offers the curated eight (af_heart,
 * af_bella, af_nicole, am_michael, am_fenrir, am_puck, bf_emma,
 * bm_george — the same eight as the iPhone app); every other id
 * here is a voice the model genuinely ships, accepted so a config
 * naming one is honored rather than refused.
 */
export const KOKORO_VOICES = [
  "af_heart",
  "af_alloy",
  "af_aoede",
  "af_bella",
  "af_jessica",
  "af_kore",
  "af_nicole",
  "af_nova",
  "af_river",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_echo",
  "am_eric",
  "am_fenrir",
  "am_liam",
  "am_michael",
  "am_onyx",
  "am_puck",
  "am_santa",
  "bf_alice",
  "bf_emma",
  "bf_isabella",
  "bf_lily",
  "bm_daniel",
  "bm_fable",
  "bm_george",
  "bm_lewis",
] as const;

export type KokoroVoice = (typeof KOKORO_VOICES)[number];

export const DEFAULT_KOKORO_VOICE: KokoroVoice = "af_heart";

const VOICE_SET: ReadonlySet<string> = new Set(KOKORO_VOICES);

export function isKokoroVoice(raw: unknown): raw is KokoroVoice {
  return typeof raw === "string" && VOICE_SET.has(raw);
}
