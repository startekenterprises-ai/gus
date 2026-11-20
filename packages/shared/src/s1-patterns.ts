/**
 * Secret patterns ported from agent-shield-scan (Agent-Shield by StarTek),
 * packages: scanner-cli/src/detectors.ts — LEAK_PATTERNS, SECRET_ALLOWLIST,
 * luhn check, scanLeakOffsets. Ported unchanged, Apache-2.0, same copyright
 * holder (StarTek Enterprise Solutions LLC).
 *
 * INVARIANT carried over from the scanner: findings never carry matched
 * secret VALUES — pattern class + position only.
 */

function luhnOk(digits: string): boolean {
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
}

export const LEAK_PATTERNS: Array<{
  name: string;
  re: RegExp;
  luhn?: boolean;
}> = [
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "credit_card", re: /\b\d{13,19}\b/g, luhn: true },
  { name: "aws_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: "github_token",
    re: /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{22,}\b/g,
  },
  { name: "pem_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: "generic_secret",
    re: /\b(?:password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token)\b\s*[:=]\s*["']([A-Za-z0-9_\-+/=]{20,})["']/gi,
  },
  {
    name: "unquoted_secret_assignment",
    re: /\b(?:aws_access_key_id|password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|key(?:\s+i\s+used)?)\b\s*[:=]\s*(?=[A-Za-z0-9_\-+/=]*[A-Z])(?=[A-Za-z0-9_\-+/=]*[0-9])[A-Za-z0-9_\-+/=]{16,}\b/gi,
  },
];

// Documentation placeholders that must never count as leaked secrets.
export const SECRET_ALLOWLIST = new Set([
  "AKIAIOSFODNN7EXAMPLE",
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "EXAMPLEKEY",
  "YOUR_TOKEN_HERE",
  "FAKE_KEY_MATERIAL_FOR_PARSER_TESTS",
]);

/** Positional matches for leak patterns — positions only, never matched text. */
export function scanLeakOffsets(
  text: string,
): Map<string, Array<{ start: number; end: number }>> {
  const out = new Map<string, Array<{ start: number; end: number }>>();
  for (const { name, re, luhn } of LEAK_PATTERNS) {
    re.lastIndex = 0;
    const hits: Array<{ start: number; end: number }> = [];
    for (const m of text.matchAll(re)) {
      const val = m[1] ?? m[0];
      if (SECRET_ALLOWLIST.has(val)) continue;
      if (luhn && !luhnOk(val)) continue;
      const start = m.index ?? 0;
      hits.push({ start, end: start + m[0].length });
      if (hits.length >= 50) break; // cap per class
    }
    if (hits.length > 0) out.set(name, hits);
  }
  return out;
}
