/**
 * PORTED VERBATIM from agent-shield-scan (scanner-cli/src/detectors.ts,
 * agent-shield-scan-wt @ scanner-cli 0.3.1) — GUS Phase 4 skill-install
 * gate (foundation spec §1.7, choke point 2). See scanner/types.ts in
 * this directory for the porting note.
 *
 * Agent-Shield by StarTek — scanner-cli detector core.
 *
 * Verbatim ports of the pure, synchronous functions from the hosted
 * scanner's deterministic layer (agent-shield-connector/worker/src/
 * detect.ts, analyzer "heuristic_v5"):
 *
 *   - LEAK_PATTERNS + SECRET_ALLOWLIST + luhn check   (secret scanning)
 *   - normalizeDefanged / URL extraction / normalizeIpLiteral /
 *     classifyIp / METADATA_HOSTS / SSRF_RISK          (SSRF destination
 *     classification — literals and hostnames classified syntactically;
 *     the hosted DNS-resolution path is deliberately NOT ported: local
 *     mode never resolves DNS and never touches the network)
 *   - textViews normalization views (homoglyph / leet / rot13 /
 *     unicode-escape / zero-width / reversed / de-JSON)
 *   - INJECTION_SIGNALS + scoreInjection + combinationBonus
 *
 * Differences from the hosted module, by design:
 *   - Everything is synchronous (node:crypto instead of Web Crypto).
 *   - extractCandidateUrls returns hosts (not just hashes): a local,
 *     on-device report the user reads needs file/line destinations.
 *     Nothing leaves the machine in local mode.
 *   - scoreInjection additionally reports per-signal raw-view matches
 *     with offsets, so findings can carry file line numbers.
 *
 * INVARIANT carried over from detect.ts: findings never carry matched
 * secret VALUES — pattern class + position only.
 */
import { createHash } from "node:crypto";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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

// ---------------------------------------------------------------------------
// Leak patterns (ported unchanged). Raw matches never leave this module
// as values — callers get pattern class + offsets only.
// ---------------------------------------------------------------------------

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

/**
 * Is this Luhn-valid 13-digit value actually an epoch-millisecond
 * timestamp rather than a payment card? (Scanner fix, 2026-11-02
 * corpus validation: 39 of 40 sampled "credit card" findings were
 * 13-digit epoch-ms values in registry metadata JSON, Luhn-valid by
 * chance.) Two shapes are excluded from the card path:
 *
 *   1. The value sits in the plausible epoch-ms band for the software
 *      era (2000-01-01 .. ~2036). Real 13-digit cards carry 3/4
 *      prefixes (>= 3e12), so no genuine PAN falls in this band.
 *   2. Regardless of band, the value is a bare numeric in a JSON
 *      metadata field whose key is timestamp-shaped (…timestamp,
 *      …_at, …At, …time, …date, …epoch, …millis) — the surrounding
 *      metadata-JSON pattern the corpus findings lived in.
 */
function isEpochMillisValue(text: string, start: number, val: string): boolean {
  if (!/^\d{13}$/.test(val)) return false;
  const n = Number(val);
  if (n >= 946_684_800_000 && n < 2_100_000_000_000) return true;
  const before = text.slice(Math.max(0, start - 64), start);
  return /["'][A-Za-z0-9_$-]*(?:timestamp|_at|At|time|date|epoch|millis)["']\s*:\s*$/.test(
    before,
  );
}

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
      // Epoch-millisecond timestamps are metadata, not cards.
      if (luhn && isEpochMillisValue(text, start, val)) continue;
      hits.push({ start, end: start + m[0].length });
      if (hits.length >= 50) break; // cap per class
    }
    if (hits.length > 0) out.set(name, hits);
  }
  return out;
}

// ---------------------------------------------------------------------------
// URL extraction + SSRF classification (ported; DNS resolution excluded)
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s"'<>`]+/gi;
const MAX_URLS = 200; // static tree scan: higher cap than per-message hosted

export interface CandidateUrl {
  /** scheme/host/path with query + fragment stripped (no secrets) */
  stripped: string;
  host: string;
  host_port: number | null;
  /** char offset of the match in the (defang-normalized) source text */
  offset: number;
}

/** Normalize common URL defanging (hxxp, [.] , (dot)) so obfuscated
 *  SSRF targets are still extracted and classified. */
export function normalizeDefanged(text: string): string {
  return text
    .replace(/\bhxxps?:\/\//gi, "http://")
    .replace(/\[\.\]/g, ".")
    .replace(/\(\s*dot\s*\)/gi, ".");
}

export function extractCandidateUrls(text: string): CandidateUrl[] {
  const found: CandidateUrl[] = [];
  const seen = new Set<string>();
  const normalized = normalizeDefanged(text);

  const pushRaw = (raw0: string, offset: number): void => {
    if (found.length >= MAX_URLS) return;
    let raw = raw0.slice(0, 2048);
    // IPv6 zone identifier: strip so IPv4-mapped classification sees the
    // real destination address (see detect.ts CVE-2026-107289 note).
    raw = raw.replace(/\[([0-9A-Fa-f:.]+)(?:%25|%)[^\]]*\]/g, "[$1]");
    let stripped: string;
    let host: string | null = null;
    let port: number | null = null;
    try {
      const u = new URL(raw);
      u.search = "";
      u.hash = "";
      stripped = u.toString();
      host = u.hostname.toLowerCase();
      port = u.port ? parseInt(u.port, 10) : null;
    } catch {
      return;
    }
    if (!host) return;
    if (seen.has(stripped)) return;
    seen.add(stripped);
    found.push({ stripped, host, host_port: port, offset });
  };

  URL_RE.lastIndex = 0;
  for (const m of normalized.matchAll(URL_RE)) {
    if (found.length >= MAX_URLS) break;
    const raw = m[0];
    pushRaw(raw, m.index ?? 0);
    // Open-redirect / 302-chain shape: classify redirect targets embedded
    // in query parameters too — the real destination, not the redirector.
    try {
      const uq = new URL(raw.slice(0, 2048));
      const paramValues: string[] = [];
      uq.searchParams.forEach((v) => paramValues.push(v));
      for (const v of paramValues) {
        URL_RE.lastIndex = 0;
        for (const im of v.matchAll(URL_RE)) {
          if (found.length >= MAX_URLS) break;
          pushRaw(im[0], m.index ?? 0);
        }
        if (found.length >= MAX_URLS) break;
      }
    } catch {
      // Not parseable with params; the outer pass already handled it.
    }
  }
  return found;
}

/** Normalize non-standard IPv4 literals to dotted decimal before
 *  classification (0x7f000001, 2130706433, 017700000001, 0x7f.0.0.1 …). */
export function normalizeIpLiteral(host: string): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  const asInt = (s: string): number | null => {
    if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s, 16);
    if (/^0[0-7]+$/.test(s) && s.length > 1) return parseInt(s, 8);
    if (/^[0-9]+$/.test(s)) {
      const n = parseInt(s, 10);
      return n >= 0 && n <= 0xffffffff ? n : null;
    }
    return null;
  };
  const single = asInt(h);
  if (single !== null && !h.includes(".") && !h.includes(":")) {
    return [
      (single >>> 24) & 255,
      (single >>> 16) & 255,
      (single >>> 8) & 255,
      single & 255,
    ].join(".");
  }
  if (h.includes(".")) {
    const parts = h.split(".");
    if (parts.length === 4) {
      const nums: number[] = [];
      for (const p of parts) {
        const n = asInt(p);
        if (n === null || n > 255) return host;
        nums.push(n);
      }
      return nums.join(".");
    }
  }
  return host;
}

/** Classify an IP per the SSRF taxonomy. Order matters. (Ported unchanged.) */
export function classifyIp(ip: string): string {
  const norm = normalizeIpLiteral(ip);
  const v4 = norm.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) return "invalid";
    const [a, b] = o;
    if (a === 169 && b === 254) return "cloud_metadata"; // 169.254.0.0/16
    if (a === 127) return "loopback"; // 127.0.0.0/8
    if (a === 10) return "private"; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
    if (a === 192 && b === 168) return "private"; // 192.168.0.0/16
    if (a >= 224 && a <= 239) return "multicast";
    if (a === 0 || a >= 240) return "reserved";
    return "public";
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v6 === "::1") return "loopback";
  if (v6.startsWith("fe80:")) return "link_local"; // fe80::/10
  if (v6.startsWith("fc") || v6.startsWith("fd")) return "private"; // fc00::/7
  if (v6.startsWith("ff")) return "multicast";
  const mappedHex = v6.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const g1 = parseInt(mappedHex[1], 16), g2 = parseInt(mappedHex[2], 16);
    return classifyIp([(g1 >> 8) & 255, g1 & 255, (g2 >> 8) & 255, g2 & 255].join("."));
  }
  const mapped4 = v6.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped4) return classifyIp(mapped4[1]);
  const nat64Hex = v6.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (nat64Hex) {
    const g1 = parseInt(nat64Hex[1], 16), g2 = parseInt(nat64Hex[2], 16);
    return classifyIp([(g1 >> 8) & 255, g1 & 255, (g2 >> 8) & 255, g2 & 255].join("."));
  }
  const nat64v4 = v6.match(/^64:ff9b::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (nat64v4) return classifyIp(nat64v4[1]);
  const nat64LocalHex = v6.match(/^64:ff9b:1::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (nat64LocalHex) {
    const g1 = parseInt(nat64LocalHex[1], 16), g2 = parseInt(nat64LocalHex[2], 16);
    return classifyIp([(g1 >> 8) & 255, g1 & 255, (g2 >> 8) & 255, g2 & 255].join("."));
  }
  if (/^[0-9a-f:]+$/.test(v6) && v6.includes(":")) {
    const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return classifyIp(mapped[1]);
    return "public";
  }
  return "invalid";
}

export const SSRF_RISK: Record<string, number> = {
  cloud_metadata: 1.0,
  loopback: 0.9,
  link_local: 0.8,
  private: 0.7,
  reserved: 0.6,
  multicast: 0.6,
  public: 0.05,
  invalid: 0.0,
  unresolved: 0.0,
};

/** Well-known cloud metadata hostnames (exact match, trailing dot stripped).
 *  These names are reserved for the metadata service itself, so matching
 *  them carries no false-positive risk for ordinary content. */
export const METADATA_HOSTS: Record<string, string> = {
  "metadata.google.internal": "cloud_metadata",
  "instance-data-compute-internal": "cloud_metadata",
};

/** Classify a URL hostname WITHOUT any DNS resolution: IP literals go
 *  through classifyIp; known metadata hostnames match exactly; "localhost"
 *  is loopback by definition; anything else is "hostname" (unresolved by
 *  design in local mode — resolution is a hosted-mode capability). */
export function classifyHost(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (METADATA_HOSTS[h]) return METADATA_HOSTS[h];
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
  if (/^[0-9.]+$/.test(h) || h.includes(":") || /^0x[0-9a-f]+$/i.test(h)) {
    return classifyIp(h);
  }
  return "hostname";
}

// ---------------------------------------------------------------------------
// Text normalization views (ported unchanged from detect.ts)
// ---------------------------------------------------------------------------

const HOMOGLYPH_MAP: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u0456": "i", "\u043e": "o", "\u0440": "p",
  "\u0441": "c", "\u0445": "x", "\u0443": "y", "\u043a": "k", "\u043c": "m",
  "\u043d": "h", "\u03b1": "a", "\u03b5": "e", "\u03bf": "o", "\u03c1": "p",
};

function normalizeHomoglyphs(text: string): string {
  return text.replace(
    /[\u0430\u0435\u0456\u043e\u0440\u0441\u0445\u0443\u043a\u043c\u043d\u03b1\u03b5\u03bf\u03c1]/g,
    (ch) => HOMOGLYPH_MAP[ch] ?? ch,
  );
}

function normalizeLeet(text: string): string {
  return text
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/@/g, "a")
    .replace(/\$/g, "s");
}

function rot13(text: string): string {
  return text.replace(/[a-zA-Z]/g, (ch) => {
    const base = ch <= "Z" ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function decodeUnicodeEscapes(text: string): string {
  if (!/\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/.test(text)) return text;
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function tryHexDecode(s: string): string | null {
  const compact = s.replace(/0x|\s+/gi, "");
  if (!/^[0-9a-fA-F]{40,}$/.test(compact) || compact.length % 2 !== 0) return null;
  try {
    let out = "";
    for (let i = 0; i < compact.length; i += 2) {
      out += String.fromCharCode(parseInt(compact.slice(i, i + 2), 16));
    }
    if (!/^[\x20-\x7e\s]{10,}$/.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

const HEX_RE = /(?:0x[0-9a-fA-F]{2}(?:\s*0x[0-9a-fA-F]{2}){10,}|[0-9a-fA-F]{40,})/g;

/** Build the set of text views to score: raw + normalized variants. */
export function textViews(text: string): string[] {
  const views = [text];
  const noZw = text.replace(/[\u200b-\u200d\ufeff]/g, "");
  if (noZw !== text) views.push(noZw);
  const noZwSpaced = text.replace(/[\u200b-\u200d\ufeff]/g, " ");
  if (noZwSpaced !== text && noZwSpaced !== noZw) views.push(noZwSpaced);
  views.push(normalizeHomoglyphs(noZw));
  views.push(normalizeLeet(noZw));
  views.push(rot13(noZw));
  const unescaped = decodeUnicodeEscapes(noZw);
  if (unescaped !== noZw) views.push(unescaped);
  views.push([...noZw].reverse().join(""));
  const dejson = noZw
    .replace(/"\s*,\s*"/g, " ")
    .replace(/[{}\[\]]/g, " ")
    .replace(/\\"/g, '"');
  if (dejson !== noZw) views.push(dejson);
  return [...new Set(views)];
}

// ---------------------------------------------------------------------------
// Injection signals (ported unchanged from detect.ts)
// ---------------------------------------------------------------------------

const OVERRIDE_VERBS =
  "ignor(e|ing)|disregard|forget|drop|overrid(e|ing)|abandon|bypass|defy|" +
  "cancel|void|nullify|eras(e|ing)|rescind|supersed(e|ing)|throw\\s+out|" +
  "set\\s+aside|stop\\s+following|do\\s+not\\s+follow";
const OVERRIDE_TARGETS =
  "instructions?|guidelines?|rules?|constraints?|safety(\\s+rules|\\s+training)?|" +
  "content\\s+polic(y|ies)|guardrails?|directives?|training|alignment|" +
  "system(\\s+prompt)?|prior\\s+context|all\\s+rules";

export const INJECTION_SIGNALS: Array<{ name: string; re: RegExp; weight: number }> = [
  {
    name: "instruction_override",
    re: new RegExp(
      `(?:${OVERRIDE_VERBS})\\s+(?:your\\s+|the\\s+|all\\s+|previous\\s+|prior\\s+|my\\s+|current\\s+)*(?:${OVERRIDE_TARGETS})`,
      "i",
    ),
    weight: 0.45,
  },
  {
    name: "system_prompt_extraction",
    re: /reveal\s+(your\s+|the\s+)?system\s+(prompt|instructions)|disclose\s+(your\s+)?(system\s+|initial\s+)?(prompt|instructions)|print\s+(your\s+|the\s+)?(instructions|system\s+prompt)\s+verbatim|what\s+are\s+your\s+(exact\s+)?instructions|output\s+everything\s+above|repeat\s+after\s+me|translate\s+your\s+system\s+prompt|list\s+(every|all)\s+instructions?|read\s+back\s+(the\s+)?(full\s+)?system\s+prompt|show\s+me\s+the\s+script|quote\s+(them|it)\s+exactly|system\s+prompt\s+verbatim|exfiltrat(e|ing)\s+your\s+own\s+system\s+prompt/i,
    weight: 0.45,
  },
  {
    name: "role_spoofing",
    re: /\[(system|admin|developer|privileged|moderator)\]|<(system|admin|sys)\b|<<\s*sys\s*>>|#{2,}\s*system\b|system\s+(note|notice|override|transcript)\b|internal\s+memo\b|debug\s+mode\b|sudo\s+mode\b|role\s*:\s*system\b|begin\s+system\s+transcript/i,
    weight: 0.35,
  },
  {
    name: "authority_claim",
    re: /you\s+are\s+now\b(?! a helpful)|from\s+now\s+on,?\s+you\s+(are|will)|new\s+(instructions|directive|system\s+update)\s*:|you\s+are\s+(dan|venom)\b|unrestricted\s+mode|no\s+(restrictions|safety\s+rules)|never\s+refuse|policy\s+disabled|safety\s+(interlocks?\s+disengaged|filters?\s+disabled|layer\s+(was\s+)?removed)/i,
    weight: 0.3,
  },
  {
    name: "exfiltration_directive",
    re: /(forward|send|exfiltrate|upload|post|export|email)\s+.{0,60}(api[_-]?key|secret|token|password|credential|database|contact\s+list|environment\s+variables|chat)/i,
    weight: 0.5,
  },
  {
    name: "hidden_instruction",
    re: /<!--[\s\S]{0,800}?(system|instruction|forward|ignore|assistant)[\s\S]{0,800}?-->|\(hidden\s*:|<span[^>]*display\s*:\s*none[^>]*>/i,
    weight: 0.4,
  },
  {
    name: "embedded_assistant_directive",
    re: /\bassistant\s*[:,]\s*(ignore|disregard|cancel|delete|send|email|forward|disable|mark|recommend|omit|skip|share|export|upload|post|reveal|list|read|execute|run|revert|approve|deny|rank|pin|feature|update|tell|say|cite|assure|round|always|never|whenever|when|if)\b/i,
    weight: 0.4,
  },
  {
    name: "jailbreak_persona",
    re: /\bdan\b.{0,30}do\s+anything\s+now|do\s+anything\s+now|jailbreak|no\s+restrictions|without\s+restrictions|unfiltered|i\s+am\s+(your\s+)?developer\b|as\s+(your|the)\s+developer|policy\s+update|internal\s+memo|alignment\s+team|red\s+team|oversight\s+board|compliance\s+test|emergency\s+protocol/i,
    weight: 0.4,
  },
  {
    name: "concealment_directive",
    re: /do\s*n'?t\s+(mention|tell|inform|notify|show)\s+(the\s+)?user|no\s+need\s+to\s+mention|keep\s+this\s+(between\s+us|confidential|quiet)|don'?t\s+include\s+this\s+in\s+(your|the)\s+(summary|response|report)|without\s+(telling|notifying|alerting)\s+the\s+user/i,
    weight: 0.5,
  },
  {
    name: "imperative_sensitive_action",
    re: /\b(forward|send|email|export|upload|delete|remove|share|reveal|disclose|list|read|fetch|retrieve)\s+(the\s+|all\s+|these\s+)?(messages?|mails?|database|logs?|files?|attachments?|documents?|credentials?|keys?|tokens?|passwords?|calendar|contacts?|history)\b/i,
    weight: 0.35,
  },
  {
    name: "credential_solicitation_reply",
    re: /\breply\s+(with\s+|to\s+)?(your\s+current\s+)?(session\s+tokens?|passwords?|api[_\s-]?keys?|otps?|2fa|verification\s+codes?|secrets?|credentials?)\b/i,
    weight: 0.5,
  },
];

const ATTRIBUTION_RE =
  /(says?|said|wrote|writes?|according\s+to|for\s+example|such\s+as|e\.g\.|called|titled|article|write-?up|documentation|quoting|quote)[\s\S]{0,120}[""“”]|[""“”][^""“”]{0,300}[""“”]\s*(says?|writes?|notes?|explains?)/i;

function hasAttributionFraming(text: string): boolean {
  return ATTRIBUTION_RE.test(text);
}

const EXTERNAL_CONTACT_RE =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|https?:\/\/[^\s"'<>`]+/i;

function combinationBonus(
  text: string,
  signals: string[],
): { bonus: number; combos: string[] } {
  const has = (...names: string[]) =>
    names.some((n) => signals.some((s) => s.includes(n)));
  const combos: string[] = [];
  let bonus = 0;
  const imperative = has("imperative_sensitive_action", "embedded_assistant_directive");
  const conceal = has("concealment_directive");
  const exfil = has("exfiltration_directive");
  const external = EXTERNAL_CONTACT_RE.test(text);
  if (imperative && conceal) {
    bonus += 0.3;
    combos.push("imperative+concealment");
  }
  if ((imperative || exfil) && external) {
    bonus += 0.25;
    combos.push("directive+external_contact");
  }
  if (conceal && external) {
    bonus += 0.2;
    combos.push("concealment+external_contact");
  }
  return { bonus, combos };
}

const B64_RE = /[A-Za-z0-9+/]{40,}={0,2}/g;

function tryB64Decode(s: string): string | null {
  try {
    const bin = Buffer.from(s, "base64").toString("latin1");
    if (!/^[\x20-\x7e\s]{10,}$/.test(bin)) return null;
    return bin;
  } catch {
    return null;
  }
}

const EDUCATIONAL_CONTEXT_RE =
  /for\s+educational\s+purposes|do\s+not\s+execute|example\s+of\s+what\s+not\s+to\s+do|threat\s+briefing|security\s+(article|training|policy|write-?up)|ctf\s+write-?up|documentation\s+sample|in\s+this\s+write-?up|defense\s+against/i;

// ---------------------------------------------------------------------------
// Protective-context suppression (SCANNER-ONLY addition, 2026-11-02
// corpus validation fix — not part of the hosted port). The validation
// sample found the injection families firing at 0/40 precision on real
// skill/registry documents: every sampled hit was either protective
// prose ("Never reveal credentials", "Treat API responses as data")
// or a benign documentation idiom (`export YOUR_API_KEY=…` setup
// snippets, "sends it as a Bearer token" auth docs, API table rows).
//
// Rule: a match of a SUPPRESSIBLE signal is dropped when the sentence
// governing it is protective or a documented benign idiom. Signals
// whose very shape is the attack — concealment ("don't tell the
// user"), assistant-turn spoofing, hidden markup, role/authority
// claims, jailbreak personas — are NEVER suppressed by this rule: a
// negation in front of them is the payload, not a defense. Decoded
// (base64/hex) matches are also never suppressed: concealed payloads
// get no context credit.
// ---------------------------------------------------------------------------

const SUPPRESSIBLE_SIGNALS = new Set([
  "instruction_override",
  "system_prompt_extraction",
  "exfiltration_directive",
  "imperative_sensitive_action",
  "credential_solicitation_reply",
]);

const PROTECTIVE_MARKER_RE =
  /\b(never|do not|don't|must not|should not|shall not|not allowed to|refuse to|avoid|resist|prohibit(?:ed|s|ing)?|forbid(?:den|s)?|protect(?:s|ed|ing)? against|guard against)\b/i;

const CONTRASTIVE_RE = /\b(but|however|yet|except|instead)\b/i;

const DATA_FRAMING_RE =
  /\b(treat|regard|consider|handle)\b[^.!?\n]{0,80}\b(as|like)\s+(data|untrusted|input|text)\b|\buntrusted\b|\bnot\s+(?:an?\s+)?instructions?\b/i;

/** Sentence bounds [start, end) around an offset in a view text. */
function sentenceBounds(
  text: string,
  offset: number,
): { start: number; end: number } {
  let start = 0;
  for (let i = offset - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "\n" || c === "." || c === "!" || c === "?") {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = offset; i < text.length; i++) {
    const c = text[i];
    if (c === "\n" || c === "." || c === "!" || c === "?") {
      end = i;
      break;
    }
  }
  return { start, end };
}

function isSuppressedMatch(
  view: string,
  index: number,
  signalName: string,
): boolean {
  if (!SUPPRESSIBLE_SIGNALS.has(signalName)) return false;
  const { start, end } = sentenceBounds(view, index);
  const sentence = view.slice(start, end);
  const before = view.slice(start, index);
  const lineStart = view.lastIndexOf("\n", index - 1) + 1;
  const lineEndRaw = view.indexOf("\n", index);
  const line = view.slice(lineStart, lineEndRaw === -1 ? view.length : lineEndRaw);

  // Benign documentation idioms.
  if (signalName === "exfiltration_directive") {
    // Shell setup snippet: `export SOME_API_KEY=…` is how you CONFIGURE
    // a client, not a directive to send data out.
    if (/(^|\s)export\s+[A-Za-z_][A-Za-z0-9_]*=/.test(line)) return true;
  }
  if (
    signalName === "exfiltration_directive" ||
    signalName === "imperative_sensitive_action"
  ) {
    // Auth-mechanism documentation: "sends it as a Bearer token" in a
    // sentence about headers, or plain descriptive prose about one.
    if (
      /\bbearer\b/i.test(sentence) &&
      (/authorization|header/i.test(sentence) ||
        /^\s*(the|this|it|our|the client|the server|the api)\b/i.test(sentence))
    ) {
      return true;
    }
  }
  if (
    signalName === "exfiltration_directive" ||
    signalName === "imperative_sensitive_action"
  ) {
    // Markdown API-reference table row: "| send | message | … |".
    const t = line.trim();
    if (t.startsWith("|") && (t.match(/\|/g) ?? []).length >= 3) return true;
  }

  // Protective framing: the content is treated as data / not instructions.
  if (DATA_FRAMING_RE.test(sentence)) return true;

  // Negation governing the matched verb — unless a contrastive break
  // ("never X, but do Y") re-opens the directive after the marker.
  const marker = PROTECTIVE_MARKER_RE.exec(before);
  if (marker) {
    const afterMarker = before.slice(marker.index + marker[0].length);
    if (!CONTRASTIVE_RE.test(afterMarker)) return true;
  }
  return false;
}

export interface InjectionScore {
  score: number;
  signals: string[];
  /** First raw-view match per base signal name, for line reporting. */
  rawMatches: Array<{ signal: string; offset: number }>;
}

/** Ported scoreInjection: scores every normalized view, decodes base64/hex
 *  blobs, applies the same dampeners and combination bonus as hosted. */
export function scoreInjection(text: string): InjectionScore {
  let score = 0;
  const signals: string[] = [];
  const rawMatches: Array<{ signal: string; offset: number }> = [];
  const addSignal = (name: string, weight: number, view: string) => {
    const key = view === "raw" ? name : `${view}:${name}`;
    if (!signals.includes(key)) {
      score += weight;
      signals.push(key);
    }
  };
  let protectiveSuppressed = false;
  for (const view of textViews(text)) {
    const tag = view === text ? "raw" : "norm";
    for (const { name, re, weight } of INJECTION_SIGNALS) {
      re.lastIndex = 0;
      const m = re.exec(view);
      if (m) {
        // Scanner-only protective-context suppression (see above):
        // evaluated per view, against that view's own sentence.
        if (isSuppressedMatch(view, m.index, name)) {
          protectiveSuppressed = true;
          continue;
        }
        addSignal(name, weight * (tag === "raw" ? 1 : 0.9), tag);
        if (tag === "raw" && !rawMatches.some((r) => r.signal === name)) {
          rawMatches.push({ signal: name, offset: m.index });
        }
      }
    }
  }
  if (protectiveSuppressed) signals.push("protective_context_dampened");
  const cleaned = text.replace(/[\u200b-\u200d\ufeff]/g, "");
  const attributed = hasAttributionFraming(cleaned);
  B64_RE.lastIndex = 0;
  for (const m of cleaned.matchAll(B64_RE)) {
    const decoded = tryB64Decode(m[0]);
    if (!decoded) continue;
    for (const { name, re, weight } of INJECTION_SIGNALS) {
      re.lastIndex = 0;
      if (re.test(decoded)) addSignal(name, weight * 0.8, "b64");
    }
  }
  HEX_RE.lastIndex = 0;
  for (const m of cleaned.matchAll(HEX_RE)) {
    const decoded = tryHexDecode(m[0]);
    if (!decoded) continue;
    for (const { name, re, weight } of INJECTION_SIGNALS) {
      re.lastIndex = 0;
      if (re.test(decoded)) addSignal(name, weight * 0.8, "hex");
    }
  }
  if (EDUCATIONAL_CONTEXT_RE.test(cleaned)) {
    score *= 0.5;
    signals.push("educational_context_dampened");
  }
  if (attributed) {
    score *= 0.6;
    signals.push("attribution_framing_dampened");
  }
  const { bonus, combos } = combinationBonus(cleaned, signals);
  if (bonus > 0) {
    score += bonus;
    for (const c of combos) signals.push(`combo:${c}`);
  }
  return { score: Math.min(1, score), signals, rawMatches };
}
