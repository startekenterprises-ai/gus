/**
 * The GitHub publish pack (v0.9.5, Step 2) — GUS publishes its own
 * releases.
 *
 * Why this executes in the CONTROL PLANE, like the Gmail and Mac
 * packs: the publish credential (a fine-grained GitHub PAT, repo
 * startekenterprises-ai/gus only, Contents read/write) lives in the
 * Vault Broker under the name "github" and is used ONLY inside
 * `withSecret` callbacks in this process. It never enters the
 * agent's context, never crosses the comm bridge, and is revocable
 * two ways — remove the vault secret, or revoke the token on
 * GitHub.
 *
 * Why there is no script route (investigated for v0.9.5, on the
 * record): a repo script run as a build-class shell job is a child
 * process of this one (MacService → NativeMacHostAdapter.shellRun).
 * The vault's founding rule is that a secret value never crosses a
 * process boundary — `withSecret` hands the value to a control-plane
 * callback, and nothing else. A script could only reach the token by
 * reading and decrypting the vault files itself, which is precisely
 * the parallel secret path the vault exists to forbid. The other
 * sanctioned channel, the egress proxy, carries string bodies the
 * MODEL supplies through the comm bridge — a DMG is tens of
 * megabytes of binary the model never holds. So the publish runs
 * here, where the vault callback and the file bytes can meet.
 *
 * The one tool: `github_publish_release` {tag, dmgPath, shaPath}.
 * The classifier (policy.ts) parks EVERY call as an external-send —
 * a one-time, hash-bound approval naming the exact tag and file
 * paths; there is no standing-approval coverage for publishing, by
 * the same hard-line logic as gmail_delete. (In Governor-permissive
 * mode a park proceeds as a recorded let-through, like every other
 * class — the mode is the operator's standing instruction, receipts
 * and all.)
 *
 * Execution discipline, mirroring the other packs:
 *   - The local pair is verified BEFORE any network call: both files
 *     exist, the .sha256 file's first token parses as a sha256, its
 *     named file (when present) is the expected DMG name, and the
 *     DMG's computed hash equals it. A mismatch refuses loudly with
 *     nothing uploaded — publishing a DMG its own checksum condemns
 *     would break the in-app updater's verification downstream.
 *   - Assets already on the release with the expected name AND size
 *     are skipped (a retry after a partial failure resumes, it does
 *     not duplicate); an asset with the expected name but the WRONG
 *     size refuses loudly — it is not silently replaced.
 *   - The outcome is verified against GitHub after the fact (the
 *     release reads back published, with both assets at the local
 *     sizes) — never reported on the transport's say-so alone.
 *   - Every summary and error passes the secret-guard AND the
 *     vault's value redaction before it can ride back toward the
 *     model. The token's name may appear; its value never does.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { screenText } from "@gus/shared";
import type { VaultBroker } from "@gus/vault";

/** The vault handle for the publish credential. A name, never a value. */
export const GITHUB_SECRET_NAME = "github";

/** The one repository this pack can publish. Fixed in code — the
 *  token is scoped to this repo, and the pack names no other. */
export const GITHUB_REPO = "startekenterprises-ai/gus";
export const GITHUB_API_BASE = "https://api.github.com";

export const GITHUB_PUBLISH_TOOL = "github_publish_release";

export function isGitHubTool(tool: string): boolean {
  return tool === GITHUB_PUBLISH_TOOL;
}

// ------------------------------------------------------------ pure logic

/** "v0.9.5" or "0.9.5" → "0.9.5"; anything else → null. Release tags
 *  in this repo are exactly `v<semver>`; a looser shape would let a
 *  typo publish against the wrong draft. */
export function versionForTag(tag: string): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/** The canonical tag for a version: "0.9.5" → "v0.9.5". */
export function tagForVersion(version: string): string {
  return `v${version}`;
}

/** The release asset names for a version — the exact pair
 *  build-dmg.sh produces and the in-app updater requires. */
export function releaseAssetNames(version: string): { dmg: string; sha: string } {
  const dmg = `GUS-${version}.dmg`;
  return { dmg, sha: `${dmg}.sha256` };
}

/** Parse a `shasum -a 256` file: first token is the hash; the second
 *  token, when present, names the hashed file (build-dmg.sh writes
 *  the absolute path). Returns null when the first token is not a
 *  sha256. */
export function parseSha256File(text: string): { sha256: string; fileName?: string } | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const first = (tokens[0] ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(first)) return null;
  const named = tokens[1] ? basename(tokens[1]) : undefined;
  return { sha256: first, ...(named ? { fileName: named } : {}) };
}

/** GitHub's upload_url is a template ending in `{?name,label}`.
 *  Strip the template part and name the asset explicitly. */
export function assetUploadUrl(uploadUrlTemplate: string, name: string): string {
  const base = uploadUrlTemplate.replace(/\{[^}]*\}$/, "");
  return `${base}?name=${encodeURIComponent(name)}`;
}

export interface GitHubReleaseAsset {
  name: string;
  size: number;
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  html_url: string;
  upload_url: string;
  assets: GitHubReleaseAsset[];
}

/** Find a release by its canonical tag in a list response (the list
 *  endpoint is the one that reliably includes drafts for a token
 *  with push access). */
export function findReleaseByTag(releases: GitHubRelease[], tag: string): GitHubRelease | undefined {
  return releases.find((r) => r.tag_name === tag);
}

/** Verify a local DMG against its .sha256 file content. Pure: the
 *  caller supplies the bytes and the file text. */
export function verifyLocalPair(
  version: string,
  dmgBytes: Buffer,
  shaFileText: string,
): { ok: true; sha256: string } | { ok: false; error: string } {
  const names = releaseAssetNames(version);
  const parsed = parseSha256File(shaFileText);
  if (!parsed) {
    return { ok: false, error: "the .sha256 file's first token is not a sha256 hash — refusing to publish an unverifiable pair" };
  }
  if (parsed.fileName && parsed.fileName !== names.dmg) {
    return {
      ok: false,
      error: `the .sha256 file names "${parsed.fileName}", not "${names.dmg}" — the checksum belongs to a different build`,
    };
  }
  const computed = createHash("sha256").update(dmgBytes).digest("hex");
  if (computed !== parsed.sha256) {
    return {
      ok: false,
      error: `the DMG's sha256 (${computed.slice(0, 12)}…) does not match its .sha256 file (${parsed.sha256.slice(0, 12)}…) — the pair is stale or corrupt; rebuild before publishing`,
    };
  }
  return { ok: true, sha256: computed };
}

// ------------------------------------------------------------ transport

/** The HTTP surface the service needs. Injectable for tests (the
 *  Gmail pack's transport pattern); production uses global fetch.
 *  Bodies are Buffers because a DMG is binary — this interface never
 *  crosses the comm bridge, so nothing here is model-visible. */
export interface GitHubHttpResponse {
  status: number;
  body: string;
}

export type GitHubHttp = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Buffer | string },
) => Promise<GitHubHttpResponse>;

const defaultHttp: GitHubHttp = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body instanceof Buffer ? new Uint8Array(init.body) : init.body,
  });
  return { status: res.status, body: await res.text() };
};

// ------------------------------------------------------------ service

export interface GitHubOutcome {
  ok: boolean;
  summary: string;
  /** True for hard refusals and execution failures: the CommServer
   *  settles the job failed-loudly, like an egress refusal. */
  refused?: boolean;
}

class PublishError extends Error {}

export class GitHubPublishService {
  private http: GitHubHttp;
  private apiBase: string;

  constructor(
    private opts: { vault: VaultBroker; http?: GitHubHttp; apiBase?: string },
  ) {
    this.http = opts.http ?? defaultHttp;
    this.apiBase = opts.apiBase ?? GITHUB_API_BASE;
  }

  /** Scrub text that is about to ride toward the model or a log:
   *  vault values out (by value, via the broker), S1 patterns out. */
  private scrub(text: string): string {
    return screenText(this.opts.vault.redactValues(text).text).redacted;
  }

  async execute(jobId: string, tool: string, args: Record<string, unknown>): Promise<GitHubOutcome> {
    if (!isGitHubTool(tool)) {
      return { ok: false, refused: true, summary: `unknown github tool "${tool}" — nothing executed` };
    }
    try {
      return await this.publishRelease(args);
    } catch (e) {
      const detail = this.scrub(e instanceof Error ? e.message : String(e));
      return { ok: false, refused: true, summary: `${tool} failed loudly: ${detail}` };
    }
  }

  private async publishRelease(args: Record<string, unknown>): Promise<GitHubOutcome> {
    const tagArg = typeof args.tag === "string" ? args.tag : "";
    const version = versionForTag(tagArg);
    if (!version) {
      return {
        ok: false,
        refused: true,
        summary: `github_publish_release failed loudly: tag "${tagArg}" is not a release version (want v<major>.<minor>.<patch>, e.g. v0.9.5)`,
      };
    }
    const tag = tagForVersion(version);
    const names = releaseAssetNames(version);
    const dmgPath = typeof args.dmgPath === "string" ? args.dmgPath : "";
    const shaPath = typeof args.shaPath === "string" ? args.shaPath : "";
    if (!dmgPath.startsWith("/") || !shaPath.startsWith("/")) {
      return {
        ok: false,
        refused: true,
        summary: "github_publish_release failed loudly: dmgPath and shaPath must both be named as absolute paths — a publish approval must enumerate the exact files it covers",
      };
    }
    if (basename(dmgPath) !== names.dmg || basename(shaPath) !== names.sha) {
      return {
        ok: false,
        refused: true,
        summary: `github_publish_release failed loudly: for ${tag} the files must be named ${names.dmg} and ${names.sha} (got ${basename(dmgPath)} and ${basename(shaPath)})`,
      };
    }
    for (const p of [dmgPath, shaPath]) {
      if (!existsSync(p) || !statSync(p).isFile()) {
        return {
          ok: false,
          refused: true,
          summary: `github_publish_release failed loudly: ${p} does not exist — build the DMG first (hosts/mac-app/build-dmg.sh); nothing was uploaded`,
        };
      }
    }
    const dmgBytes = readFileSync(dmgPath);
    const shaBytes = readFileSync(shaPath);
    const pair = verifyLocalPair(version, dmgBytes, shaBytes.toString("utf8"));
    if (!pair.ok) {
      return { ok: false, refused: true, summary: `github_publish_release failed loudly: ${pair.error}` };
    }
    if (!this.opts.vault.has(GITHUB_SECRET_NAME)) {
      return {
        ok: false,
        refused: true,
        summary: `github_publish_release failed loudly: no vault secret named "${GITHUB_SECRET_NAME}" — the operator stores the publish token in the vault (panel → Vault); nothing was uploaded`,
      };
    }

    const files: { name: string; bytes: Buffer; contentType: string }[] = [
      { name: names.dmg, bytes: dmgBytes, contentType: "application/octet-stream" },
      { name: names.sha, bytes: shaBytes, contentType: "text/plain" },
    ];

    // The token exists only inside this callback's closure (the
    // providers.ts callWithKey pattern). Every request is made here;
    // nothing derived from the value leaves — errors are scrubbed by
    // execute() on the way out, and this callback's own error text is
    // built from statuses and GitHub's public error messages only.
    const result = await this.opts.vault.withSecret(GITHUB_SECRET_NAME, async (token) => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "gus-control-plane",
      };
      const call = async (
        method: string,
        url: string,
        body?: Buffer | string,
        extraHeaders?: Record<string, string>,
      ): Promise<{ status: number; json: unknown }> => {
        const res = await this.http(url, {
          method,
          headers: { ...headers, ...(extraHeaders ?? {}) },
          ...(body !== undefined ? { body } : {}),
        });
        let json: unknown = null;
        try {
          json = res.body ? JSON.parse(res.body) : null;
        } catch {
          /* non-JSON body — callers treat json as absent */
        }
        return { status: res.status, json };
      };
      const fail = (what: string, status: number, json: unknown): never => {
        const msg =
          json && typeof json === "object" && "message" in json
            ? String((json as { message: unknown }).message)
            : "no message";
        throw new PublishError(`${what} failed (HTTP ${status}: ${msg})`);
      };

      const list = await call("GET", `${this.apiBase}/repos/${GITHUB_REPO}/releases?per_page=100`);
      if (list.status !== 200 || !Array.isArray(list.json)) {
        fail("listing releases", list.status, list.json);
      }
      const release = findReleaseByTag(list.json as GitHubRelease[], tag);
      if (!release) {
        throw new PublishError(
          `no release with tag ${tag} exists on ${GITHUB_REPO} — create the draft release first; nothing was uploaded`,
        );
      }

      const uploaded: string[] = [];
      const skipped: string[] = [];
      for (const f of files) {
        const existing = release.assets.find((a) => a.name === f.name);
        if (existing) {
          if (existing.size !== f.bytes.length) {
            throw new PublishError(
              `release ${tag} already has an asset "${f.name}" of ${existing.size} bytes, but the local file is ${f.bytes.length} bytes — refusing to publish a mismatched asset; delete the stale asset on GitHub and retry`,
            );
          }
          skipped.push(f.name);
          continue;
        }
        const up = await call("POST", assetUploadUrl(release.upload_url, f.name), f.bytes, {
          "content-type": f.contentType,
          "content-length": String(f.bytes.length),
        });
        if (up.status !== 201) fail(`uploading ${f.name}`, up.status, up.json);
        uploaded.push(f.name);
      }

      let publishedNow = false;
      if (release.draft) {
        const patch = await call(
          "PATCH",
          `${this.apiBase}/repos/${GITHUB_REPO}/releases/${release.id}`,
          JSON.stringify({ draft: false }),
          { "content-type": "application/json" },
        );
        if (patch.status !== 200) fail(`publishing release ${tag}`, patch.status, patch.json);
        publishedNow = true;
      }

      // Post-condition, verified against GitHub — not the transport's
      // say-so: the release reads back published, carrying both
      // assets at exactly the local sizes.
      const check = await call("GET", `${this.apiBase}/repos/${GITHUB_REPO}/releases/${release.id}`);
      if (check.status !== 200 || !check.json || typeof check.json !== "object") {
        fail("verifying the published release", check.status, check.json);
      }
      const after = check.json as GitHubRelease;
      if (after.draft) {
        throw new PublishError(`release ${tag} still reads as a draft after publishing — the publish did not take`);
      }
      for (const f of files) {
        const a = after.assets.find((x) => x.name === f.name);
        if (!a) throw new PublishError(`release ${tag} does not carry asset "${f.name}" after publishing`);
        if (a.size !== f.bytes.length) {
          throw new PublishError(`release ${tag} asset "${f.name}" is ${a.size} bytes on GitHub, ${f.bytes.length} locally — the upload did not land intact`);
        }
      }
      return { releaseUrl: after.html_url, uploaded, skipped, publishedNow };
    });

    if (!result) {
      // withSecret returns undefined only when the name vanished
      // between the has() check and here (operator removed it
      // mid-flight) — say so plainly.
      return {
        ok: false,
        refused: true,
        summary: `github_publish_release failed loudly: the vault secret "${GITHUB_SECRET_NAME}" disappeared before it could be used; nothing was uploaded`,
      };
    }
    const parts = [
      `github_publish_release ${tag}: verified against GitHub — the release is published with ${names.dmg} (${files[0].bytes.length} bytes) and ${names.sha} attached`,
    ];
    if (result.uploaded.length > 0) parts.push(`uploaded: ${result.uploaded.join(", ")}`);
    if (result.skipped.length > 0) parts.push(`already present at the right size, skipped: ${result.skipped.join(", ")}`);
    if (!result.publishedNow) parts.push("the release was already published");
    parts.push(`release: ${result.releaseUrl}`);
    return { ok: true, summary: parts.join("; ") };
  }
}
