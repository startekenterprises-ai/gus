/**
 * Sentence splitting for streamed speech (v0.9.1).
 *
 * A live call cannot wait for a whole reply before it starts
 * talking: the reply is synthesized sentence by sentence, and the
 * first sentence's audio goes out while the rest is still being
 * made. This splitter is a TTS chunker, not a linguistics engine —
 * it splits after sentence-ending punctuation followed by a
 * space, treats a newline as a boundary, and cuts an over-long
 * sentence at a comma or a space so no single synthesis call (and
 * no single wait) is ever huge. A split in an odd place ("Mr."
 * standing alone) costs a slightly wrong pause, never a wrong
 * word: concatenating the parts reproduces the reply exactly.
 */

const MAX_SENTENCE_CHARS = 240;

export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s*\n\s*/g, "\n").trim();
  if (!normalized) return [];
  const raw: string[] = [];
  for (const block of normalized.split("\n")) {
    // Split after ., !, ?, … when a space follows. The lookbehind
    // anchors on the punctuation itself, so "Wait..." splits once
    // (after the last dot), and "3.5 seconds" never splits (no
    // space after the dot).
    for (const part of block.split(/(?<=[.!?…])\s+/)) {
      const p = part.trim();
      if (p) raw.push(p);
    }
  }
  const out: string[] = [];
  for (const part of raw) {
    let rest = part;
    while (rest.length > MAX_SENTENCE_CHARS) {
      const window = rest.slice(0, MAX_SENTENCE_CHARS);
      const cut = Math.max(
        window.lastIndexOf(", "),
        window.lastIndexOf("; "),
        window.lastIndexOf(" "),
      );
      if (cut <= 0) {
        out.push(rest.slice(0, MAX_SENTENCE_CHARS));
        rest = rest.slice(MAX_SENTENCE_CHARS).trim();
      } else {
        out.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1).trim();
      }
    }
    if (rest) out.push(rest);
  }
  return out;
}
