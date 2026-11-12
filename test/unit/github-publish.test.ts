/**
 * v0.9.5 unit tests: the GitHub publish pack.
 *
 * What is pinned here:
 *  - The pure logic: tag/version shape, asset naming (the exact pair
 *    build-dmg.sh produces and the in-app updater requires), shasum
 *    file parsing, upload-URL template handling, release lookup.
 *  - The local pair verification: a DMG whose bytes do not match its
 *    .sha256 file — or a checksum naming a different build — refuses
 *    BEFORE any network call.
 *  - The service against a fake GitHub HTTP layer: the vaulted token
 *    reaches GitHub only as the Authorization header inside the
 *    control-plane call; it appears in NO summary, success or
 *    failure. Draft → assets uploaded → published → verified by
 *    read-back. Retries skip assets already present at the right
 *    size; a wrong-size namesake refuses instead of replacing.
 *  - The permission model: PolicyStore parks EVERY publish as an
 *    external-send (a policy allow rule cannot cover it), a deny
 *    rule still wins, and the approval summary enumerates the exact
 *    tag and file paths.
 *
 * Everything runs against the fake HTTP layer — no network. The
 * token below is a synthetic canary, shaped to NOT match the S1
 * github-token pattern, so its absence from summaries proves the
 * service never puts it there (vault redaction is the second net,
 * not the thing under test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitHubPublishService,
  assetUploadUrl,
  findReleaseByTag,
  parseSha256File,
  releaseAssetNames,
  tagForVersion,
  verifyLocalPair,
  versionForTag,
  type GitHubHttp,
  type GitHubRelease,
} from "../../packages/control-plane/src/github.js";
import { PolicyStore, DEFAULT_POLICY } from "../../packages/control-plane/src/policy.js";
import { describeAction } from "../../packages/control-plane/src/approvals.js";
import { VaultBroker } from "../../packages/vault/src/index.js";

const CANARY = "gh-test-canary-value-0123456789";
const TAG = "v0.9.5";
const VERSION = "0.9.5";
const DMG_BYTES = Buffer.from("fake-dmg-bytes-for-tests");
const RELEASE_URL = `https://github.com/startekenterprises-ai/gus/releases/tag/${TAG}`;
const UPLOAD_TEMPLATE = "https://uploads.github.com/repos/startekenterprises-ai/gus/releases/42/assets{?name,label}";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-github-"));
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Write a build-dmg.sh-shaped pair into dir; returns the paths. */
function writePair(dir: string, dmgBytes: Buffer = DMG_BYTES): { dmgPath: string; shaPath: string } {
  const names = releaseAssetNames(VERSION);
  const dmgPath = join(dir, names.dmg);
  const shaPath = join(dir, names.sha);
  writeFileSync(dmgPath, dmgBytes);
  writeFileSync(shaPath, `${sha256Hex(dmgBytes)}  ${dmgPath}\n`);
  return { dmgPath, shaPath };
}

function vaultWith(token: string | null): VaultBroker {
  const dir = freshDir();
  const vault = new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key"));
  if (token !== null) vault.add("github", token);
  return vault;
}

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Buffer | string;
}

/** A stateful fake of the GitHub releases API slice the pack uses. */
function fakeGitHub(seed: GitHubRelease[], opts?: { failUploadFor?: string }) {
  const releases = new Map<number, GitHubRelease>(seed.map((r) => [r.id, structuredClone(r)]));
  const calls: RecordedCall[] = [];
  const http: GitHubHttp = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, body: init.body });
    const json = (status: number, obj: unknown) => ({ status, body: JSON.stringify(obj) });
    if (init.method === "GET" && url.includes("/releases?")) {
      return json(200, [...releases.values()]);
    }
    const upload = /^https:\/\/uploads\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets\?name=(.+)$/.exec(url);
    if (init.method === "POST" && upload) {
      const rel = releases.get(Number(upload[1]));
      if (!rel) return json(404, { message: "Not Found" });
      const name = decodeURIComponent(upload[2]);
      if (opts?.failUploadFor === name) return json(422, { message: "Validation Failed: asset rejected" });
      const size = init.body instanceof Buffer ? init.body.length : Buffer.byteLength(String(init.body ?? ""));
      rel.assets.push({ name, size });
      return json(201, { name, size });
    }
    const byId = /\/releases\/(\d+)$/.exec(url);
    if (byId) {
      const rel = releases.get(Number(byId[1]));
      if (!rel) return json(404, { message: "Not Found" });
      if (init.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as { draft?: boolean };
        if (patch.draft === false) rel.draft = false;
        return json(200, rel);
      }
      if (init.method === "GET") return json(200, rel);
    }
    return json(404, { message: `unrouted ${init.method} ${url}` });
  };
  return { http, calls, releases };
}

function draftRelease(assets: GitHubRelease["assets"] = []): GitHubRelease {
  return {
    id: 42,
    tag_name: TAG,
    draft: true,
    html_url: RELEASE_URL,
    upload_url: UPLOAD_TEMPLATE,
    assets,
  };
}

function service(http: GitHubHttp, vault: VaultBroker): GitHubPublishService {
  return new GitHubPublishService({ vault, http });
}

const publish = (svc: GitHubPublishService, paths: { dmgPath: string; shaPath: string }, tag: string = TAG) =>
  svc.execute("job1", "github_publish_release", { tag, dmgPath: paths.dmgPath, shaPath: paths.shaPath });

// ------------------------------------------------------------ pure logic

test("github: tag shapes — v<semver> or bare semver only", () => {
  assert.equal(versionForTag("v0.9.5"), "0.9.5");
  assert.equal(versionForTag("0.9.5"), "0.9.5");
  assert.equal(versionForTag("v1.22.333"), "1.22.333");
  assert.equal(versionForTag("v1.2"), null);
  assert.equal(versionForTag("latest"), null);
  assert.equal(versionForTag("v0.9.5-beta"), null);
  assert.equal(versionForTag(""), null);
  assert.equal(tagForVersion("0.9.5"), "v0.9.5");
  assert.deepEqual(releaseAssetNames("0.9.5"), { dmg: "GUS-0.9.5.dmg", sha: "GUS-0.9.5.dmg.sha256" });
});

test("github: shasum files parse (hash + named file); garbage refuses", () => {
  const h = sha256Hex(DMG_BYTES);
  assert.deepEqual(parseSha256File(`${h}  /Users/x/gus/hosts/mac-app/dist/GUS-0.9.5.dmg\n`), {
    sha256: h,
    fileName: "GUS-0.9.5.dmg",
  });
  assert.deepEqual(parseSha256File(`${h}\n`), { sha256: h });
  assert.equal(parseSha256File("not-a-hash  whatever\n"), null);
  assert.equal(parseSha256File(""), null);
});

test("github: the upload URL strips GitHub's {?name,label} template", () => {
  assert.equal(
    assetUploadUrl(UPLOAD_TEMPLATE, "GUS-0.9.5.dmg"),
    "https://uploads.github.com/repos/startekenterprises-ai/gus/releases/42/assets?name=GUS-0.9.5.dmg",
  );
});

test("github: release lookup is by exact tag", () => {
  const rel = draftRelease();
  assert.equal(findReleaseByTag([rel], TAG), rel);
  assert.equal(findReleaseByTag([rel], "v0.9.4"), undefined);
  assert.equal(findReleaseByTag([], TAG), undefined);
});

test("github: the local pair verifies — and each failure mode refuses", () => {
  const h = sha256Hex(DMG_BYTES);
  assert.deepEqual(verifyLocalPair(VERSION, DMG_BYTES, `${h}  /x/GUS-0.9.5.dmg\n`), { ok: true, sha256: h });
  const mismatch = verifyLocalPair(VERSION, Buffer.from("other bytes"), `${h}  /x/GUS-0.9.5.dmg\n`);
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.match(mismatch.error, /does not match/);
  const wrongFile = verifyLocalPair(VERSION, DMG_BYTES, `${h}  /x/GUS-0.9.4.dmg\n`);
  assert.equal(wrongFile.ok, false);
  if (!wrongFile.ok) assert.match(wrongFile.error, /different build/);
  const garbage = verifyLocalPair(VERSION, DMG_BYTES, "hello\n");
  assert.equal(garbage.ok, false);
});

// ------------------------------------------------------------ the service

test("github publish: draft → both assets uploaded → published → verified by read-back", async () => {
  const dir = freshDir();
  const paths = writePair(dir);
  const fake = fakeGitHub([draftRelease()]);
  const out = await publish(service(fake.http, vaultWith(CANARY)), paths);
  assert.equal(out.ok, true, out.summary);
  assert.equal(out.refused, undefined);
  assert.ok(out.summary.includes(RELEASE_URL), out.summary);
  assert.ok(!out.summary.includes(CANARY), "the token reached a summary");

  const posts = fake.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 2);
  assert.ok(posts[0].url.endsWith("?name=GUS-0.9.5.dmg"), posts[0].url);
  assert.ok(posts[1].url.endsWith("?name=GUS-0.9.5.dmg.sha256"), posts[1].url);
  assert.equal(posts[0].headers["content-type"], "application/octet-stream");
  // The token traveled exactly one way: as the Authorization header
  // on the control plane's own calls.
  for (const c of fake.calls) {
    assert.equal(c.headers.authorization, `Bearer ${CANARY}`);
  }
  assert.equal(fake.calls.filter((c) => c.method === "PATCH").length, 1);
  assert.equal(fake.releases.get(42)?.draft, false);
});

test("github publish: a checksum mismatch refuses before ANY network call", async () => {
  const dir = freshDir();
  const paths = writePair(dir);
  writeFileSync(paths.shaPath, `${sha256Hex(Buffer.from("not the dmg"))}  ${paths.dmgPath}\n`);
  const fake = fakeGitHub([draftRelease()]);
  const out = await publish(service(fake.http, vaultWith(CANARY)), paths);
  assert.equal(out.ok, false);
  assert.equal(out.refused, true);
  assert.match(out.summary, /does not match/);
  assert.equal(fake.calls.length, 0);
});

test("github publish: no vault token refuses with the setup pointer, nothing uploaded", async () => {
  const dir = freshDir();
  const paths = writePair(dir);
  const fake = fakeGitHub([draftRelease()]);
  const out = await publish(service(fake.http, vaultWith(null)), paths);
  assert.equal(out.refused, true);
  assert.match(out.summary, /no vault secret named "github"/);
  assert.equal(fake.calls.length, 0);
});

test("github publish: a missing draft release refuses — the pack never creates releases", async () => {
  const dir = freshDir();
  const paths = writePair(dir);
  const fake = fakeGitHub([]);
  const out = await publish(service(fake.http, vaultWith(CANARY)), paths);
  assert.equal(out.refused, true);
  assert.match(out.summary, /no release with tag v0\.9\.5/);
  assert.equal(fake.calls.filter((c) => c.method !== "GET").length, 0);
});

test("github publish: already published with both assets at size is a verified no-op", async () => {
  const dir = freshDir();
  const paths = writePair(dir);
  const rel = draftRelease([
    { name: "GUS-0.9.5.dmg", size: readFileSync(paths.dmgPath).length },
    { name: "GUS-0.9.5.dmg.sha256", size: readFileSync(paths.shaPath).length },
  ]);
  rel.draft = false;
  const fake = fakeGitHub([rel]);
  const out = await publish(service(fake.http, vaultWith(CANARY)), paths);
  assert.equal(out.ok, true, out.summary);
  assert.match(out.summary, /already published/);
  assert.equal(fake.calls.filter((c) => c.method === "POST" || c.method === "PATCH").length, 0);
});

test("github publish: a retry uploads only the missing asset, then publishes", async () => {
  const dir = freshDir();
  const paths = writePair(dir);
  const fake = fakeGitHub([draftRelease([{ name: "GUS-0.9.5.dmg", size: DMG_BYTES.length }])]);
  const out = await publish(service(fake.http, vaultWith(CANARY)), paths);
  assert.equal(out.ok, true, out.summary);
  const posts = fake.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith("?name=GUS-0.9.5.dmg.sha256"), posts[0].url);
  assert.match(out.summary, /already present at the right size, skipped: GUS-0\.9\.5\.dmg/);
  assert.equal(fake.releases.get(42)?.draft, false);
});

test("github publish: a same-name asset at the WRONG size refuses — never silently replaced", async () => {
  const dir = freshDir();
  const paths = writePair(dir);
  const fake = fakeGitHub([draftRelease([{ name: "GUS-0.9.5.dmg", size: DMG_BYTES.length + 5 }])]);
  const out = await publish(service(fake.http, vaultWith(CANARY)), paths);
  assert.equal(out.refused, true);
  assert.match(out.summary, /refusing to publish a mismatched asset/);
  assert.equal(fake.calls.filter((c) => c.method === "PATCH").length, 0);
});

test("github publish: a GitHub upload error refuses loudly, token-free", async () => {
  const dir = freshDir();
  const paths = writePair(dir);
  const fake = fakeGitHub([draftRelease()], { failUploadFor: "GUS-0.9.5.dmg" });
  const out = await publish(service(fake.http, vaultWith(CANARY)), paths);
  assert.equal(out.refused, true);
  assert.match(out.summary, /uploading GUS-0\.9\.5\.dmg failed \(HTTP 422/);
  assert.ok(!out.summary.includes(CANARY), "the token reached a failure summary");
  assert.equal(fake.releases.get(42)?.draft, true);
});

test("github publish: malformed calls refuse before any file or network work", async () => {
  const dir = freshDir();
  const paths = writePair(dir);
  const fake = fakeGitHub([draftRelease()]);
  const svc = service(fake.http, vaultWith(CANARY));
  const badTag = await publish(svc, paths, "release-one");
  assert.equal(badTag.refused, true);
  assert.match(badTag.summary, /not a release version/);
  const relPath = await svc.execute("job1", "github_publish_release", {
    tag: TAG,
    dmgPath: "relative/GUS-0.9.5.dmg",
    shaPath: paths.shaPath,
  });
  assert.equal(relPath.refused, true);
  assert.match(relPath.summary, /absolute paths/);
  const controlCall = await svc.execute("job1", "github_publish_release", {
    tag: TAG,
    dmgPath: paths.dmgPath,
    shaPath: paths.shaPath,
  });
  // Names that don't match the tag's expected pair refuse:
  const wrongNames = await svc.execute("job1", "github_publish_release", {
    tag: "v0.9.6",
    dmgPath: paths.dmgPath,
    shaPath: paths.shaPath,
  });
  assert.equal(wrongNames.refused, true);
  assert.match(wrongNames.summary, /must be named GUS-0\.9\.6\.dmg/);
  assert.equal(controlCall.ok, true, "the well-formed control call should have published");
  assert.equal(fake.calls.filter((c) => c.method === "POST").length, 2, "only the control call uploaded");
});

// ------------------------------------------------------------ permission model

function storeWith(policy: Partial<typeof DEFAULT_POLICY>): PolicyStore {
  const dir = freshDir();
  const path = join(dir, "policy.json");
  writeFileSync(path, JSON.stringify({ ...DEFAULT_POLICY, ...policy }));
  return new PolicyStore(path);
}

test("github publish: the classifier parks EVERY publish as external-send — no rule can pre-allow it", () => {
  const args = { tag: TAG, dmgPath: "/x/GUS-0.9.5.dmg", shaPath: "/x/GUS-0.9.5.dmg.sha256" };
  const call = { tool: "github_publish_release", declaredClass: "write" as const, args };
  const plain = storeWith({}).classify(call);
  assert.equal(plain.action, "needs-approval");
  assert.equal(plain.effectiveClass, "external-send");
  assert.ok(plain.reason.includes(TAG) && plain.reason.includes("/x/GUS-0.9.5.dmg"), plain.reason);

  const withAllowRule = storeWith({
    rules: [{ tool: "github_publish_release", action: "allow", reason: "standing ok" }],
  }).classify(call);
  assert.equal(withAllowRule.action, "needs-approval", "an allow rule must not cover publishing");

  const withDenyRule = storeWith({
    rules: [{ tool: "github_publish_release", action: "deny", reason: "publishing is off" }],
  }).classify(call);
  assert.equal(withDenyRule.action, "deny", "a Never rule still wins");
});

test("github publish: the approval summary enumerates the exact tag and files", () => {
  const s = describeAction("github_publish_release", {
    tag: TAG,
    dmgPath: "/Users/x/gus/hosts/mac-app/dist/GUS-0.9.5.dmg",
    shaPath: "/Users/x/gus/hosts/mac-app/dist/GUS-0.9.5.dmg.sha256",
  });
  assert.ok(s.includes(TAG), s);
  assert.ok(s.includes("GUS-0.9.5.dmg") && s.includes("GUS-0.9.5.dmg.sha256"), s);
  assert.ok(s.includes("never sees the value"), s);
});
