/**
 * PORTED VERBATIM from agent-shield-scan (scanner-cli/src/checks.ts,
 * agent-shield-scan-wt @ scanner-cli 0.3.1) — GUS Phase 4 skill-install
 * gate (foundation spec §1.7, choke point 2). See scanner/types.ts in
 * this directory for the porting note.
 *
 * Check catalog — spec §2 (Phase 0 + Phase 1 complete):
 *
 *   S1 hardcoded secrets            REUSE (LEAK_PATTERNS port)
 *   S2 secrets in MCP config env    REUSE patterns + NEW structure rule
 *   S3 SSRF-prone destinations      REUSE (classifyIp engine port,
 *                                   syntactic only — no DNS, ever)
 *   S4 unauthenticated binding      NEW static pattern set
 *   S5 injection strings in skill   REUSE (scoreInjection port)
 *      markdown and docs
 *   S6 hidden instructions          NEW extraction feeding REUSE views
 *   S7 tool poisoning               REUSE signal families on parsed
 *                                   tool descriptions + NEW parser
 *   S8 shell / exec sinks           NEW static sink catalog (capability)
 *   S9 over-broad permissions       NEW manifest parse + cross-reference
 *   S10 unpinned / typosquat deps   NEW manifest parser + bundled list
 *   S11 credential-file access      NEW path catalog (capability)
 *
 * Claims discipline (spec §6): findings report patterns detected. No
 * runtime benchmark number is ever quoted as this CLI's accuracy.
 */
import { basename } from "node:path";
import {
  classifyHost,
  extractCandidateUrls,
  normalizeDefanged,
  scanLeakOffsets,
  scoreInjection,
} from "./detectors.js";
import { typosquatLookalike } from "./top-packages.js";
import type { Finding, ScannedFile, Severity, TargetType } from "./types.js";
import { isMcpConfigFileName, tryParseJson } from "./walk.js";

export function lineAt(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function isMarkdown(file: ScannedFile): boolean {
  return /\.(md|markdown|mdx|txt|rst)$/i.test(file.relPath);
}

function isConfigLike(file: ScannedFile): boolean {
  return /\.(json|jsonc|yaml|yml|toml|ini|env|conf)$/i.test(file.relPath) ||
    basename(file.relPath).startsWith(".env");
}

// ---------------------------------------------------------------- S1 -----

const S1_SEVERITY: Record<string, Severity> = {
  pem_key: "critical",
  aws_key: "high",
  github_token: "high",
  generic_secret: "high",
  unquoted_secret_assignment: "high",
  ssn: "high",
  credit_card: "high",
};

const S1_LABEL: Record<string, string> = {
  pem_key: "a PEM private key",
  aws_key: "an AWS access key ID",
  github_token: "a GitHub token",
  generic_secret: "a hardcoded secret value in an assignment",
  unquoted_secret_assignment: "a hardcoded secret value in an assignment",
  ssn: "a US Social Security number",
  credit_card: "a payment card number",
};

export function checkS1(file: ScannedFile): Finding[] {
  const findings: Finding[] = [];
  const offsets = scanLeakOffsets(file.text);
  for (const [pattern, hits] of offsets) {
    for (const hit of hits.slice(0, 10)) {
      findings.push({
        check: "S1",
        pattern,
        severity: S1_SEVERITY[pattern] ?? "high",
        file: file.relPath,
        line: lineAt(file.text, hit.start),
        cwe: pattern === "ssn" || pattern === "credit_card" ? null : "CWE-798",
        summary: `This file contains ${S1_LABEL[pattern] ?? "a hardcoded secret"} pasted directly into the artifact.`,
        detail: `Pattern class "${pattern}" matched (value never printed). Rotate the credential if it is real, and load it from an environment variable instead.`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------- S2 -----

/** Credential values that are references or placeholders, not literals. */
function isEnvReference(v: string): boolean {
  const t = v.trim();
  return (
    t === "" ||
    t.startsWith("${") ||
    t.startsWith("$") ||
    /^\{\{.*\}\}$/.test(t) ||
    /^(changeme|example|placeholder|your[-_].*|xxx+|\.\.\.)$/i.test(t)
  );
}

const ENV_SECRET_NAME = /(key|secret|token|password|passwd|credential|auth)/i;

export function checkS2(file: ScannedFile): Finding[] {
  if (!isMcpConfigFileName(file.relPath) && !isConfigLike(file)) return [];
  const obj = tryParseJson(file.text);
  if (!obj) return [];
  const servers = obj["mcpServers"];
  if (!servers || typeof servers !== "object") return [];
  const findings: Finding[] = [];
  for (const [serverName, server] of Object.entries(
    servers as Record<string, unknown>,
  )) {
    if (!server || typeof server !== "object") continue;
    const env = (server as Record<string, unknown>)["env"];
    if (!env || typeof env !== "object") continue;
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      const nameHit = ENV_SECRET_NAME.test(k);
      const patternHits = scanLeakOffsets(v).size > 0;
      if ((nameHit && v.length >= 8 && !isEnvReference(v)) || patternHits) {
        findings.push({
          check: "S2",
          pattern: "mcp_env_literal",
          severity: "high",
          file: file.relPath,
          line: null,
          cwe: "CWE-798",
          summary: `The MCP config stores a literal credential value for "${k}" (server "${serverName}") instead of an environment-variable reference.`,
          detail: `Anyone who can read this config file gets the credential. Use a variable reference and set the value in the launching environment. (Value never printed.)`,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------- S3 -----

const S3_SEVERITY: Record<string, Severity> = {
  cloud_metadata: "critical",
  loopback: "high",
  link_local: "high",
  private: "medium",
  reserved: "medium",
  multicast: "medium",
};

const S3_LABEL: Record<string, string> = {
  cloud_metadata: "a cloud metadata service address (the address cloud servers use for their own credentials)",
  loopback: "this machine itself (loopback)",
  link_local: "a link-local network address",
  private: "a private network address",
  reserved: "a reserved IP address range",
  multicast: "a multicast address",
};

export function checkS3(file: ScannedFile): Finding[] {
  const findings: Finding[] = [];
  const normalized = normalizeDefanged(file.text);
  for (const cand of extractCandidateUrls(file.text)) {
    const cls = classifyHost(cand.host);
    const severity = S3_SEVERITY[cls];
    if (!severity) continue;
    findings.push({
      check: "S3",
      pattern: `ssrf_destination_${cls}`,
      severity,
      file: file.relPath,
      line: lineAt(normalized, cand.offset),
      cwe: "CWE-918",
      summary: `A URL in this file points at ${S3_LABEL[cls]} — the classic server-side request forgery (SSRF) shape.`,
      detail: `Destination ${cand.stripped} classified as "${cls}" by literal/hostname analysis. Local mode never resolves DNS, so a public hostname that resolves to an internal address is out of local scope (hosted --deep covers it).`,
    });
  }
  return findings;
}

// ------------------------------------------------------------- S5 / S6 ---

function injectionSeverity(score: number): Severity | null {
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  if (score >= 0.25) return "low";
  return null;
}

export function checkS5(file: ScannedFile, targetType: TargetType): Finding[] {
  // Spec scopes S5 to skill markdown and bundled docs; Phase 0 keeps the
  // same scoping in MCP/generic trees (docs and readmes) for precision.
  if (!isMarkdown(file)) return [];
  void targetType;
  const { score, signals, rawMatches } = scoreInjection(file.text);
  const severity = injectionSeverity(score);
  if (!severity) return [];
  const names = signals
    .map((s) => s.replace(/^(norm|b64|hex):/, ""))
    .filter((s, i, a) => a.indexOf(s) === i && !s.startsWith("combo:"));
  const line = rawMatches.length > 0 ? lineAt(file.text, rawMatches[0].offset) : null;
  return [
    {
      check: "S5",
      pattern: names[0] ?? "injection_signals",
      severity,
      file: file.relPath,
      line,
      cwe: "CWE-74",
      summary:
        "This document contains wording that reads like instructions to an AI agent — the prompt-injection pattern (telling the agent to ignore its instructions, hide actions, or send data out).",
      detail: `Deterministic signal families matched: ${names.join(", ") || "combination only"} (heuristic score ${score.toFixed(2)}). These are the known commodity injection patterns, not a semantic judgment of intent.`,
    },
  ];
}

/** Decode Unicode tag characters (U+E0000–U+E007F) to their ASCII shadow. */
export function decodeUnicodeTags(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xe0000 && cp <= 0xe007f) {
      out += cp === 0xe0001 ? "" : String.fromCharCode(cp - 0xe0000);
    } else {
      out += ch;
    }
  }
  return out;
}

interface HiddenCarrier {
  kind: string;
  text: string;
  offset: number;
  /** For zero_width carriers: longest suspicious zero-width run length. */
  zwMaxRun?: number;
}

const TAG_RE = /[\u{E0000}-\u{E007F}]/u;

// ---------------------------------------------------------------------------
// S6 precision fixes (2026-11-02 corpus validation: S6 measured 0/18 —
// every sampled hit was an emoji ZWJ sequence in natural-language docs
// or an ordinary skill manifest's frontmatter). Zero-width characters
// are orthography before they are obfuscation: ZWJ/ZWNJ join emoji
// sequences and Arabic/Indic scripts, ZWSP segments Thai. Only
// clusters that fit none of those linguistic shapes count as carriers,
// and standard-manifest frontmatter is the visible, documented
// manifest format — not hidden text. (The same prose still passes
// through S5 in the open, so nothing leaves the scanner's view.)
// ---------------------------------------------------------------------------

const STANDARD_FRONTMATTER_KEYS = new Set([
  "name", "description", "version", "license", "author", "authors",
  "homepage", "repository", "keywords", "tags", "category",
  "allowed-tools", "permissions", "model", "user-invocable",
  "disable-model-invocation", "argument-hint", "context", "agent",
  "hooks", "metadata", "compatibility", "triggers", "icon", "color",
  "display_name", "display-name", "short-description", "publisher",
  "namespace", "transport", "command", "args", "env", "url",
]);

/** True when the frontmatter is a plain key:value manifest whose keys
 *  are all standard manifest keys — the ordinary, visible shape. */
function isStandardManifest(fmText: string): boolean {
  if (fmText.length > 4000) return false;
  let keys = 0;
  for (const line of fmText.split("\n")) {
    if (line.trim() === "") continue;
    if (/^\s/.test(line)) continue; // nested/continuation of previous key
    const m = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (!m) return false;
    if (!STANDARD_FRONTMATTER_KEYS.has(m[1].toLowerCase())) return false;
    keys++;
  }
  return keys > 0;
}

function isPictographicCp(cp: number): boolean {
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) || // pictographs, emoticons, transport
    (cp >= 0x2600 && cp <= 0x27bf) || // misc symbols + dingbats
    (cp >= 0x2b00 && cp <= 0x2bff) || // stars/arrows
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) || // regional indicators
    cp === 0xfe0f || // variation selector-16 (part of emoji presentation)
    cp === 0x203c ||
    cp === 0x2049
  );
}

function isJoiningScriptCp(cp: number): boolean {
  return (
    (cp >= 0x0590 && cp <= 0x08ff) || // Hebrew, Arabic, Syriac, Thaana
    (cp >= 0x0900 && cp <= 0x0dff) || // Indic scripts
    (cp >= 0x0e00 && cp <= 0x0e7f) // Thai / Lao (ZWSP segmentation)
  );
}

const ZW_SET = new Set(["\u200b", "\u200c", "\u200d", "\ufeff"]);

interface ZwCluster {
  start: number;
  length: number; // in UTF-16 code units
  suspicious: boolean;
}

/** Classify maximal zero-width runs: linguistic (emoji joiners,
 *  joining-script orthography, file BOM) vs suspicious. */
function zeroWidthClusters(text: string): ZwCluster[] {
  const clusters: ZwCluster[] = [];
  let i = 0;
  const cpAt = (idx: number): number =>
    idx >= 0 && idx < text.length ? text.codePointAt(idx) ?? -1 : -1;
  const prevCpEnd = (idx: number): number => {
    // code point ending just before idx (handles surrogate pairs)
    if (idx <= 0) return -1;
    const c = text.charCodeAt(idx - 1);
    if (c >= 0xdc00 && c <= 0xdfff && idx >= 2) {
      return text.codePointAt(idx - 2) ?? -1;
    }
    return c;
  };
  while (i < text.length) {
    if (!ZW_SET.has(text[i])) {
      i++;
      continue;
    }
    const start = i;
    const runChars = new Set<string>();
    while (i < text.length && ZW_SET.has(text[i])) {
      runChars.add(text[i]);
      i++;
    }
    const prev = prevCpEnd(start);
    const next = cpAt(i);
    const onlyJoiners = [...runChars].every(
      (c) => c === "\u200c" || c === "\u200d",
    );
    let suspicious = true;
    if (start === 0 && runChars.size === 1 && runChars.has("\ufeff")) {
      suspicious = false; // file BOM
    } else if (
      onlyJoiners &&
      (isPictographicCp(prev) || isPictographicCp(next))
    ) {
      suspicious = false; // emoji sequence joiner (ZWJ emoji)
    } else if (
      onlyJoiners &&
      isJoiningScriptCp(prev) &&
      isJoiningScriptCp(next)
    ) {
      suspicious = false; // Arabic/Indic orthographic joiner
    } else if (
      runChars.size === 1 &&
      runChars.has("\u200b") &&
      isJoiningScriptCp(prev) &&
      isJoiningScriptCp(next)
    ) {
      suspicious = false; // ZWSP word segmentation (Thai/Lao/Indic)
    }
    clusters.push({ start, length: i - start, suspicious });
  }
  return clusters;
}

export function extractHiddenCarriers(text: string): HiddenCarrier[] {
  const carriers: HiddenCarrier[] = [];

  // HTML comments
  const commentRe = /<!--([\s\S]*?)-->/g;
  for (const m of text.matchAll(commentRe)) {
    if (m[1].trim().length > 0) {
      carriers.push({ kind: "html_comment", text: m[1], offset: m.index ?? 0 });
    }
  }
  // display:none / visibility:hidden / hidden-attribute blocks
  const hiddenRe =
    /<(?:span|div|p|section)[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|\shidden(?:\s|=|>))[^>]*>([\s\S]*?)<\/(?:span|div|p|section)>/gi;
  for (const m of text.matchAll(hiddenRe)) {
    const inner = m[1].replace(/<[^>]+>/g, " ").trim();
    if (inner.length > 0) {
      carriers.push({ kind: "hidden_block", text: inner, offset: m.index ?? 0 });
    }
  }
  // YAML frontmatter — a carrier only when it is NOT the ordinary
  // manifest shape (standard-manifest frontmatter is visible metadata,
  // and its text is still scored in the open by S5).
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm && !isStandardManifest(fm[1])) {
    carriers.push({ kind: "frontmatter", text: fm[1], offset: 0 });
  }
  // Invisible characters: Unicode tag block, else SUSPICIOUS zero-width
  // clusters (linguistic zero-width usage is not a carrier at all).
  if (TAG_RE.test(text)) {
    const decoded = decodeUnicodeTags(text).trim();
    if (decoded.length > 0) {
      carriers.push({
        kind: "unicode_tags",
        text: decoded,
        offset: text.search(TAG_RE),
      });
    }
  } else {
    const suspicious = zeroWidthClusters(text).filter((c) => c.suspicious);
    if (suspicious.length > 0) {
      const stripped = text.replace(/[\u200b-\u200d\ufeff]/g, "");
      carriers.push({
        kind: "zero_width",
        text: stripped,
        offset: suspicious[0].start,
        zwMaxRun: Math.max(...suspicious.map((c) => c.length)),
      });
    }
  }
  return carriers;
}

export function checkS6(file: ScannedFile): Finding[] {
  if (!isMarkdown(file) && !/\.(html?|json)$/i.test(file.relPath)) return [];
  const findings: Finding[] = [];
  for (const carrier of extractHiddenCarriers(file.text)) {
    const { score, signals } = scoreInjection(carrier.text);
    const scored = signals.filter((s) => !s.endsWith("_dampened"));
    if (carrier.kind === "frontmatter" && scored.length === 0) {
      continue; // frontmatter is normal metadata; flag only when it scores
    }
    if (carrier.kind === "html_comment" && scored.length === 0) {
      continue; // ordinary benign comments are not findings
    }
    if (
      carrier.kind === "zero_width" &&
      scored.length === 0 &&
      (carrier.zwMaxRun ?? 0) < 8
    ) {
      // A short suspicious zero-width cluster whose stripped text
      // scores nothing is not, by itself, a finding. Presence alone
      // flags only the long-run shape (>= 8) — data encoded invisibly.
      continue;
    }
    const severity: Severity =
      score >= 0.4 || carrier.kind === "unicode_tags" ? "high" : "medium";
    findings.push({
      check: "S6",
      pattern: `hidden_text_${carrier.kind}`,
      severity,
      file: file.relPath,
      line: lineAt(file.text, carrier.offset),
      cwe: "CWE-74",
      summary:
        "This file hides instruction-like text where a person reviewing it casually would not see it (invisible characters or hidden markup).",
      detail: `Hidden carrier: ${carrier.kind}. Isolated hidden text matched signals: ${scored.join(", ") || "none — flagged on hidden presence alone"}. Hidden instruction text is a finding regardless of what it says.`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------- S8 -----

const EXEC_SINKS: Array<{ name: string; re: RegExp }> = [
  { name: "child_process_exec", re: /\bchild_process\b|\bexec\s*\(|\bexecSync\s*\(|\bspawn\s*\(|\bspawnSync\s*\(|\bexecFile\s*\(/ },
  { name: "shell_true", re: /shell\s*:\s*true/ },
  { name: "python_os_system", re: /\bos\.system\s*\(|\bos\.popen\s*\(/ },
  { name: "python_subprocess", re: /\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(/ },
  { name: "eval_call", re: /\beval\s*\(|new\s+Function\s*\(/ },
  { name: "curl_pipe_shell", re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/ },
  { name: "powershell_exec", re: /\bpowershell(?:\.exe)?\b[^\n]*-(?:enc|encodedcommand)\b/i },
];

export function checkS8(file: ScannedFile): Finding[] {
  const findings: Finding[] = [];
  const lines = file.text.split("\n");
  for (const { name, re } of EXEC_SINKS) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        findings.push({
          check: "S8",
          pattern: `exec_sink_${name}`,
          severity: "medium",
          file: file.relPath,
          line: i + 1,
          cwe: "CWE-78",
          summary:
            "This code can run shell commands or evaluate code. That is a capability, not proof of wrongdoing — it matters when combined with risky destinations or credential access.",
          detail: `Exec sink "${name}" present. Reported as capability (spec S8): severity escalates only in combination (see combination rule).`,
        });
        break; // one finding per sink type per file
      }
    }
  }
  return findings;
}

// --------------------------------------------------------------- S11 -----

const CRED_PATHS: Array<{ name: string; re: RegExp; label: string }> = [
  { name: "aws_dir", re: /~\/\.aws\b|\.aws\/credentials/, label: "AWS credential files (~/.aws)" },
  { name: "ssh_dir", re: /~\/\.ssh\b|\.ssh\/id_[a-z0-9]+/, label: "SSH keys (~/.ssh)" },
  { name: "gcloud_dir", re: /~\/\.config\/gcloud\b|\.config\/gcloud/, label: "Google Cloud credentials (~/.config/gcloud)" },
  { name: "env_file", re: /(?:readFile|open|cat|load|require|import)[^\n]{0,40}\.env\b|\.env['"`]\s*\)/, label: ".env files" },
  { name: "kube_config", re: /~\/\.kube\b|\.kube\/config/, label: "Kubernetes credentials (~/.kube)" },
  { name: "docker_config", re: /~\/\.docker\b|\.docker\/config\.json/, label: "Docker registry credentials (~/.docker)" },
  { name: "browser_profile", re: /(?:Chrome|Chromium|Firefox|Brave)(?:\/|\\|["']|\s)*(?:User Data|Profiles|profile)/i, label: "browser profile/cookie stores" },
  { name: "keychain_api", re: /\bkeytar\b|\bKeychain\b|security\s+find-generic-password|secret-tool\s+lookup|gnome-keyring/i, label: "OS credential-store APIs" },
  { name: "git_credentials", re: /\.git-credentials|~\/\.gitconfig/, label: "stored git credentials" },
];

export function checkS11(file: ScannedFile): Finding[] {
  const findings: Finding[] = [];
  for (const { name, re, label } of CRED_PATHS) {
    const m = re.exec(file.text);
    if (m) {
      findings.push({
        check: "S11",
        pattern: `credential_path_${name}`,
        severity: "medium",
        file: file.relPath,
        line: lineAt(file.text, m.index ?? 0),
        cwe: "CWE-200",
        summary: `This code references ${label}. Reading credential stores is a capability to review — it escalates when combined with command execution or outbound destinations.`,
        detail: `Credential-path reference "${name}" present (capability finding, spec S11).`,
      });
    }
  }
  return findings;
}

// ------------------------------------------------------- combinations ----

/**
 * Spec combination rule: a lone capability finding (S8/S11) is "Review."
 * Capability + an unsafe destination (S3 finding in the same file), or
 * capability + hidden instructions (S6 finding in the same file),
 * escalates to high ("Do not install" territory).
 */
export function applyCombinations(findings: Finding[]): Finding[] {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byFile.get(f.file) ?? [];
    arr.push(f);
    byFile.set(f.file, arr);
  }
  for (const fileFindings of byFile.values()) {
    const hasS3 = fileFindings.some((f) => f.check === "S3");
    const hasS6 = fileFindings.some((f) => f.check === "S6");
    if (!hasS3 && !hasS6) continue;
    for (const f of fileFindings) {
      if ((f.check === "S8" || f.check === "S11") && f.severity === "medium") {
        f.severity = "high";
        f.detail +=
          ` ESCALATED: combined in the same file with ${hasS3 ? "an SSRF-class destination (S3)" : "hidden instructions (S6)"} — capability plus destination/concealment is the exfiltration shape.`;
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------- S4 -----

/**
 * Evidence that a file performs some authentication check. Deliberately
 * a plain keyword family: S4 reports ABSENCE of evidence, worded as
 * "no authentication found in the scanned code" (spec §2) — never as
 * proof the running server is unauthenticated.
 */
const AUTH_EVIDENCE_RE =
  /authorization|bearer|authenticate|require[_-]?auth|check[_-]?auth|verify[_-]?(?:token|auth)|x-api-key|auth[_-]?middleware/i;

const BIND_CONTEXT_RE = /listen\s*\(|bind\s*\(|--host\b|host\s*[:=]|address\s*[:=]/i;

/** Find bind-to-all-interfaces sites: `0.0.0.0` in a bind context. */
export function findBindSites(text: string): Array<{ offset: number; what: string }> {
  const sites: Array<{ offset: number; what: string }> = [];
  const anyRe = /0\.0\.0\.0/g;
  for (const m of text.matchAll(anyRe)) {
    const start = Math.max(0, (m.index ?? 0) - 90);
    const window = text.slice(start, (m.index ?? 0) + 20);
    if (BIND_CONTEXT_RE.test(window)) {
      sites.push({ offset: m.index ?? 0, what: "0.0.0.0 (all IPv4 interfaces)" });
    }
  }
  // Wildcard IPv6 in an explicit listen call.
  const v6Re = /listen\s*\([^)]*["']::["']/g;
  for (const m of text.matchAll(v6Re)) {
    sites.push({ offset: m.index ?? 0, what: ":: (all IPv6 interfaces)" });
  }
  return sites;
}

export function checkS4(file: ScannedFile): Finding[] {
  if (/\.(md|markdown|mdx|txt|rst)$/i.test(file.relPath)) return [];
  const sites = findBindSites(file.text);
  if (sites.length === 0) return [];
  if (AUTH_EVIDENCE_RE.test(file.text)) return [];
  // "No auth in this file" is a file-level claim: one finding per file,
  // anchored at the first bind site.
  const s = sites[0];
  return [
    {
      check: "S4",
      pattern: "bind_all_interfaces_no_auth",
      severity: "high" as Severity,
      file: file.relPath,
      line: lineAt(file.text, s.offset),
      cwe: "CWE-306",
      summary:
        "This code listens on all network interfaces, and no authentication check was found in the same file — anyone who can reach the port may be able to use the service.",
      detail: `Bind address ${s.what} with no authorization/bearer/token check found in this file. Wording matters (spec S4): this reports "no authentication found in the scanned code," not proof the deployed server is unauthenticated — auth may live in another file or a proxy.`,
    },
  ];
}

// ---------------------------------------------------------------- S7 -----

interface ToolDescription {
  text: string;
  toolName: string | null;
  offset: number;
}

/** Extract tool descriptions from parsed JSON (tools arrays, server.json). */
export function extractToolDescriptionsFromJson(
  file: ScannedFile,
): ToolDescription[] {
  const obj = tryParseJson(file.text);
  if (!obj) return [];
  const out: ToolDescription[] = [];
  const walk = (node: unknown, inTools: boolean): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inTools);
      return;
    }
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (
      inTools &&
      typeof rec["description"] === "string" &&
      (rec["description"] as string).length >= 20
    ) {
      out.push({
        text: rec["description"] as string,
        toolName: typeof rec["name"] === "string" ? (rec["name"] as string) : null,
        offset: Math.max(
          0,
          file.text.indexOf((rec["description"] as string).slice(0, 40)),
        ),
      });
    }
    for (const [k, v] of Object.entries(rec)) {
      walk(v, inTools || k === "tools");
    }
  };
  walk(obj, false);
  return out;
}

const DESC_ASSIGN_RE =
  /description\s*[:=]\s*(?:"([^"\n]{20,})"|'([^'\n]{20,})'|`([^`]{20,})`)/g;

/** Extract tool descriptions assigned in JS/TS/Python source. */
export function extractToolDescriptionsFromCode(
  file: ScannedFile,
): ToolDescription[] {
  // Only treat `description:` assignments as TOOL descriptions when the
  // file is tool-shaped (mentions tools / an MCP server API).
  if (!/tool|mcp|server/i.test(file.text)) return [];
  const out: ToolDescription[] = [];
  for (const m of file.text.matchAll(DESC_ASSIGN_RE)) {
    out.push({
      text: m[1] ?? m[2] ?? m[3] ?? "",
      toolName: null,
      offset: m.index ?? 0,
    });
  }
  return out;
}

export function checkS7(file: ScannedFile): Finding[] {
  const descriptions = /\.json$/i.test(file.relPath)
    ? extractToolDescriptionsFromJson(file)
    : extractToolDescriptionsFromCode(file);
  const findings: Finding[] = [];
  for (const d of descriptions) {
    const { score, signals } = scoreInjection(d.text);
    const severity = injectionSeverity(score);
    if (!severity) continue;
    const names = signals
      .map((s) => s.replace(/^(norm|b64|hex):/, ""))
      .filter((s, i, a) => a.indexOf(s) === i && !s.startsWith("combo:"));
    findings.push({
      check: "S7",
      pattern: names[0] ?? "tool_description_directive",
      severity,
      file: file.relPath,
      line: lineAt(file.text, d.offset),
      cwe: "CWE-74",
      summary:
        "A tool description in this file contains wording that instructs the AI model itself (how to behave, what to fetch, what to hide) rather than just describing the tool — the tool-poisoning pattern.",
      detail: `Tool${d.toolName ? ` "${d.toolName}"` : ""} description matched signal families: ${names.join(", ") || "combination only"} (heuristic score ${score.toFixed(2)}). Scope (spec S7): v1 flags suspicious description TEXT only; it does not verify description-vs-implementation mismatch.`,
    });
  }
  return findings;
}

// --------------------------------------------------------------- S10 -----

const FLOATING_SPEC_RE = /^(\*|latest|x|X|>=?\s*[\d*]|)$/;
const REMOTE_SPEC_RE = /^(git\+|git:|https?:\/\/|github:|gitlab:|bitbucket:)/;

export function checkS10PackageJson(file: ScannedFile): Finding[] {
  const obj = tryParseJson(file.text);
  if (!obj) return [];
  const findings: Finding[] = [];
  const depBlocks = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];
  for (const block of depBlocks) {
    const deps = obj[block];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, specRaw] of Object.entries(
      deps as Record<string, unknown>,
    )) {
      if (typeof specRaw !== "string") continue;
      const spec = specRaw.trim();
      if (REMOTE_SPEC_RE.test(spec)) {
        findings.push({
          check: "S10",
          pattern: "dep_remote_url",
          severity: "medium",
          file: file.relPath,
          line: null,
          cwe: null,
          summary: `Dependency "${name}" is fetched from a remote URL or git repository instead of the registry, so its contents are whatever that source serves today.`,
          detail: `Spec "${spec}" in ${block}. Registry packages are versioned and mirrored; direct git/URL dependencies are neither.`,
        });
        continue;
      }
      if (FLOATING_SPEC_RE.test(spec)) {
        findings.push({
          check: "S10",
          pattern: "dep_unpinned",
          severity: "medium",
          file: file.relPath,
          line: null,
          cwe: null,
          summary: `Dependency "${name}" has no pinned version ("${spec || "empty"}"), so every install can silently pull different code.`,
          detail: `Floating range in ${block}. Pin an exact version (or a committed lockfile) so the scanned code is the code that runs.`,
        });
        continue;
      }
      const bare = name.startsWith("@") ? name.split("/").pop() ?? name : name;
      const look = typosquatLookalike(name) ?? typosquatLookalike(bare);
      if (look) {
        findings.push({
          check: "S10",
          pattern: "dep_typosquat_prompt",
          severity: "low",
          file: file.relPath,
          line: null,
          cwe: null,
          summary: `Dependency name "${name}" resembles the well-known package "${look}" — confirm this is the package you intend.`,
          detail:
            "Typosquat check against the bundled top-packages list (a subset — local mode does no registry lookups). This is a prompt to verify, low confidence by nature (spec S10).",
        });
      }
    }
  }
  return findings;
}

export function checkS10Requirements(file: ScannedFile): Finding[] {
  const findings: Finding[] = [];
  const lines = file.text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    if (raw.startsWith("-r ") || raw.startsWith("--")) continue;
    if (REMOTE_SPEC_RE.test(raw) || /^-e\s/.test(raw)) {
      findings.push({
        check: "S10",
        pattern: "dep_remote_url",
        severity: "medium",
        file: file.relPath,
        line: i + 1,
        cwe: null,
        summary:
          "A requirement is installed from a remote URL or editable source instead of the registry, so its contents are whatever that source serves today.",
        detail: `Requirement line uses a direct/editable source. (Source text never reproduced beyond its shape.)`,
      });
      continue;
    }
    const nm = /^([A-Za-z0-9_.\-]+)/.exec(raw);
    if (!nm) continue;
    const name = nm[1].toLowerCase().replace(/_/g, "-");
    const rest = raw.slice(nm[1].length);
    if (!rest.includes("==")) {
      findings.push({
        check: "S10",
        pattern: "dep_unpinned",
        severity: "medium",
        file: file.relPath,
        line: i + 1,
        cwe: null,
        summary: `Requirement "${name}" has no exact version pin (no "=="), so every install can silently pull different code.`,
        detail:
          "Pin exact versions (name==x.y.z) or a hashed lockfile so the scanned code is the code that runs.",
      });
      continue;
    }
    const look = typosquatLookalike(name);
    if (look) {
      findings.push({
        check: "S10",
        pattern: "dep_typosquat_prompt",
        severity: "low",
        file: file.relPath,
        line: i + 1,
        cwe: null,
        summary: `Requirement name "${name}" resembles the well-known package "${look}" — confirm this is the package you intend.`,
        detail:
          "Typosquat check against the bundled top-packages list (a subset — local mode does no registry lookups). A prompt to verify, low confidence by nature (spec S10).",
      });
    }
  }
  return findings;
}

export function checkS10(file: ScannedFile): Finding[] {
  const base = basename(file.relPath);
  if (base === "package.json") return checkS10PackageJson(file);
  if (/^requirements.*\.txt$/i.test(base) || base === "requirements.txt") {
    return checkS10Requirements(file);
  }
  return [];
}

// ---------------------------------------------------------------- S9 -----

interface DeclaredScope {
  kind: "filesystem_root" | "shell" | "wildcard";
  where: string;
  file: string;
  line: number | null;
}

const BROAD_PATH_ARGS = new Set(["/", "~", "$HOME", "${HOME}", "/Users", "/home", "C:\\", "C:/"]);

function collectDeclaredScopes(files: ScannedFile[]): DeclaredScope[] {
  const scopes: DeclaredScope[] = [];
  for (const file of files) {
    // MCP configs: filesystem-server root args / root path args
    if (/\.json$/i.test(file.relPath)) {
      const obj = tryParseJson(file.text);
      const servers = obj?.["mcpServers"];
      if (servers && typeof servers === "object") {
        for (const [name, srv] of Object.entries(
          servers as Record<string, unknown>,
        )) {
          if (!srv || typeof srv !== "object") continue;
          const rec = srv as Record<string, unknown>;
          const args = Array.isArray(rec["args"])
            ? (rec["args"] as unknown[]).filter(
                (a): a is string => typeof a === "string",
              )
            : [];
          const cmd = typeof rec["command"] === "string" ? rec["command"] : "";
          const isFilesystem =
            /filesystem/i.test(cmd) || args.some((a) => /filesystem/i.test(a));
          for (const a of args) {
            if (BROAD_PATH_ARGS.has(a)) {
              scopes.push({
                kind: "filesystem_root",
                where: `server "${name}" is given ${isFilesystem ? "filesystem access to" : "the path"} "${a}"`,
                file: file.relPath,
                line: null,
              });
            }
          }
        }
      }
      // Manifest permission declarations (server.json / package.json style)
      const perms = obj?.["permissions"];
      if (Array.isArray(perms)) {
        for (const p of perms) {
          if (p === "*") {
            scopes.push({ kind: "wildcard", where: `permissions include "*"`, file: file.relPath, line: null });
          } else if (typeof p === "string" && /shell|exec/i.test(p)) {
            scopes.push({ kind: "shell", where: `permissions include "${p}"`, file: file.relPath, line: null });
          }
        }
      }
    }
    // Skill frontmatter: allowed-tools / permissions declarations
    if (basename(file.relPath) === "SKILL.md" || basename(file.relPath) === "skill.md") {
      const fm = file.text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fm) {
        const decl = /^(?:allowed-tools|permissions)\s*:\s*(.+)$/im.exec(fm[1]);
        if (decl) {
          const val = decl[1];
          if (/\*/.test(val)) {
            scopes.push({ kind: "wildcard", where: `the skill manifest allows all tools ("*")`, file: file.relPath, line: 1 });
          } else if (/\b(Bash|shell|exec|terminal)\b/i.test(val)) {
            scopes.push({ kind: "shell", where: `the skill manifest allows shell/command tools`, file: file.relPath, line: 1 });
          }
        }
      }
    }
  }
  return scopes;
}

export function checkS9Tree(files: ScannedFile[]): Finding[] {
  const scopes = collectDeclaredScopes(files);
  if (scopes.length === 0) return [];
  // Cross-reference: what does the scanned code actually touch?
  let hasExec = false;
  let hasCredPath = false;
  for (const f of files) {
    if (!hasExec && EXEC_SINKS.some(({ re }) => re.test(f.text))) hasExec = true;
    if (!hasCredPath && CRED_PATHS.some(({ re }) => re.test(f.text))) hasCredPath = true;
    if (hasExec && hasCredPath) break;
  }
  const touched: string[] = [];
  if (hasExec) touched.push("command execution");
  if (hasCredPath) touched.push("credential-file references");
  return scopes.map((s) => {
    const combined = (s.kind === "filesystem_root" || s.kind === "shell") && touched.length > 0;
    return {
      check: "S9",
      pattern: `broad_scope_${s.kind}`,
      severity: (combined ? "high" : "medium") as Severity,
      file: s.file,
      line: s.line,
      cwe: null,
      summary: combined
        ? `This artifact requests broad access — ${s.where} — and the scanned code also contains ${touched.join(" and ")}, so the broad scope has something dangerous to reach.`
        : `This artifact requests broad access — ${s.where}. The scanned code touches only its own tree (no exec sinks or credential paths found), so confirm the broad scope is intended.`,
      detail:
        "Cross-reference (spec S9): declared scope vs capabilities actually present in the scanned code. Either half alone is low-signal; the combination is the finding.",
    };
  });
}

// ------------------------------------------------------------- runner ----

/** Run the full per-file catalog over one file. */
export function scanFile(file: ScannedFile, targetType: TargetType): Finding[] {
  return [
    ...checkS1(file),
    ...checkS2(file),
    ...checkS3(file),
    ...checkS4(file),
    ...checkS5(file, targetType),
    ...checkS6(file),
    ...checkS7(file),
    ...checkS8(file),
    ...checkS10(file),
    ...checkS11(file),
  ];
}

/** Run the full catalog over a tree: per-file checks + S9 cross-reference
 *  + the combination rule. */
export function scanTree(
  files: ScannedFile[],
  targetType: TargetType,
): Finding[] {
  const findings = files.flatMap((f) => scanFile(f, targetType));
  findings.push(...checkS9Tree(files));
  return applyCombinations(findings);
}
