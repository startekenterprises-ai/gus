/**
 * Voice activity + utterance segmentation for the live call
 * (v0.9.1) — the ears' front end.
 *
 * The call's audio contract is deliberately the dumbest one that
 * streams: raw little-endian PCM16, 16 kHz, mono — the shape the
 * Mac app captures natively and the shape a transcription service
 * ultimately wants. The app POSTs ~250 ms chunks; this module
 * decides, chunk by chunk, where one utterance ends and the next
 * begins, on energy alone (RMS against a threshold). No model, no
 * dependency, nothing learned — a person pausing mid-sentence for
 * less than the trailing-silence window stays one utterance, and
 * room noise below the threshold never starts one.
 *
 * What segmentation produces is PCM; wrapPcm16AsWav puts the WAV
 * container back on for the transcription service, which is the
 * same file shape the 0.9.0 push-to-talk recordings already used.
 */

export const SESSION_SAMPLE_RATE = 16_000;

/** AC energy of one PCM16 chunk, on the int16 scale (0..32767):
 *  the RMS of the samples around their own mean, NOT around
 *  zero. A constant DC offset — a hot converter, a misbehaving
 *  gain stage — carries no sound, and since v0.9.2 it reads as
 *  the silence it is instead of pinning the energy check high
 *  (before the fix, a chunk of pure DC at 5000 read as "speech"
 *  forever and an utterance could only end at the hard cap).
 *  Ordinary speech at a sane mic gain reads in the low
 *  thousands; a quiet room reads in the low hundreds. */
export function chunkRms(pcm: Uint8Array): number {
  const usable = pcm.byteLength - (pcm.byteLength % 2);
  if (usable <= 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, usable);
  const n = usable / 2;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += view.getInt16(i * 2, true);
  mean /= n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) - mean;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/**
 * Peak-normalize an utterance's gain for the transcription
 * service (v0.9.4). Field diagnosis: a quiet-but-real voice —
 * loudest chunk RMS 1356 in the first 0.9.3 call — came back
 * from the transcription service EMPTY, three utterances in a
 * row; the service wasn't broken, the audio was simply too
 * quiet for it. So before an utterance is wrapped for STT, its
 * AC peak (mean-centered, measured exactly as chunkRms
 * measures — a DC offset is not loudness) is lifted toward
 * `targetPeak` int16, with the gain capped at `maxGain` so a
 * near-silent buffer is never amplified into pure noise.
 * Audio already at or above the target, and true silence (AC
 * peak 0), pass through byte-identical — the same buffer back.
 * Samples scale around the chunk's own mean and clamp to the
 * int16 range: a hot DC offset can pin a sample at the rail,
 * never wrap it around to the opposite sign.
 */
export function normalizePcm16Gain(
  pcm: Uint8Array,
  targetPeak = 24_000,
  maxGain = 24,
): Uint8Array {
  const usable = pcm.byteLength - (pcm.byteLength % 2);
  if (usable <= 0) return pcm;
  const view = new DataView(pcm.buffer, pcm.byteOffset, usable);
  const n = usable / 2;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += view.getInt16(i * 2, true);
  mean /= n;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const dev = Math.abs(view.getInt16(i * 2, true) - mean);
    if (dev > peak) peak = dev;
  }
  if (peak === 0 || peak >= targetPeak) return pcm;
  const gain = Math.min(targetPeak / peak, maxGain);
  const out = new Uint8Array(pcm.byteLength);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const scaled = mean + (view.getInt16(i * 2, true) - mean) * gain;
    outView.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(scaled))), true);
  }
  if (out.byteLength > usable) out[out.byteLength - 1] = pcm[pcm.byteLength - 1];
  return out;
}

/** Milliseconds of audio in a PCM16 chunk at the session rate. */
export function chunkMs(pcm: Uint8Array, sampleRate: number = SESSION_SAMPLE_RATE): number {
  return (pcm.byteLength / 2 / sampleRate) * 1000;
}

/** The 44-byte-header WAV container for raw PCM16 samples — the
 *  file shape the transcription endpoint takes. */
export function wrapPcm16AsWav(pcm: Uint8Array, sampleRate: number = SESSION_SAMPLE_RATE): Uint8Array {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true); // PCM fmt chunk size
  v.setUint16(20, 1, true); // audio format: PCM
  v.setUint16(22, 1, true); // channels: mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

export interface SegmenterOptions {
  /** RMS at or above which a chunk counts as speech. */
  threshold?: number;
  /** Trailing silence that closes an utterance. */
  silenceMs?: number;
  sampleRate?: number;
  /** Chunks of pre-speech audio kept and prepended to the next
   *  utterance, so its first syllable isn't clipped by the
   *  threshold decision. */
  preRollChunks?: number;
  /** Hard cap on one utterance; a caller who never pauses gets
   *  cut here rather than growing an unbounded STT payload. */
  maxUtteranceMs?: number;
}

export interface SegmenterPush {
  /** This chunk itself carried speech energy — the session's
   *  idle clock and barge-in both key off this, not off bytes
   *  merely arriving. */
  speech: boolean;
  /** A completed utterance (raw PCM16), when the trailing
   *  silence (or the cap) closed one with this chunk. */
  utterance?: Uint8Array;
  /** When the utterance's speech ended (the trailing silence
   *  started) — the latency clock starts here, not when the
   *  silence window expired. */
  utteranceEndMs?: number;
}

const DEFAULT_THRESHOLD = 350;
const DEFAULT_SILENCE_MS = 700;
const DEFAULT_MAX_UTTERANCE_MS = 120_000;

export class UtteranceSegmenter {
  private threshold: number;
  private silenceMs: number;
  private sampleRate: number;
  private preRollChunks: number;
  private maxUtteranceMs: number;

  private preRoll: Uint8Array[] = [];
  private current: Uint8Array[] | null = null;
  private currentMs = 0;
  private silenceRunMs = 0;
  private speechEndMs = 0;

  constructor(opts?: SegmenterOptions) {
    this.threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
    this.silenceMs = opts?.silenceMs ?? DEFAULT_SILENCE_MS;
    this.sampleRate = opts?.sampleRate ?? SESSION_SAMPLE_RATE;
    this.preRollChunks = opts?.preRollChunks ?? 2;
    this.maxUtteranceMs = opts?.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS;
  }

  /** Whether an utterance is open right now (speech has started
   *  and the trailing silence hasn't closed it yet). */
  get inUtterance(): boolean {
    return this.current !== null;
  }

  push(chunk: Uint8Array, nowMs: number): SegmenterPush {
    const ms = chunkMs(chunk, this.sampleRate);
    const speech = chunkRms(chunk) >= this.threshold;

    if (speech) {
      if (!this.current) {
        // Open: the pre-roll rides in front so the first word
        // keeps the breath it started with.
        this.current = [...this.preRoll];
        this.currentMs = this.preRoll.reduce((a, c) => a + chunkMs(c, this.sampleRate), 0);
        this.preRoll = [];
      }
      this.current.push(chunk);
      this.currentMs += ms;
      this.silenceRunMs = 0;
      this.speechEndMs = nowMs + ms;
      if (this.currentMs >= this.maxUtteranceMs) {
        return { speech, utterance: this.close(), utteranceEndMs: this.speechEndMs };
      }
      return { speech };
    }

    if (this.current) {
      // Trailing audio still belongs to the utterance until the
      // silence window closes it — a transcript with the breath
      // at the end transcribes better than a hard clip.
      this.current.push(chunk);
      this.currentMs += ms;
      this.silenceRunMs += ms;
      if (this.silenceRunMs >= this.silenceMs) {
        return { speech, utterance: this.close(), utteranceEndMs: this.speechEndMs };
      }
      return { speech };
    }

    this.preRoll.push(chunk);
    if (this.preRoll.length > this.preRollChunks) this.preRoll.shift();
    return { speech };
  }

  /** Close whatever utterance is open (the session is ending) —
   *  the partial words are returned rather than dropped; the
   *  caller decides whether a half-sentence deserves a turn. */
  flush(): Uint8Array | undefined {
    return this.current ? this.close() : undefined;
  }

  private close(): Uint8Array {
    const parts = this.current ?? [];
    const total = parts.reduce((a, c) => a + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    this.current = null;
    this.currentMs = 0;
    this.silenceRunMs = 0;
    return out;
  }
}
