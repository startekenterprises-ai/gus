/**
 * Skill-install gate (foundation spec §1.7, choke point 2) — Phase 4.
 *
 * No skill is admitted unless the agent-shield-scan local checks return
 * a passing verdict. The checks are the scanner CLI's own catalog,
 * ported verbatim into ./scanner/ and run here as a library call: no
 * subprocess, no network, no DNS. The verdict rule is the CLI's own
 * (cli.ts): any finding at high severity or above is do_not_install;
 * any finding at all is review; none is clean. GUS refuses
 * do_not_install outright — v1 has no override button (spec §1.7:
 * "there is no 'we'll moderate later'").
 *
 * The same entry point scans MCP server configs before first connect
 * (choke point 3): pass a single config file (or a directory holding
 * one) and the walker's target detection classifies it as mcp-config.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { scanTree } from "./scanner/checks.js";
import {
  detectTargetType,
  isMcpConfigFileName,
  treeContentHash,
  walkTree,
  MAX_FILE_BYTES,
} from "./scanner/walk.js";
import {
  SEVERITY_RANK,
  type Finding,
  type ScannedFile,
  type TargetType,
  type WalkResult,
} from "./scanner/types.js";

export type { Finding, TargetType } from "./scanner/types.js";

export type SkillVerdict = "clean" | "review" | "do_not_install";

export interface SkillScanResult {
  verdict: SkillVerdict;
  targetType: TargetType;
  filesScanned: number;
  filesSkipped: { binary: number; tooLarge: number; unreadable: number };
  /** sha256 over the scanned tree manifest (paths + per-file digests). */
  contentHash: string;
  findings: Finding[];
}

/** The CLI's verdict rule (scanner-cli/src/cli.ts), unchanged. */
export function verdictForFindings(findings: Finding[]): SkillVerdict {
  const hasHighPlus = findings.some(
    (f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high,
  );
  if (hasHighPlus) return "do_not_install";
  return findings.length > 0 ? "review" : "clean";
}

/** A single-file target (an MCP config handed over on its own) becomes
 *  a one-file walk, mirroring the CLI's file-target handling; the
 *  explicit mcp-config flag follows the CLI's filename rule. */
function walkTarget(root: string): { walk: WalkResult; explicitMcpConfig: boolean } {
  if (statSync(root).isFile()) {
    const name = basename(root);
    const buf = readFileSync(root);
    const files: ScannedFile[] =
      buf.length <= MAX_FILE_BYTES && !buf.includes(0)
        ? [{ absPath: root, relPath: name, text: buf.toString("utf8"), sizeBytes: buf.length }]
        : [];
    return {
      walk: {
        files,
        skippedBinary: files.length === 0 && buf.length <= MAX_FILE_BYTES ? 1 : 0,
        skippedTooLarge: buf.length > MAX_FILE_BYTES ? 1 : 0,
        skippedUnreadable: 0,
      },
      explicitMcpConfig: isMcpConfigFileName(name),
    };
  }
  return { walk: walkTree(root, []), explicitMcpConfig: false };
}

/**
 * Scan a skill directory (or a single file — e.g. an MCP config) with
 * the full local catalog. Throws only on a missing target; unreadable
 * individual files are counted by the walker, never fatal.
 */
export function scanSkillTree(root: string): SkillScanResult {
  const { walk, explicitMcpConfig } = walkTarget(root);
  const targetType = detectTargetType(root, walk.files, explicitMcpConfig);
  const findings = scanTree(walk.files, targetType);
  return {
    verdict: verdictForFindings(findings),
    targetType,
    filesScanned: walk.files.length,
    filesSkipped: {
      binary: walk.skippedBinary,
      tooLarge: walk.skippedTooLarge,
      unreadable: walk.skippedUnreadable,
    },
    contentHash: treeContentHash(walk.files),
    findings,
  };
}
