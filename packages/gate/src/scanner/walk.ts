/**
 * PORTED VERBATIM from agent-shield-scan (scanner-cli/src/walk.ts,
 * agent-shield-scan-wt @ scanner-cli 0.3.1) — GUS Phase 4 skill-install
 * gate (foundation spec §1.7, choke point 2). See scanner/types.ts in
 * this directory for the porting note.
 *
 * File walker + target auto-detection.
 *
 * Safety properties: never follows symlinks out of the tree, never
 * executes anything, caps file size and file count, skips VCS/dependency
 * internals, and reads only files that look like text.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { ScannedFile, TargetType, WalkResult } from "./types.js";

export const MAX_FILE_BYTES = 1_000_000; // 1 MB per file
export const MAX_FILES = 5_000;

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "dist",
  "build",
  ".next",
  ".turbo",
]);

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function walkTree(root: string, ignore: string[] = []): WalkResult {
  const files: ScannedFile[] = [];
  let skippedBinary = 0;
  let skippedTooLarge = 0;
  let skippedUnreadable = 0;

  const ignored = (rel: string): boolean =>
    ignore.some((pat) => rel === pat || rel.startsWith(pat.replace(/\/?$/, "/")) || rel.includes(pat));

  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      skippedUnreadable++;
      return;
    }
    for (const name of entries) {
      if (files.length >= MAX_FILES) return;
      const abs = join(dir, name);
      const rel = toPosix(relative(root, abs));
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        skippedUnreadable++;
        continue;
      }
      // Do not follow symlinks: a scanned tree must stay self-contained.
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (ignored(rel)) continue;
        visit(abs);
        continue;
      }
      if (!st.isFile()) continue;
      if (ignored(rel)) continue;
      if (st.size > MAX_FILE_BYTES) {
        skippedTooLarge++;
        continue;
      }
      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch {
        skippedUnreadable++;
        continue;
      }
      if (looksBinary(buf)) {
        skippedBinary++;
        continue;
      }
      files.push({
        absPath: abs,
        relPath: rel,
        text: buf.toString("utf8"),
        sizeBytes: buf.length,
      });
    }
  };

  visit(root);
  return { files, skippedBinary, skippedTooLarge, skippedUnreadable };
}

/** SHA-256 over a sorted manifest of "relpath:sha256(file)" lines. */
export function treeContentHash(files: ScannedFile[]): string {
  const h = createHash("sha256");
  const sorted = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));
  for (const f of sorted) {
    const fh = createHash("sha256").update(f.text, "utf8").digest("hex");
    h.update(`${f.relPath}:${fh}\n`, "utf8");
  }
  return h.digest("hex");
}

const MCP_CONFIG_NAMES = new Set([
  "mcp.json",
  "claude_desktop_config.json",
  ".mcp.json",
]);

/** Parse a JSON file's text; returns null on any failure. */
export function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function jsonHasMcpServers(text: string): boolean {
  const obj = tryParseJson(text);
  if (!obj) return false;
  const servers = obj["mcpServers"];
  return !!servers && typeof servers === "object";
}

/**
 * Target auto-detection, in spec order:
 *   SKILL.md anywhere near the root      -> skill
 *   explicit MCP config file target      -> mcp-config (handled by caller)
 *   MCP config file in tree / server.json / package.json MCP markers
 *                                        -> mcp-server
 *   otherwise                            -> generic
 */
export function detectTargetType(
  targetAbs: string,
  files: ScannedFile[],
  explicitMcpConfig: boolean,
): TargetType {
  if (explicitMcpConfig) return "mcp-config";
  const rels = new Set(files.map((f) => f.relPath));
  for (const rel of rels) {
    if (basename(rel) === "SKILL.md" || basename(rel) === "skill.md") {
      return "skill";
    }
  }
  for (const f of files) {
    const base = basename(f.relPath);
    if (MCP_CONFIG_NAMES.has(base) && jsonHasMcpServers(f.text)) {
      return "mcp-server";
    }
    if (base === "server.json") {
      const obj = tryParseJson(f.text);
      if (obj && (obj["name"] || obj["tools"] || obj["remotes"])) {
        return "mcp-server";
      }
    }
    if (base === "package.json") {
      const obj = tryParseJson(f.text);
      const kw = (obj?.["keywords"] as unknown) ?? [];
      const deps = {
        ...((obj?.["dependencies"] as Record<string, unknown>) ?? {}),
        ...((obj?.["devDependencies"] as Record<string, unknown>) ?? {}),
      };
      if (
        (Array.isArray(kw) && kw.includes("mcp")) ||
        "@modelcontextprotocol/sdk" in deps
      ) {
        return "mcp-server";
      }
    }
  }
  return "generic";
}

export function isMcpConfigFileName(name: string): boolean {
  return MCP_CONFIG_NAMES.has(basename(name));
}

export function resolveTarget(p: string): string {
  return resolve(p);
}

export function targetExists(p: string): boolean {
  return existsSync(p);
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
