/**
 * v0.14.5: the launch gate on the ONE identity (identity.ts) —
 * the first-run welcome marker and the session lifecycle.
 *
 * The properties ARE the tests: a fresh install owes the
 * login screen (no welcomedAt) and has no session; welcoming
 * persists and never moves once set; signing in through the
 * no-login local provider mints a session whose file is 0600
 * and whose readout never carries the token; a local-password
 * sign-in refuses a wrong password and writes nothing; a
 * session minted under one provider reads as signed out after
 * the active provider switches; sign-out removes the file;
 * and a malformed session file reads as signed out, never a
 * throw — the gate must fail toward showing the login screen,
 * never toward crashing the launch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityService } from "../../packages/control-plane/src/identity.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("session: a fresh install owes the welcome and has no session", () => {
  const svc = new IdentityService(tempDir("gus-session-"));
  const status = svc.sessionStatus();
  assert.equal(status.welcomedAt, undefined, "no welcome marker on a fresh identity");
  assert.equal(status.provider, "local");
  assert.equal(status.session, null);
  assert.equal(svc.currentSession(), null);
});

test("session: markWelcomed persists across instances and never moves once set", () => {
  const dir = tempDir("gus-session-");
  const first = new IdentityService(dir).markWelcomed();
  assert.equal(typeof first.welcomedAt, "number");
  const again = new IdentityService(dir).markWelcomed();
  assert.equal(again.welcomedAt, first.welcomedAt, "the marker is the first welcome, not the latest call");
  assert.equal(new IdentityService(dir).sessionStatus().welcomedAt, first.welcomedAt);
});

test("session: sign-in under no-login local mints a 0600 session; the readout never carries the token", () => {
  const dir = tempDir("gus-session-");
  const svc = new IdentityService(dir);
  const result = svc.signIn({});
  assert.equal(result.ok, true);
  assert.equal(result.session?.provider, "local");

  const sessionPath = join(dir, "session.json");
  assert.ok(existsSync(sessionPath), "the session file exists");
  assert.equal(statSync(sessionPath).mode & 0o777, 0o600, "the session file is 0600");
  const stored = JSON.parse(readFileSync(sessionPath, "utf8")) as { token: string };
  assert.ok(/^[0-9a-f]{64}$/.test(stored.token), "the stored token is 32 random bytes as hex");

  const live = svc.currentSession();
  assert.equal(live?.provider, "local");
  assert.ok(!("token" in (live ?? {})), "the session readout carries no token");
  assert.equal(svc.sessionStatus().session?.provider, "local");
  assert.ok(!JSON.stringify(svc.sessionStatus()).includes(stored.token), "the status readout never leaks the token");
});

test("session: local-password sign-in refuses a wrong password and writes nothing; the right one signs in", () => {
  const dir = tempDir("gus-session-");
  const svc = new IdentityService(dir);
  svc.setPassword("op", "correct horse battery");
  svc.setActiveProvider("local-password");

  const wrong = svc.signIn({ username: "op", password: "wrong password" });
  assert.equal(wrong.ok, false);
  assert.ok(!existsSync(join(dir, "session.json")), "a refused sign-in writes no session");
  assert.equal(svc.currentSession(), null);

  const right = svc.signIn({ username: "op", password: "correct horse battery" });
  assert.equal(right.ok, true);
  assert.equal(right.session?.provider, "local-password");
  assert.equal(svc.currentSession()?.provider, "local-password");
});

test("session: a session minted under one provider reads as signed out after the provider switches", () => {
  const dir = tempDir("gus-session-");
  const svc = new IdentityService(dir);
  svc.signIn({});
  assert.ok(svc.currentSession(), "signed in under local");
  svc.setPassword("op", "correct horse battery");
  svc.setActiveProvider("local-password");
  assert.equal(svc.currentSession(), null, "the old provider's session does not skip the new gate");
  assert.ok(!existsSync(join(dir, "session.json")), "the switch cleared the session file");
});

test("session: sign-out removes the session; signing out twice is harmless", () => {
  const dir = tempDir("gus-session-");
  const svc = new IdentityService(dir);
  svc.signIn({});
  const out = svc.signOut();
  assert.equal(out.ok, true);
  assert.equal(svc.currentSession(), null);
  assert.ok(!existsSync(join(dir, "session.json")));
  assert.equal(svc.signOut().ok, true, "a second sign-out is a no-op, not an error");
});

test("session: a malformed session file reads as signed out and never throws", () => {
  const dir = tempDir("gus-session-");
  const svc = new IdentityService(dir);
  svc.identity();
  writeFileSync(join(dir, "session.json"), "{ not json", { mode: 0o600 });
  assert.equal(svc.currentSession(), null);
  writeFileSync(join(dir, "session.json"), JSON.stringify({ token: "short", provider: "local", createdAt: 1 }), {
    mode: 0o600,
  });
  assert.equal(svc.currentSession(), null, "a token without real entropy is not a session");
  writeFileSync(
    join(dir, "session.json"),
    JSON.stringify({ token: "a".repeat(64), provider: "google", createdAt: 1 }),
    { mode: 0o600 },
  );
  assert.equal(svc.currentSession(), null, "a session for a non-active provider does not skip the gate");
});

test("session: the launch gate defaults on; turning it off persists and never touches the credential", () => {
  const dir = tempDir("gus-session-");
  const svc = new IdentityService(dir);
  assert.equal(svc.sessionStatus().launchGateEnabled, true, "absent posture = gate on");
  svc.setLaunchGateEnabled(false);
  assert.equal(svc.sessionStatus().launchGateEnabled, false);
  const reloaded = new IdentityService(dir);
  assert.equal(reloaded.sessionStatus().launchGateEnabled, false, "the posture persists across instances");
  reloaded.setLaunchGateEnabled(true);
  assert.equal(new IdentityService(dir).sessionStatus().launchGateEnabled, true, "and flips back on");
});

test("session: a fresh sign-in replaces the previous session rather than stacking", () => {
  const dir = tempDir("gus-session-");
  const svc = new IdentityService(dir);
  const first = svc.signIn({});
  const firstToken = (JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as { token: string }).token;
  const second = svc.signIn({});
  const secondToken = (JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as { token: string }).token;
  assert.equal(first.ok && second.ok, true);
  assert.notEqual(firstToken, secondToken, "each sign-in mints a fresh token");
});
