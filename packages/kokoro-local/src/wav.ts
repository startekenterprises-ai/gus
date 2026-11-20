/**
 * WAV encoding for synthesized speech (v0.17.2).
 *
 * Kokoro speaks 24 kHz mono float samples. The speech surface
 * returns 16-bit PCM WAV — the format every player in the chain
 * (the app's audio player, the panel's test playback) already
 * handles, at half the bytes of the float32 WAV the library's
 * own encoder produces. Encoding is done here, by hand, so the
 * bytes are exactly what the header says they are.
 */

export const KOKORO_SAMPLE_RATE = 24_000;

/** Encode mono float samples (clamped to [-1, 1]) as a 16-bit
 *  PCM WAV file image. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number = KOKORO_SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(s * 0x7fff), true);
  }
  return out;
}

/** Concatenate WAV file images produced by encodeWavPcm16 (same
 *  format throughout) into one WAV — used when a long input is
 *  synthesized in sentence chunks. Throws on a foreign WAV: a
 *  format surprise must be loud, not silent corruption. */
export function concatWavPcm16(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 0) return encodeWavPcm16(new Float32Array(0));
  if (parts.length === 1) return parts[0]!;
  let totalSamples = 0;
  for (const part of parts) {
    if (part.length < 44 || String.fromCharCode(...part.slice(0, 4)) !== "RIFF") {
      throw new Error("concatWavPcm16: a part is not a WAV produced by encodeWavPcm16");
    }
    totalSamples += (part.length - 44) / 2;
  }
  const merged = new Float32Array(totalSamples);
  let offset = 0;
  for (const part of parts) {
    const view = new DataView(part.buffer, part.byteOffset, part.byteLength);
    const count = (part.length - 44) / 2;
    for (let i = 0; i < count; i++) {
      merged[offset + i] = view.getInt16(44 + i * 2, true) / 0x7fff;
    }
    offset += count;
  }
  return encodeWavPcm16(merged);
}
