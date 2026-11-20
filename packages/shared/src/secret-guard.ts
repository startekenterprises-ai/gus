/**
 * Secret-guard (foundation spec, Amendment A2).
 *
 * Screens text crossing a trust boundary — channel ingress and egress, and
 * anything headed for a log — using the scanner's S1 patterns + allowlist.
 *
 * Contract:
 * - A hit produces pattern CLASS + offsets only. The secret value is never
 *   returned, logged, or embedded in an error.
 * - `redacted` replaces each matched span with a fixed marker so the
 *   surrounding text remains readable without carrying the secret.
 * - Ingress policy (control plane): a hit means REFUSE — the original text
 *   is not forwarded to the agent, not stored, and not put in context; the
 *   user gets a warning built from the class names only.
 * - Documented limit ( Amendment A2): GUS cannot unsend what other people
 *   already saw. It only stops itself from ingesting or propagating.
 */
import { scanLeakOffsets } from "./s1-patterns.js";

export interface SecretFinding {
  /** Pattern class, e.g. "aws_key" | "github_token" | "generic_secret". */
  patternClass: string;
  start: number;
  end: number;
}

export interface ScreenResult {
  clean: boolean;
  findings: SecretFinding[];
  /** Input with each matched span replaced by a marker; safe to log. */
  redacted: string;
}

export function redactSpan(patternClass: string): string {
  return `[secret refused: ${patternClass}]`;
}

export function screenText(text: string): ScreenResult {
  const byClass = scanLeakOffsets(text);
  const findings: SecretFinding[] = [];
  for ( const [patternClass, spans] of byClass) {
    for (const s of spans) findings.push({ patternClass, ...s });
  }
  findings.sort((a, b) => a.start - b.start);
  if (findings.length === 0) return { clean: true, findings, redacted: text };
  // Redact from the end so earlier offsets stay valid. Overlapping spans
  // from different classes are merged by construction of the walk: if a
  // span starts inside the previous replaced region, skip it.
  let out = text;
  const ordered = [...findings].sort((a, b) => b.start - a.start);
  let lastStart = Infinity;
  for (const f of ordered) {
    if (f.end > lastStart) continue;
    out = out.slice(0, f.start) + redactSpan(f.patternClass) + out.slice(f.end);
    lastStart = f.start;
  }
  return { clean: false, findings, redacted: out };
}

/** The only shape of a secret-guard event that may be written to a log. */
export interface SecretGuardEvent {
  kind: "secret_guard_refusal";
  direction: "ingress" | "egress" | "log";
  patternClasses: string[];
  /** Redacted text only. Guaranteed free of matched secret values. */
  redacted: string;
}

export function guardEvent(
  direction: SecretGuardEvent["direction"],
  result: ScreenResult,
): SecretGuardEvent {
  return {
    kind: "secret_guard_refusal",
    direction,
    patternClasses: [...new Set(result.findings.map((f) => f.patternClass))],
    redacted: result.redacted,
  };
}
