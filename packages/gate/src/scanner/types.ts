/**
 * PORTED VERBATIM from agent-shield-scan (scanner-cli/src/types.ts,
 * agent-shield-scan-wt @ scanner-cli 0.3.1) — GUS Phase 4 skill-install
 * gate (foundation spec §1.7, choke point 2). The scanner CLI remains
 * the canonical home of this code; this port exists so the control
 * plane can run the identical local checks as a library call, with no
 * network and no subprocess. Keep in sync deliberately, never silently.
 *
 * Shared scan types for agent-shield-scan (Agent-Shield by StarTek).
 */

export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export type TargetType = "skill" | "mcp-config" | "mcp-server" | "generic";

export interface Finding {
  /** Check ID from the spec catalog: S1–S11, or HOSTED for --deep findings */
  check: string;
  /** Which engine produced the finding (spec §3: origins never blur) */
  origin?: "local" | "hosted";
  /** Engine pattern/signal class, e.g. "aws_key", "instruction_override" */
  pattern: string;
  severity: Severity;
  /** Path relative to the target root, POSIX separators */
  file: string;
  /** 1-based line number, when locatable */
  line: number | null;
  /** CWE mapping, when the check has one (spec §2) */
  cwe: string | null;
  /** Plain-English one-sentence summary (novice language) */
  summary: string;
  /** Technical detail — never contains secret values */
  detail: string;
}

export interface ScannedFile {
  /** Absolute path on disk */
  absPath: string;
  /** Path relative to target root, POSIX separators */
  relPath: string;
  /** File contents (utf8). Guaranteed non-binary by the walker. */
  text: string;
  sizeBytes: number;
}

export interface WalkResult {
  files: ScannedFile[];
  skippedBinary: number;
  skippedTooLarge: number;
  skippedUnreadable: number;
}

/** One hosted scan's signed Protocol receipt (spec §3). */
export interface ReceiptRef {
  /** Tree relPath the receipt's scan covered, or "(tree manifest)" */
  file: string;
  receipt_id: string;
  verify_url: string;
  verdict: string;
}

export interface ScanReport {
  schema: 1;
  scanner: { name: string; version: string; by: string };
  target: string;
  target_type: TargetType;
  mode: "local" | "hosted";
  timestamp: string;
  /** Hosted mode only: the receipt bound to this report (over the tree
   *  manifest), plus every per-file receipt. Absent in local mode —
   *  a local report is never described as a signed receipt. */
  receipt_id?: string;
  receipt_verify_url?: string;
  hosted?: {
    files_scanned: number;
    files_truncated: number;
    files_skipped_over_cap: number;
    receipts: ReceiptRef[];
    /** Set when --deep failed and --allow-local-fallback let the run
     *  complete as a local scan; the report states the fallback occurred. */
    fallback?: string;
  };
  /** SHA-256 over the scanned tree manifest (paths + per-file digests) */
  content_hash: string;
  files_scanned: number;
  files_skipped: { binary: number; too_large: number; unreadable: number };
  verdict: "clean" | "review" | "do_not_install";
  fail_on: string;
  findings: Finding[];
}

export interface ScanConfig {
  failOn: Severity | "never";
  ignore: string[];
}
