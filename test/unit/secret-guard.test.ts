import { test } from "node:test";
import assert from "node:assert/strict";
import { screenText, guardEvent } from "../../packages/shared/src/index.js";

const AWS_KEY = "AKIAGUSTEST123456789"; // AKIA + 16 — synthetic, never real
const GH_TOKEN = "ghp_a1B2c3D4e5F6g7H8i9J0kL";

test("aws key is refused, classified, and never carried in findings", () => {
  const r = screenText(`my key is ${AWS_KEY} keep it safe`);
  assert.equal(r.clean, false);
  assert.deepEqual(r.findings.map((f) => f.patternClass), ["aws_key"]);
  assert.ok(!r.redacted.includes(AWS_KEY));
  assert.ok(!JSON.stringify(r.findings).includes(AWS_KEY));
  assert.ok(r.redacted.includes("[secret refused: aws_key]"));
});

test("scanner allowlist placeholders pass (parity with agent-shield-scan)", () => {
  const r = screenText("example: AKIAIOSFODNN7EXAMPLE and YOUR_TOKEN_HERE");
  assert.equal(r.clean, true);
});

test("generic_secret assignment is refused", () => {
  const r = screenText('api_key = "FAKEgustest9876543210XYZ"');
  assert.equal(r.clean, false);
  assert.ok(r.findings.some((f) => f.patternClass === "generic_secret"));
});

test("github token is refused", () => {
  const r = screenText(`token: ${GH_TOKEN}`);
  assert.equal(r.clean, false);
  assert.ok(r.findings.some((f) => f.patternClass === "github_token"));
});

test("pem header is refused", () => {
  const r = screenText("-----BEGIN RSA PRIVATE KEY-----");
  assert.equal(r.clean, false);
  assert.ok(r.findings.some((f) => f.patternClass === "pem_key"));
});

test("credit card requires Luhn (parity with scanner)", () => {
  assert.equal(screenText("card 4111111111111111").clean, false);
  const bad = screenText("card 4111111111111112");
  assert.ok(!bad.findings.some((f) => f.patternClass === "credit_card"));
});

test("benign text is untouched", () => {
  const s = "remind me to water the plants at 6 and buy oat milk";
  const r = screenText(s);
  assert.equal(r.clean, true);
  assert.equal(r.redacted, s);
});

test("guardEvent carries classes + redacted text only", () => {
  const r = screenText(`leak ${AWS_KEY}`);
  const ev = guardEvent("ingress", r);
  assert.equal(ev.kind, "secret_guard_refusal");
  assert.deepEqual(ev.patternClasses, ["aws_key"]);
  assert.ok(!JSON.stringify(ev).includes(AWS_KEY));
});
