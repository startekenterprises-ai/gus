/**
 * v0.13.0 (the redo, R1 groundwork): the ONE identity
 * (identity.ts) and the device registry re-homed under it
 * (devices.ts).
 *
 * The properties ARE the tests: pairing grants are gone and
 * enrollment is a local primitive that mints a credential
 * stored only as a digest, stamped with the identity it
 * belongs to; revocation stops a credential on the very next
 * call, same instance or fresh; an old v0.12.0 devices.json
 * (grants array and all) still loads and authenticates; the
 * identity mints once and persists; the default provider is
 * no-login local; the hosted/SSO providers are inert seam
 * stubs; and a local password is stored only as a scrypt
 * digest, refuses short values, and never by itself switches
 * the active provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceRegistry } from "../../packages/control-plane/src/devices.js";
import {
  IdentityService,
  type IdentityProviderKind,
} from "../../packages/control-plane/src/identity.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ------------------------------------------------------- registry

test("devices: enroll → authenticate returns the record; unknown credentials read as null", () => {
  const reg = new DeviceRegistry(tempDir("gus-devices-"));
  const { device, credential } = reg.enrollDevice({ name: "  My   Phone ", platform: "ios" }, 1_001_000);
  assert.ok(credential.length >= 40, "the credential carries real entropy");
  assert.equal(device.name, "My Phone", "labels are whitespace-cleaned");
  assert.equal(device.platform, "ios");
  assert.equal(device.createdAt, 1_001_000);
  assert.equal(device.revoked, false);
  assert.ok(!("credentialHash" in device), "the public record carries no digest");
  assert.ok(!("identityId" in device), "no identity stamp when the registry knows none");

  const authed = reg.authenticate(credential, 1_002_000);
  assert.ok(authed);
  assert.equal(authed.id, device.id);
  assert.equal(reg.authenticate("not-a-credential", 1_002_000), null);
  assert.equal(reg.authenticate("", 1_002_000), null);
});

test("devices: revocation stops the credential immediately — same instance and fresh instance", () => {
  const dir = tempDir("gus-devices-");
  const reg = new DeviceRegistry(dir);
  const { device, credential } = reg.enrollDevice({ name: "Phone", platform: "ios" });
  assert.ok(reg.authenticate(credential));
  assert.equal(reg.revoke("no-such-id"), false);
  assert.equal(reg.revoke(device.id), true);
  assert.equal(reg.revoke(device.id), false, "revoking twice is not a second success");
  assert.equal(reg.authenticate(credential), null, "a revoked credential is dead on the next call");
  // The re-read property: a fresh instance (the restart case)
  // reads the same truth without any in-memory hand-off.
  const fresh = new DeviceRegistry(dir);
  assert.equal(fresh.authenticate(credential), null);
  const listed = fresh.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].revoked, true, "the record stays — the operator sees what was cut off");
});

test("devices: records are stamped with the registry's identity; list() carries no digest", () => {
  const dir = tempDir("gus-devices-");
  const identity = new IdentityService(dir).identity();
  const reg = new DeviceRegistry(dir, identity.id);
  const { device, credential } = reg.enrollDevice({ name: "Phone", platform: "ios" });
  assert.equal(device.identityId, identity.id);

  const listed = reg.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].identityId, identity.id);
  assert.ok(!("credentialHash" in listed[0]), "list() never exposes a digest");

  // The registry file itself records which identity it belongs to.
  const onDisk = JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) as {
    identityId?: string;
  };
  assert.equal(onDisk.identityId, identity.id);

  // A fresh registry constructed WITHOUT the id still reads the
  // stamped records, and its next save keeps the loaded stamp —
  // and stamps new enrollments with it too.
  const fresh = new DeviceRegistry(dir);
  assert.equal(fresh.list()[0].identityId, identity.id);
  const second = fresh.enrollDevice({ name: "Tablet", platform: "ios" });
  assert.equal(second.device.identityId, identity.id);
  const after = JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) as { identityId?: string };
  assert.equal(after.identityId, identity.id);
  assert.ok(fresh.authenticate(credential), "the first credential still authenticates");
  assert.ok(fresh.authenticate(second.credential));
});

test("devices: a constructor identityId wins over the file's stamp on the next save", () => {
  const dir = tempDir("gus-devices-");
  const first = new DeviceRegistry(dir, "identity-one");
  first.enrollDevice({ name: "Phone", platform: "ios" });
  const second = new DeviceRegistry(dir, "identity-two");
  const enrolled = second.enrollDevice({ name: "Tablet", platform: "ios" });
  assert.equal(enrolled.device.identityId, "identity-two");
  const onDisk = JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) as { identityId?: string };
  assert.equal(onDisk.identityId, "identity-two");
  // The older record keeps the stamp it was enrolled under.
  const listed = second.list();
  assert.equal(listed.find((d) => d.name === "Phone")?.identityId, "identity-one");
});

test("devices: an old-format devices.json (grants array included) still loads and authenticates", () => {
  const dir = tempDir("gus-devices-");
  // A v0.12.0 file, written by hand: one device whose credential
  // the test digests itself, plus a grants array the new code
  // must simply ignore (in-place migration by indifference).
  const credential = "old-format-credential-the-test-knows";
  const credentialHash = createHash("sha256").update(credential, "utf8").digest("hex");
  const grantHash = createHash("sha256").update("some-old-grant", "utf8").digest("hex");
  writeFileSync(
    join(dir, "devices.json"),
    JSON.stringify(
      {
        devices: [
          {
            id: "dev-old",
            name: "Old Phone",
            platform: "ios",
            createdAt: 4_000_000,
            lastSeenAt: 4_000_000,
            revoked: false,
            credentialHash,
          },
        ],
        grants: [{ hash: grantHash, createdAt: 4_000_000, expiresAt: 4_600_000 }],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );

  const reg = new DeviceRegistry(dir);
  const listed = reg.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "dev-old");
  const authed = reg.authenticate(credential, 4_001_000);
  assert.ok(authed, "the pre-redo credential still authenticates");
  assert.equal(authed.id, "dev-old");

  // The next save writes the file in the new shape: the grants
  // array is gone, the device survives.
  reg.enrollDevice({ name: "New Phone", platform: "ios" });
  const after = readFileSync(join(dir, "devices.json"), "utf8");
  assert.ok(!after.includes("grants"), "a save after migration drops the grants field");
  assert.equal(reg.list().length, 2);
  assert.ok(reg.authenticate(credential, 4_002_000), "the old credential survives the rewrite");
});

test("devices: secrets persist only as digests, in a 0600 file", () => {
  const dir = tempDir("gus-devices-");
  const reg = new DeviceRegistry(dir);
  const { credential } = reg.enrollDevice({ name: "Phone", platform: "ios" });
  const text = readFileSync(join(dir, "devices.json"), "utf8");
  assert.ok(!text.includes(credential), "the clear credential is never written to disk");
  assert.equal(statSync(join(dir, "devices.json")).mode & 0o777, 0o600);
  // Persistence across instances: a fresh registry authenticates
  // the credential the first one minted.
  const fresh = new DeviceRegistry(dir);
  assert.ok(fresh.authenticate(credential));
});

test("devices: lastSeen refreshes on authenticate; a malformed file reads as an empty registry", () => {
  const dir = tempDir("gus-devices-");
  const reg = new DeviceRegistry(dir);
  const { credential } = reg.enrollDevice({ name: "Phone", platform: "ios" }, 5_000_000);
  const later = reg.authenticate(credential, 5_000_000 + 10 * 60 * 1000);
  assert.ok(later);
  assert.equal(later.lastSeenAt, 5_000_000 + 10 * 60 * 1000);

  writeFileSync(join(dir, "devices.json"), "{ not json");
  const broken = new DeviceRegistry(dir);
  assert.deepEqual(broken.list(), []);
  assert.equal(broken.authenticate(credential), null);
  const recovered = broken.enrollDevice({ name: "New", platform: "ios" });
  assert.ok(broken.authenticate(recovered.credential), "the registry recovers by writing a fresh file");
});

// ------------------------------------------------------- identity

test("identity: a fresh service mints an identity and persists it — a second instance reads the same id", () => {
  const dir = tempDir("gus-identity-");
  const first = new IdentityService(dir);
  const record = first.identity();
  assert.ok(record.id.length >= 32, "the id is a real uuid");
  assert.equal(record.provider, "local", "the default provider is no-login local");
  assert.ok(record.createdAt > 0);
  assert.equal(statSync(join(dir, "identity.json")).mode & 0o777, 0o600);

  const second = new IdentityService(dir);
  assert.equal(second.identity().id, record.id, "the identity is minted once");
  assert.equal(second.identity().createdAt, record.createdAt);
});

test("identity: a malformed identity file mints fresh and never throws", () => {
  const dir = tempDir("gus-identity-");
  writeFileSync(join(dir, "identity.json"), "{ not json at all");
  const svc = new IdentityService(dir);
  const record = svc.identity();
  assert.ok(record.id);
  assert.equal(record.provider, "local");
  // And a wrong-shaped file (valid JSON, invalid record) too.
  writeFileSync(join(dir, "identity.json"), JSON.stringify({ id: 42, provider: "platinum" }));
  const again = new IdentityService(dir).identity();
  assert.ok(again.id);
  assert.notEqual(again.id, record.id, "a malformed record is replaced, not half-kept");
});

test("identity: the local provider is configured and authenticates the operator", () => {
  const svc = new IdentityService(tempDir("gus-identity-"));
  const local = svc.provider("local");
  assert.equal(local.kind, "local");
  assert.equal(local.configured(), true);
  assert.deepEqual(local.authenticate({}), { ok: true, principal: "operator" });
  assert.deepEqual(local.authenticate({ username: "anyone", password: "anything" }), {
    ok: true,
    principal: "operator",
  });
});

test("identity: providers() lists all five in build order, with the stubs unconfigured", () => {
  const svc = new IdentityService(tempDir("gus-identity-"));
  const providers = svc.providers();
  assert.deepEqual(
    providers.map((p) => p.kind),
    ["local", "local-password", "google", "apple", "sso"] satisfies IdentityProviderKind[],
  );
  const byKind = new Map(providers.map((p) => [p.kind, p.configured]));
  assert.equal(byKind.get("local"), true);
  assert.equal(byKind.get("local-password"), false, "no password on file yet");
  assert.equal(byKind.get("google"), false);
  assert.equal(byKind.get("apple"), false);
  assert.equal(byKind.get("sso"), false);
});

test("identity: stub providers refuse with the seam detail and never authenticate", () => {
  const svc = new IdentityService(tempDir("gus-identity-"));
  for (const kind of ["google", "apple", "sso"] as const) {
    const stub = svc.provider(kind);
    assert.equal(stub.configured(), false);
    const r = stub.authenticate({ username: "someone", password: "whatever-123" });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.detail : "", /isn't configured in this build/);
    assert.match(r.ok === false ? r.detail : "", /provider seam exists/);
    assert.match(r.ok === false ? r.detail : "", /Nothing was signed in/);
  }
  assert.match(
    (() => {
      const r = svc.provider("google").authenticate({});
      return r.ok === false ? r.detail : "";
    })(),
    /Google sign-in/,
  );
});

test("identity: setPassword refuses a short password and stores nothing", () => {
  const dir = tempDir("gus-identity-");
  const svc = new IdentityService(dir);
  const r = svc.setPassword("operator", "short");
  assert.equal(r.ok, false);
  assert.match(r.detail, /at least 8 characters/);
  assert.equal(existsSync(join(dir, "identity-credentials.json")), false, "nothing was written");
  assert.equal(svc.verifyPassword("operator", "short"), false);
  // A blank/overlong username refuses too.
  assert.equal(svc.setPassword("   ", "a-long-enough-password").ok, false);
  assert.equal(svc.setPassword("x".repeat(65), "a-long-enough-password").ok, false);
});

test("identity: setPassword + verifyPassword round-trip — right passes, wrong password and wrong username fail", () => {
  const dir = tempDir("gus-identity-");
  const svc = new IdentityService(dir);
  const set = svc.setPassword("operator", "correct horse battery");
  assert.equal(set.ok, true);
  assert.match(set.detail, /does not by itself switch the active provider/);
  assert.equal(svc.identity().provider, "local", "setting a password does NOT switch the active provider");

  assert.equal(svc.verifyPassword("operator", "correct horse battery"), true);
  assert.equal(svc.verifyPassword("operator", "correct horse batter"), false);
  assert.equal(svc.verifyPassword("operator", ""), false);
  assert.equal(svc.verifyPassword("someone-else", "correct horse battery"), false);

  // The local-password provider now reads as configured and
  // authenticates through the same verification path.
  const lp = svc.provider("local-password");
  assert.equal(lp.configured(), true);
  assert.deepEqual(lp.authenticate({ username: "operator", password: "correct horse battery" }), {
    ok: true,
    principal: "operator",
  });
  assert.equal(lp.authenticate({ username: "operator", password: "nope-nope-nope" }).ok, false);

  // A fresh instance over the same dir verifies the same way.
  const fresh = new IdentityService(dir);
  assert.equal(fresh.verifyPassword("operator", "correct horse battery"), true);
});

test("identity: the credentials file holds only a salt + digest, 0600, never the plaintext", () => {
  const dir = tempDir("gus-identity-");
  const svc = new IdentityService(dir);
  const password = "a-very-distinctive-password-123";
  assert.equal(svc.setPassword("operator", password).ok, true);
  const text = readFileSync(join(dir, "identity-credentials.json"), "utf8");
  assert.ok(!text.includes(password), "the plaintext password is never written to disk");
  assert.equal(statSync(join(dir, "identity-credentials.json")).mode & 0o777, 0o600);
  const stored = JSON.parse(text) as { username: string; salt: string; hash: string };
  assert.equal(stored.username, "operator");
  assert.equal(stored.salt.length, 32, "the salt is 16 random bytes, hex");
  assert.equal(stored.hash.length, 128, "the hash is a 64-byte scrypt digest, hex");
});

test("identity: the unconfigured local-password provider explains itself plainly", () => {
  const svc = new IdentityService(tempDir("gus-identity-"));
  const lp = svc.provider("local-password");
  assert.equal(lp.configured(), false);
  const r = lp.authenticate({ username: "operator", password: "whatever-123" });
  assert.equal(r.ok, false);
  assert.equal(
    r.ok === false ? r.detail : "",
    "No local password is set — GUS is using no-login local identity. Set a password first if you want one.",
  );
});

test("identity: setActiveProvider gates local-password on a password, and refuses the stubs", () => {
  const dir = tempDir("gus-identity-");
  const svc = new IdentityService(dir);

  const early = svc.setActiveProvider("local-password");
  assert.equal(early.ok, false, "local-password refuses before a password exists");
  assert.equal(svc.identity().provider, "local", "a refused switch changes nothing");

  for (const kind of ["google", "apple", "sso"] as const) {
    const r = svc.setActiveProvider(kind);
    assert.equal(r.ok, false);
    assert.match(r.detail, /isn't configured in this build/);
    assert.equal(svc.identity().provider, "local");
  }

  assert.equal(svc.setPassword("operator", "correct horse battery").ok, true);
  const after = svc.setActiveProvider("local-password");
  assert.equal(after.ok, true, "local-password succeeds once a password is on file");
  assert.equal(svc.identity().provider, "local-password");
  // Persisted: a fresh instance sees the same active provider.
  assert.equal(new IdentityService(dir).identity().provider, "local-password");

  const back = svc.setActiveProvider("local");
  assert.equal(back.ok, true);
  assert.equal(svc.identity().provider, "local");
});

test("identity: clearPassword removes the credential and falls the active provider back to local", () => {
  const dir = tempDir("gus-identity-");
  const svc = new IdentityService(dir);
  assert.equal(svc.setPassword("operator", "correct horse battery").ok, true);
  assert.equal(svc.setActiveProvider("local-password").ok, true);
  assert.equal(svc.verifyPassword("operator", "correct horse battery"), true);

  const cleared = svc.clearPassword();
  assert.equal(cleared.ok, true);
  assert.equal(existsSync(join(dir, "identity-credentials.json")), false, "the credentials file is gone");
  assert.equal(svc.verifyPassword("operator", "correct horse battery"), false);
  assert.equal(svc.provider("local-password").configured(), false);
  assert.equal(
    svc.identity().provider,
    "local",
    "an install never stays pointed at a provider that can no longer authenticate anyone",
  );
  // Clearing again is harmless.
  assert.equal(svc.clearPassword().ok, true);
});
