/**
 * Release bundles + signed manifests (foundation spec §1.1) — Phase 3.
 *
 * A release is a directory: a packed bundle tree (control-plane/,
 * runtime/, node_modules/, VERSION) plus two files the Updater adds
 * trust to:
 *
 *   manifest.json   { version, createdAt, files: { relpath: sha256 } }
 *   manifest.sig    Ed25519 signature (base64) over the canonical form
 *                   of manifest.json
 *
 * Verification (verifyRelease) is deliberately total:
 *   - the signature must verify against the operator-pinned release
 *     public key (<state>/update-pubkey.pem — the private key never
 *     enters an install; releases are signed on the publisher side);
 *   - every file listed in the manifest must hash to its listed value;
 *   - every file present must be listed (no smuggled extras);
 *   - the bundle's VERSION file must agree with manifest.version.
 * Any failure rejects the release BEFORE anything is staged, and the
 * running version is untouched. This is drill case (a): a tampered
 * bundle is not "mostly verified" — it is refused.
 *
 * Signing honesty, same discipline as the receipt stub: the key here
 * is a LOCAL release key. It proves "this bundle is exactly what the
 * holder of the release key published" — no more. Key custody for the
 * public update channel is a release-engineering decision for Phase 5;
 * nothing in the update path depends on who holds the key, only that
 * the updater never holds it.
 *
 * The canonical form is JSON with object keys sorted recursively —
 * the same canonicalization approvals.ts uses for argument hashes.
 * test/fixtures/make-release.mjs implements the identical form on the
 * publisher side; the two implementations agreeing is itself covered
 * by the Phase 3 drill (fixture-signed releases verify here).
 */
import { createHash, verify as cryptoVerify } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { canonicalize } from "./approvals.js";

export interface ReleaseManifest {
  version: string;
  createdAt: number;
  /** relpath (POSIX separators) -> sha256 hex of file content. */
  files: Record<string, string>;
}

export const MANIFEST_FILE = "manifest.json";
export const SIGNATURE_FILE = "manifest.sig";

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** All files under dir, as POSIX relative paths, sorted. */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out;
}

export type ReleaseVerification =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; error: string };

/**
 * Verify a release directory against a pinned Ed25519 public key
 * (PEM, SPKI). Pure file I/O — the caller decides what a rejection
 * means (the Updater: refuse before staging, fail the update job
 * loudly, leave the running version alone).
 */
export function verifyRelease(dir: string, publicKeyPem: string): ReleaseVerification {
  const manifestPath = join(dir, MANIFEST_FILE);
  const sigPath = join(dir, SIGNATURE_FILE);
  if (!existsSync(manifestPath)) return { ok: false, error: "release has no manifest.json" };
  if (!existsSync(sigPath)) return { ok: false, error: "release has no manifest.sig (unsigned releases are refused)" };

  let manifest: ReleaseManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
  } catch {
    return { ok: false, error: "manifest.json is not valid JSON" };
  }
  if (typeof manifest.version !== "string" || typeof manifest.files !== "object" || manifest.files === null) {
    return { ok: false, error: "manifest.json is malformed (needs version + files)" };
  }

  const signature = Buffer.from(readFileSync(sigPath, "utf8").trim(), "base64");
  let sigOk = false;
  try {
    sigOk = cryptoVerify(null, Buffer.from(canonicalize(manifest), "utf8"), publicKeyPem, signature);
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return { ok: false, error: "manifest signature does not verify against the pinned release key" };
  }

  // Every listed file present and hash-exact.
  for (const [rel, want] of Object.entries(manifest.files)) {
    const p = join(dir, ...rel.split("/"));
    if (!existsSync(p)) return { ok: false, error: `manifest lists ${rel} but it is missing` };
    if (sha256File(p) !== want) {
      return { ok: false, error: `hash mismatch for ${rel} (bundle was altered after signing)` };
    }
  }
  // Nothing present that is not listed (the two manifest files aside).
  for (const rel of walkFiles(dir)) {
    if (rel === MANIFEST_FILE || rel === SIGNATURE_FILE) continue;
    if (!(rel in manifest.files)) {
      return { ok: false, error: `bundle contains unlisted file ${rel} (not covered by the signature)` };
    }
  }
  // The bundle must agree with its own manifest about what it is.
  const versionFile = join(dir, "VERSION");
  if (!existsSync(versionFile)) return { ok: false, error: "bundle has no VERSION file" };
  const bundleVersion = readFileSync(versionFile, "utf8").trim();
  if (bundleVersion !== manifest.version) {
    return { ok: false, error: `bundle VERSION (${bundleVersion}) disagrees with manifest version (${manifest.version})` };
  }
  return { ok: true, manifest };
}
