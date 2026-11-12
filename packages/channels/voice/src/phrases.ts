/**
 * Voice speech acts (v0.9) — the exact phrases that carry control
 * meaning when the operator is talking instead of typing.
 *
 * Voice is the least reliable input surface GUS has: a transcript
 * is a guess about what a person said, in a room, possibly with a
 * TV on. So the control vocabulary is deliberately TINY and matched
 * EXACTLY (after normalization) — never fuzzily, never by keyword
 * spotting inside a longer sentence:
 *
 *   - KILL phrases map to the channel's existing /stop: the
 *     Governor kill switch, through the same host path a typed
 *     /stop takes. "GUS stop" exists because bare "stop" is a word
 *     people also say mid-sentence to the dog.
 *   - CONFIRM phrases are the ONLY utterances that can resolve a
 *     parked approval from voice, and they resolve it by becoming
 *     the channel's existing /approve <id> command — voice adds no
 *     resolution path of its own. A plain "yes" is deliberately NOT
 *     a confirm: it is the most ambiguous word in speech. The
 *     read-back the operator heard names the phrases that count.
 *   - DENY phrases become /deny <id>, likewise.
 *   - EVERYTHING else, while an approval is parked, resolves
 *     nothing: ambiguous = no. The operator is told a clear answer
 *     is still needed and nothing has run.
 *
 * With nothing parked, an utterance that is not a kill phrase is
 * simply the job text — a confirm phrase with nothing to confirm
 * is just words, exactly as a typed "approve" with no id is just a
 * chat message in the host.
 */

export type VoicePhrase =
  | { kind: "kill" }
  | { kind: "confirm" }
  | { kind: "deny" }
  | { kind: "utterance" };

/** Lowercase, drop punctuation, collapse whitespace — the only
 *  forgiveness matching gets. "Yes, do it!" and "yes do it" are
 *  the same speech act; "yes, do it later" is a different one. */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.!?,;:'"“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const KILL_PHRASES = new Set(["stop", "gus stop", "stop gus", "stop now", "gus stop now"]);

const CONFIRM_PHRASES = new Set([
  "confirm",
  "yes do it",
  "do it",
  "yes confirm",
  "confirmed",
  "proceed",
  "go ahead",
]);

const DENY_PHRASES = new Set([
  "no",
  "deny",
  "denied",
  "cancel",
  "cancel it",
  "do not do it",
  "don t do it",
  "never mind",
  "nevermind",
  "no do not",
]);

export function classifyTranscript(text: string): VoicePhrase {
  const n = normalizeTranscript(text);
  if (KILL_PHRASES.has(n)) return { kind: "kill" };
  if (CONFIRM_PHRASES.has(n)) return { kind: "confirm" };
  if (DENY_PHRASES.has(n)) return { kind: "deny" };
  return { kind: "utterance" };
}

/** The spoken instruction that rides along with every read-back,
 *  so the operator always knows which words count. */
export const CONFIRM_INSTRUCTION =
  'Say "confirm" or "yes, do it" to run exactly that, or "no" to deny it. Anything else runs nothing.';
