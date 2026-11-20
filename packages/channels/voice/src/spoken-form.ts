/**
 * Spoken form (v0.14.7): what is written is not what should be
 * said. Every delivery this channel speaks passes through
 * VoiceAdapter.send, and host system notices composed for TEXT
 * surfaces ride the same funnel — on 2026-11-19 a Governor cap
 * refusal was read aloud verbatim ("per-day token cap 200000
 * would be exceeded"), because the notice built for the panel
 * and Telegram names the cap, the number, and the ledger. A
 * spoken surface gets spoken sentences instead.
 *
 * The transform, in order:
 *   1. Whole-notice rewrites: the host's known system notices
 *      (cap reached, action denied, reply withheld) become one
 *      short, plain, actionable spoken line each. The precise
 *      text still exists where precision belongs — the job
 *      record, the receipts, the panel, Telegram.
 *   2. A sentence pass over everything else (model replies
 *      included): a sentence carrying spend-cap jargon or a
 *      bare token count is dropped — spoken, it can only ever
 *      be noise — and raw record ids are replaced by the words
 *      a person would use ("the job", "a receipt").
 *   3. Speech cleanup: emoji, markdown emphasis, and code
 *      backticks never reach the synthesizer.
 *
 * If the sentence pass drops EVERYTHING, the reply was a system
 * notice in a shape rule 1 doesn't know yet — the operator
 * hears the generic limit line, never silence and never jargon.
 * Ordinary replies pass through untouched apart from rule 3.
 *
 * THE EXEMPTION: the approval read-back surface never passes
 * through here at all. The park notice and the approve/deny
 * resolutions carry the hash-bound action summary the operator
 * confirms against — the voice design's rule is that the words
 * heard are the words on the record, verbatim, emoji included.
 * Paraphrasing them for speech would break the confirmation.
 */

const CAP_LINE =
  "Heads up — I've hit my usage limit for today, so that stopped. " +
  "You can raise the limit in Settings, under Protection, Budget.";
const DENIED_LINE = "That action was blocked by my safety rules, so it didn't run.";
const WITHHELD_LINE =
  "I had a reply, but it was withheld because it looked like it contained a secret.";
const LIMIT_LINE = "That hit a limit on my side, so it didn't finish.";

/** Sentences matching any of these are system bookkeeping, not
 *  conversation: dropped from spoken form. Deliberately narrow —
 *  a bare "tokens" or "governor" in ordinary speech is the
 *  operator's business, not the filter's. */
const JARGON: RegExp[] = [
  /token cap/i,
  /per-day cap/i,
  /per-job cap/i,
  /spend cap/i,
  /cap_exceeded/i,
  /would be exceeded/i,
  /failed-loudly/i,
  /Governor cap/,
  /the ledger shows/i,
  /\b\d[\d,]*\s+tokens\b/i,
];

/** Record ids are unpronounceable; spoken, they become the noun. */
const ID_SCRUB: [RegExp, string][] = [
  [/\bjob_[a-z0-9_]+\b/gi, "the job"],
  [/\b(?:gus_)?rcpt_[0-9a-z]+\b/gi, "a receipt"],
];

function speechCleanup(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u{FE0E}\u{FE0F}]/gu, "")
    .replace(/\*\*|__|[*_`]/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The spoken form of a delivery text. Pure; the input is the
 *  host's (already egress-screened) delivery, the output is what
 *  the call actually says. */
export function toSpokenForm(text: string): string {
  const raw = text.trim();
  if (!raw) return raw;

  // The approval read-back exemption (see the header): park
  // notices and resolutions pass verbatim. The resolution's
  // "🚫 Denied: " (colon after Denied) is a different template
  // from the policy denial's "🚫 Denied by the control plane"
  // below — the distinction is deliberate on both sides.
  if (
    raw.startsWith("⏸ Job parked") ||
    raw.startsWith("✅ Approved") ||
    raw.startsWith("🚫 Denied: ")
  ) {
    return raw;
  }

  // Rule 1: whole-notice rewrites, keyed on the host templates'
  // openings (channel-host.ts) — those strings are the contract.
  if (raw.startsWith("💸 Governor cap reached")) return CAP_LINE;
  if (raw.startsWith("🚫 Denied by the control plane")) return DENIED_LINE;
  if (raw.startsWith("[A reply was withheld by secret-guard")) return WITHHELD_LINE;

  // Rule 2: the sentence pass. Matches tile the input, so the
  // kept text is rejoined with NO separator — the original
  // spacing and punctuation survive byte-for-byte (a filename
  // like report.md splits at its dot and must rejoin as
  // report.md, not "report. md").
  const sentences = raw.match(/[^.!?]+[.!?]+["')\]]*|\S[^.!?]*$/g) ?? [raw];
  const kept: string[] = [];
  let dropped = 0;
  for (const s of sentences) {
    const sentence = s.trim();
    if (!sentence) continue;
    if (JARGON.some((re) => re.test(sentence))) {
      dropped += 1;
      continue;
    }
    let out = s;
    for (const [re, noun] of ID_SCRUB) out = out.replace(re, noun);
    kept.push(out);
  }
  if (kept.length === 0) return dropped > 0 ? LIMIT_LINE : speechCleanup(raw);
  return speechCleanup(kept.join(""));
}
