/**
 * Phase 4 unit tests: the Shield gate (client + gate policy), the
 * local skill-scan gate, provider classes against fake transports,
 * Governor pricing, panel token auth + delegation, and onboarding
 * state hygiene (secrets land ONLY in the vault's ciphertext).
 *
 * Everything runs against injected fake transports — no network. The
 * live-API proof is the Phase 4 drill's job; these tests pin the
 * wiring and the fail-policy semantics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultBroker } from "../../packages/vault/src/index.js";
import {
  ShieldClient,
  ShieldGate,
  scanSkillTree,
  type ShieldTransport,
} from "../../packages/gate/src/index.js";
import { Governor } from "../../packages/control-plane/src/governor.js";
import { PolicyStore } from "../../packages/control-plane/src/policy.js";
import {
  AnthropicProvider,
  OpenAiCompatibleProvider,
  GeminiProvider,
  GEMINI_BASE_URL,
  loadProviderConfig,
  resolveProvider,
  writeProviderConfig,
  type ProviderTransport,
} from "../../packages/control-plane/src/providers.js";
import { Onboarding, GEMINI_FREE_TIER_NOTE } from "../../packages/control-plane/src/onboarding.js";
import { SkillInstaller } from "../../packages/control-plane/src/skills.js";
import { PanelServer, type PanelBackend } from "../../packages/panel/src/index.js";

const FAKE_SHIELD_KEY = "as_live_UNITTESTKEY_do_not_leak";
const RECEIPT = {
  receipt_id: "rcpt_0123456789abcdef01",
  verify_url: "https://shield.example/v/rcpt_0123456789abcdef01?ts=1&sig=x",
  verdict: "malicious",
  content_hash: "ab12",
  scanned_at: "2026-11-02T00:00:00Z",
  analyzer: "heuristic_v5",
  signature: "deadbeef",
  key_id: "rk2",
};

function tempVault(): { dir: string; vault: VaultBroker } {
  const dir = mkdtempSync(join(tmpdir(), "gus-p4-"));
  return { dir, vault: new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key")) };
}

/** Fake Shield API: verdict chosen by a marker in the content. */
function fakeShieldTransport(calls: { url: string; headers: Record<string, string> }[]): ShieldTransport {
  return async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (url.endsWith("/v1/signup")) {
      return { status: 200, json: async () => ({ api_key: FAKE_SHIELD_KEY, tier: "free" }) };
    }
    if (url.endsWith("/v2/scan")) {
      const body = JSON.parse(init.body ?? "{}") as { content: string };
      if (body.content.includes("MARK_MALICIOUS")) {
        return {
          status: 200,
          json: async () => ({ verdict: "malicious", action: "block", findings: [], receipt: RECEIPT }),
        };
      }
      if (body.content.includes("MARK_SUSPICIOUS")) {
        return {
          status: 200,
          json: async () => ({
            verdict: "suspicious",
            action: "review",
            findings: [],
            receipt: { ...RECEIPT, receipt_id: "rcpt_0123456789abcdef02", verdict: "suspicious" },
          }),
        };
      }
      return {
        status: 200,
        json: async () => ({
          verdict: "no_signals",
          action: "allow",
          findings: [],
          receipt: { ...RECEIPT, receipt_id: "rcpt_0123456789abcdef03", verdict: "no_signals" },
        }),
      };
    }
    if (url.endsWith("/v1/receipts/verify")) {
      return { status: 200, json: async () => ({ valid: true, receipt_id: RECEIPT.receipt_id }) };
    }
    return { status: 404, json: async () => ({}) };
  };
}

function makeGate(
  vault: VaultBroker,
  dir: string,
  policy: { required: boolean; onUnavailable: "closed" | "open" },
  transport?: ShieldTransport,
): { gate: ShieldGate; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const client = new ShieldClient({
    vault,
    baseUrl: "https://shield.example",
    transport: transport ?? fakeShieldTransport(calls),
  });
  const gate = new ShieldGate({ client, policy: () => policy, logPath: join(dir, "gate.jsonl") });
  return { gate, calls };
}

test("shield client: signup stores the key in the vault and never returns it", async () => {
  const { vault } = tempVault();
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const client = new ShieldClient({
    vault,
    baseUrl: "https://shield.example",
    transport: fakeShieldTransport(calls),
  });
  const result = await client.provision("gus");
  assert.equal(result.ok, true);
  assert.equal(vault.has("agent-shield"), true);
  assert.ok(!JSON.stringify(result).includes(FAKE_SHIELD_KEY), "provision result must not carry the key");
  // Second provision is a no-op (already provisioned) — no second signup.
  const again = await client.provision("gus");
  assert.equal(again.already, true);
  assert.equal(calls.filter((c) => c.url.endsWith("/v1/signup")).length, 1);
});

test("shield client: scan parses verdict + receipt; key rides only in the header", async () => {
  const { vault } = tempVault();
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const client = new ShieldClient({
    vault,
    baseUrl: "https://shield.example",
    transport: fakeShieldTransport(calls),
  });
  await client.provision("gus");
  const outcome = await client.scan("MARK_MALICIOUS payload", "prompt", "job-1");
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;
  assert.equal(outcome.verdict, "malicious");
  assert.equal(outcome.receipt?.receiptId, RECEIPT.receipt_id);
  const scanCall = calls.find((c) => c.url.endsWith("/v2/scan"));
  assert.equal(scanCall?.headers["x-api-key"], FAKE_SHIELD_KEY);
  assert.ok(!JSON.stringify(outcome).includes(FAKE_SHIELD_KEY), "scan outcome must not carry the key");
  const verified = await client.verifyReceipt(outcome.receiptRaw ?? {});
  assert.equal(verified, true);
});

/** A transport that captures the /v2/scan request BODIES — the
 *  fast-mode tests' witness: the flag must be in the JSON, and
 *  only when it was asked for. */
function bodyCapturingTransport(bodies: Record<string, unknown>[]): ShieldTransport {
  return async (url, init) => {
    if (url.endsWith("/v1/signup")) {
      return { status: 200, json: async () => ({ api_key: FAKE_SHIELD_KEY, tier: "free" }) };
    }
    if (url.endsWith("/v2/scan")) {
      bodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
      return {
        status: 200,
        json: async () => ({
          verdict: "no_signals",
          action: "allow",
          findings: [],
          receipt: { ...RECEIPT, receipt_id: "rcpt_0123456789abcdef04", verdict: "no_signals" },
        }),
      };
    }
    return { status: 404, json: async () => ({}) };
  };
}

test("shield client (v0.9.10): fastScan sends fast:true — and only then", async () => {
  const { vault } = tempVault();
  const bodies: Record<string, unknown>[] = [];
  const client = new ShieldClient({
    vault,
    baseUrl: "https://shield.example",
    transport: bodyCapturingTransport(bodies),
  });
  await client.provision("gus");

  const plain = await client.scan("an ordinary message", "prompt", "job-plain");
  assert.equal(plain.status, "ok");
  assert.equal(bodies.length, 1);
  assert.ok(!("fast" in bodies[0]), "the default request carries no fast field — byte-identical to before");
  assert.equal(bodies[0].mode, "enforce");
  assert.equal(bodies[0].content_type, "prompt");

  const fast = await client.scan("a spoken message", "prompt", "job-fast", { fastScan: true });
  assert.equal(fast.status, "ok");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].fast, true, "the fast request carries fast: true");

  const explicitOff = await client.scan("another message", "prompt", "job-off", { fastScan: false });
  assert.equal(explicitOff.status, "ok");
  assert.ok(!("fast" in bodies[2]), "fastScan:false is the default request too — never fast: false");
});

test("shield gate (v0.9.10): scanSurface's fastScan rides to the request and the log — only when passed", async () => {
  const { dir, vault } = tempVault();
  const bodies: Record<string, unknown>[] = [];
  const client = new ShieldClient({
    vault,
    baseUrl: "https://shield.example",
    transport: bodyCapturingTransport(bodies),
  });
  const gate = new ShieldGate({
    client,
    policy: () => ({ required: true, onUnavailable: "closed" }),
    logPath: join(dir, "gate.jsonl"),
  });
  await gate.provision();

  const fastDecision = await gate.scanSurface("inbound-message", "job-v", "a spoken turn", { fastScan: true });
  assert.equal(fastDecision.action, "allow");
  assert.equal(fastDecision.scanned, true);
  assert.equal(bodies[0].fast, true, "the voice-shaped call asked for fast mode");

  const fullDecision = await gate.scanSurface("tool-result", "job-t", "a fetched page");
  assert.equal(fullDecision.action, "allow");
  assert.ok(!("fast" in bodies[1]), "a tool-result scan without opts never goes fast");

  const lines = readFileSync(join(dir, "gate.jsonl"), "utf8").trim().split("\n");
  const entries = lines.map((l) => JSON.parse(l) as { jobId: string; fast?: boolean });
  assert.equal(entries.find((e) => e.jobId === "job-v")?.fast, true, "the gate log names the fast scan");
  assert.equal(entries.find((e) => e.jobId === "job-t")?.fast, undefined, "and stays silent about full scans");
});

test("shield gate: malicious blocks with receipt, suspicious flags, clean allows; log holds no content", async () => {
  const { dir, vault } = tempVault();
  const { gate } = makeGate(vault, dir, { required: true, onUnavailable: "closed" });
  await gate.provision();

  const blocked = await gate.scanSurface("inbound-message", "job-1", "MARK_MALICIOUS UNIQUE_CONTENT_MARKER_1");
  assert.equal(blocked.action, "block");
  assert.equal(blocked.receipt?.receiptId, RECEIPT.receipt_id);

  const flagged = await gate.scanSurface("tool-call", "job-1", "MARK_SUSPICIOUS args");
  assert.equal(flagged.action, "flag");
  assert.ok(flagged.receipt);

  const allowed = await gate.scanSurface("tool-result", "job-1", "an ordinary page");
  assert.equal(allowed.action, "allow");
  assert.equal(allowed.verdict, "no_signals");

  const log = readFileSync(join(dir, "gate.jsonl"), "utf8");
  assert.ok(!log.includes("UNIQUE_CONTENT_MARKER_1"), "gate log must never contain scanned content");
  assert.ok(log.includes(RECEIPT.receipt_id), "gate log carries the receipt id for re-verification");
});

test("shield gate: unprovisioned + not required skips (Phase 0-3 behavior); required fails closed", async () => {
  const { dir, vault } = tempVault();
  const optional = makeGate(vault, dir, { required: false, onUnavailable: "closed" }).gate;
  const skipped = await optional.scanSurface("inbound-message", "job-1", "anything");
  assert.equal(skipped.action, "allow");
  assert.equal(skipped.scanned, false);

  const required = makeGate(vault, dir, { required: true, onUnavailable: "closed" }).gate;
  const blocked = await required.scanSurface("inbound-message", "job-1", "anything");
  assert.equal(blocked.action, "block");
  assert.equal(blocked.receipt, null, "an unavailability block must NOT invent a receipt");
  assert.match(blocked.detail, /fail-closed|required by policy/);

  const requiredOpen = makeGate(vault, dir, { required: true, onUnavailable: "open" }).gate;
  const flagged = await requiredOpen.scanSurface("inbound-message", "job-1", "anything");
  assert.equal(flagged.action, "flag");
  assert.equal(flagged.receipt, null);
  assert.match(flagged.detail, /NO scan happened and no receipt exists/);
});

test("shield gate: API outage honors the operator's recorded fail policy", async () => {
  const { dir, vault } = tempVault();
  vault.add("agent-shield", FAKE_SHIELD_KEY);
  const down: ShieldTransport = async () => {
    throw new Error("connection refused");
  };
  const closed = makeGate(vault, dir, { required: true, onUnavailable: "closed" }, down).gate;
  const blocked = await closed.scanSurface("tool-call", "job-9", "{}");
  assert.equal(blocked.action, "block");
  assert.equal(blocked.receipt, null);

  const open = makeGate(vault, dir, { required: false, onUnavailable: "open" }, down).gate;
  const flagged = await open.scanSurface("tool-call", "job-9", "{}");
  assert.equal(flagged.action, "flag");
  assert.equal(flagged.scanned, false);
});

test("skill scan gate: planted skill and planted MCP config are do-not-install; clean skill is clean", () => {
  const base = join(process.cwd(), "test", "fixtures", "skills");
  const planted = scanSkillTree(join(base, "planted-skill"));
  assert.equal(planted.verdict, "do_not_install");
  assert.ok(planted.findings.some((f) => f.severity === "critical" || f.severity === "high"));

  const mcp = scanSkillTree(join(base, "planted-mcp", "mcp.json"));
  assert.equal(mcp.verdict, "do_not_install");

  const clean = scanSkillTree(join(base, "clean-skill"));
  assert.equal(clean.verdict, "clean");
  assert.equal(clean.findings.length, 0);
});

test("skill installer: refuses the planted skill (nothing copied), installs the clean one", () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-p4-skills-"));
  const installer = new SkillInstaller(dir);
  const base = join(process.cwd(), "test", "fixtures", "skills");

  const refused = installer.install(join(base, "planted-skill"));
  assert.equal(refused.ok, false);
  assert.equal(refused.verdict, "do_not_install");
  assert.equal(existsSync(join(dir, "skills", "planted-skill")), false);

  const installed = installer.install(join(base, "clean-skill"));
  assert.equal(installed.ok, true);
  assert.equal(installed.verdict, "clean");
  assert.equal(existsSync(join(dir, "skills", "clean-skill", "SKILL.md")), true);
  assert.deepEqual(installer.listInstalled().map((s) => s.name), ["clean-skill"]);
});

test("providers: Anthropic + OpenAI-compatible parse text and usage via fake transports", async () => {
  const { vault } = tempVault();
  vault.add("anthropic", "sk-ant-unit");
  vault.add("openai", "sk-unit-1234");

  const anthropicTransport: ProviderTransport = async (url, init) => {
    assert.ok(url.endsWith("/v1/messages"));
    assert.equal(init.headers["x-api-key"], "sk-ant-unit");
    return {
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "hello from claude" }],
        usage: { input_tokens: 11, output_tokens: 7 },
      }),
    };
  };
  const anthropic = new AnthropicProvider(vault, "claude-sonnet-5", { transport: anthropicTransport });
  const a = await anthropic.complete("hi");
  assert.equal(a.reply.text, "hello from claude");
  assert.equal(a.tokensIn, 11);
  assert.equal(a.tokensOut, 7);
  assert.equal(anthropic.modelKey, "anthropic/claude-sonnet-5");
  assert.equal(anthropic.kind, "remote");

  const openaiTransport: ProviderTransport = async (url, init) => {
    assert.ok(url.endsWith("/chat/completions"));
    assert.equal(init.headers.authorization, "Bearer sk-unit-1234");
    return {
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "hello from gpt" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    };
  };
  const openai = new OpenAiCompatibleProvider(vault, {
    id: "openai",
    model: "gpt-5-mini",
    baseUrl: "https://api.openai.com/v1",
    keyName: "openai",
    keyRequired: true,
    who: "OpenAI",
    transport: openaiTransport,
  });
  const o = await openai.complete("hi");
  assert.equal(o.reply.text, "hello from gpt");
  assert.equal(o.tokensIn, 5);
  assert.equal(openai.modelKey, "openai/gpt-5-mini");

  // Ollama: no key in the vault, none required, none sent.
  const ollamaTransport: ProviderTransport = async (_url, init) => {
    assert.equal(init.headers.authorization, undefined);
    return {
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "local hello" } }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }),
    };
  };
  const ollama = new OpenAiCompatibleProvider(vault, {
    id: "ollama",
    model: "llama3.1:8b",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyName: "ollama",
    keyRequired: false,
    who: "Ollama",
    transport: ollamaTransport,
  });
  assert.equal((await ollama.complete("hi")).reply.text, "local hello");
});

test("providers (v0.9.11): an empty reply is retried ONCE — empty-then-text succeeds with usage summed; empty-empty throws the named error", async () => {
  const { vault } = tempVault();
  vault.add("anthropic", "sk-ant-unit");
  vault.add("openai", "sk-unit-1234");

  // OpenAI-compatible: first attempt answers 200 with no text,
  // the retry answers for real. Exactly two transport calls,
  // and the token usage is the SUM across both attempts.
  let calls = 0;
  const flakyTransport: ProviderTransport = async () => {
    calls++;
    if (calls === 1) {
      return {
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "" } }],
          usage: { prompt_tokens: 4, completion_tokens: 0 },
        }),
      };
    }
    return {
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "second wind" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      }),
    };
  };
  const flaky = new OpenAiCompatibleProvider(vault, {
    id: "openai",
    model: "gpt-5-mini",
    baseUrl: "https://api.openai.com/v1",
    keyName: "openai",
    keyRequired: true,
    who: "OpenAI",
    transport: flakyTransport,
  });
  const done = await flaky.complete("hi");
  assert.equal(done.reply.text, "second wind");
  assert.equal(calls, 2, "exactly one retry — no more, no fewer");
  assert.equal(done.tokensIn, 8, "input usage summed across both attempts");
  assert.equal(done.tokensOut, 3, "output usage summed across both attempts");

  // Empty twice: the job fails, with the error naming the
  // configured backend AND model — and still exactly two calls
  // (the retry is not a loop).
  let emptyCalls = 0;
  const emptyTransport: ProviderTransport = async () => {
    emptyCalls++;
    return {
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "" } }],
        usage: { prompt_tokens: 4, completion_tokens: 0 },
      }),
    };
  };
  const empty = new OpenAiCompatibleProvider(vault, {
    id: "openai",
    model: "gpt-5-mini",
    baseUrl: "https://api.openai.com/v1",
    keyName: "openai",
    keyRequired: true,
    who: "OpenAI",
    transport: emptyTransport,
  });
  await assert.rejects(() => empty.complete("hi"), /OpenAI \(gpt-5-mini\) returned no text/);
  assert.equal(emptyCalls, 2, "one retry, then the named failure");

  // Anthropic: the same seam — empty-then-text succeeds with
  // usage summed, empty-empty throws its named error.
  let aCalls = 0;
  const aFlaky: ProviderTransport = async () => {
    aCalls++;
    if (aCalls === 1) {
      return { status: 200, json: async () => ({ content: [], usage: { input_tokens: 6, output_tokens: 0 } }) };
    }
    return {
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "claude, second wind" }],
        usage: { input_tokens: 6, output_tokens: 5 },
      }),
    };
  };
  const anthropic = new AnthropicProvider(vault, "claude-sonnet-5", { transport: aFlaky });
  const aDone = await anthropic.complete("hi");
  assert.equal(aDone.reply.text, "claude, second wind");
  assert.equal(aCalls, 2);
  assert.equal(aDone.tokensIn, 12, "input usage summed across both attempts");
  assert.equal(aDone.tokensOut, 5);

  const aEmpty = new AnthropicProvider(vault, "claude-sonnet-5", {
    transport: async () => ({
      status: 200,
      json: async () => ({ content: [], usage: { input_tokens: 6, output_tokens: 0 } }),
    }),
  });
  await assert.rejects(() => aEmpty.complete("hi"), /Anthropic \(claude-sonnet-5\) returned no text/);
});

test("providers (v0.9.11): factory errors name the CONFIGURED backend — Meta for Meta's base URL, OpenAI for OpenAI's", async () => {
  const { dir, vault } = tempVault();
  vault.add("openai", "sk-unit-1234");
  const emptyTransport: ProviderTransport = async () => ({
    status: 200,
    json: async () => ({
      choices: [{ message: { content: "" } }],
      usage: { prompt_tokens: 4, completion_tokens: 0 },
    }),
  });

  // The field case (2026-11-12): an "openai"-shaped config whose
  // baseUrl is Meta's API and whose model is muse-spark-1.3 must
  // fail as Meta — the bare class name blamed the wrong vendor
  // for every empty reply and refusal.
  writeProviderConfig(dir, {
    provider: "openai",
    model: "muse-spark-1.3",
    baseUrl: "https://api.meta.ai/v1",
  });
  const meta = resolveProvider(dir, vault, emptyTransport);
  await assert.rejects(() => meta.complete("hi"), /Meta \(muse-spark-1\.3\) returned no text/);

  // A BYOK config pointed at OpenAI itself still says OpenAI —
  // the name is derived from the config, not special-cased.
  writeProviderConfig(dir, { provider: "openai", model: "gpt-5-mini" });
  const openai = resolveProvider(dir, vault, emptyTransport);
  await assert.rejects(() => openai.complete("hi"), /OpenAI \(gpt-5-mini\) returned no text/);
});

test("governor pricing: built-in per-model rates; local models cost $0", () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-p4-gov-"));
  const governor = new Governor(dir);
  assert.equal(governor.costFor("anthropic/claude-sonnet-5", 1000, 0), 0.009);
  assert.equal(governor.costFor("openai/gpt-5-mini", 1000, 0), 0.0011);
  assert.equal(governor.costFor("ollama/llama3.1:8b", 5000, 5000), 0);
  assert.equal(governor.costFor("gateway/llama3.1:8b", 5000, 5000), 0);
  assert.equal(governor.costFor("stub/stub-v0", 5000, 5000), 0);
});

test("providers: Gemini — vault key injected ONLY at Google's pinned endpoint", async () => {
  const { dir, vault } = tempVault();
  const FAKE_GEMINI_KEY = "AIzaUnitTestGeminiKey00000000000";
  vault.add("gemini", FAKE_GEMINI_KEY);

  const seen: { url: string; headers: Record<string, string>; body?: string }[] = [];
  const transport: ProviderTransport = async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    return {
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "hello from gemini" } }],
        usage: { prompt_tokens: 9, completion_tokens: 4 },
      }),
    };
  };
  const gemini = new GeminiProvider(vault, "gemini-3.5-flash", { transport });
  const g = await gemini.complete("hi");
  assert.equal(g.reply.text, "hello from gemini");
  assert.equal(g.tokensIn, 9);
  assert.equal(g.tokensOut, 4);
  assert.equal(gemini.id, "gemini");
  assert.equal(gemini.modelKey, "gemini/gemini-3.5-flash");
  assert.equal(gemini.kind, "remote");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${GEMINI_BASE_URL}/chat/completions`);
  assert.ok(seen[0].url.startsWith("https://generativelanguage.googleapis.com/"));
  assert.equal(seen[0].headers.authorization, `Bearer ${FAKE_GEMINI_KEY}`);
  // Request shaping matches the OpenAI-compatible contract.
  const sentBody = JSON.parse(seen[0].body ?? "{}") as { model?: string; messages?: unknown };
  assert.equal(sentBody.model, "gemini-3.5-flash");
  // Phase 9: the prompt carries the tool protocol; the operator's
  // text rides at the end of it.
  const sentContent = (sentBody.messages as { content?: string }[])?.[0]?.content ?? "";
  assert.ok(sentContent.includes("mac.open_app"), "tool protocol lists the tools");
  assert.ok(sentContent.endsWith("hi"), "the raw prompt closes the message");

  // The preview model is a first-class citizen too.
  const preview = new GeminiProvider(vault, "gemini-3-flash-preview", { transport });
  assert.equal(preview.modelKey, "gemini/gemini-3-flash-preview");
  await preview.complete("hi");
  assert.equal(seen[1].url, `${GEMINI_BASE_URL}/chat/completions`);

  // Key required: an empty vault is a plain operator error, and no
  // request leaves the process.
  const { vault: emptyVault } = tempVault();
  const noKey = new GeminiProvider(emptyVault, "gemini-3.5-flash", { transport });
  await assert.rejects(() => noKey.complete("hi"), /no vault secret named "gemini"/);
  assert.equal(seen.length, 2, "no transport call may happen without the key");

  // Factory: provider.json selects gemini, and a hostile baseUrl in
  // config is IGNORED — the class stays pinned to Google's host, so
  // the key cannot be redirected elsewhere by a config edit.
  writeProviderConfig(dir, {
    provider: "gemini",
    model: "gemini-3.5-flash",
    baseUrl: "https://evil.example/v1",
  });
  const resolved = resolveProvider(dir, vault, transport);
  assert.equal(resolved.id, "gemini");
  assert.equal(resolved.modelKey, "gemini/gemini-3.5-flash");
  await resolved.complete("hi");
  assert.equal(seen[2].url, `${GEMINI_BASE_URL}/chat/completions`);
  assert.equal(seen[2].headers.authorization, `Bearer ${FAKE_GEMINI_KEY}`);
});

test("governor: a Gemini call reserves and settles at the built-in rate", () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-p4-gemgov-"));
  const governor = new Governor(dir, { maxTokensPerJob: 1_000_000, maxTokensPerDay: 1_000_000 });
  // Published paid-tier rates, blended per 1k (see governor.ts).
  assert.equal(governor.costFor("gemini/gemini-3.5-flash", 1000, 0), 0.00525);
  assert.equal(governor.costFor("gemini/gemini-3-flash-preview", 1000, 0), 0.00175);
  const auth = governor.authorize("job-gemini", 1000, 1000, "gemini/gemini-3.5-flash");
  assert.equal(auth.ok, true);
  if (auth.ok) governor.settle(auth.reservationId, 1000, 1000);
  const audit = governor.audit();
  assert.equal(audit.reconciles, true);
  assert.equal(audit.openReservations, 0);
  assert.equal(audit.settledUsd, governor.costFor("gemini/gemini-3.5-flash", 1000, 1000));
});

// ------------------------------------------------------------- panel

function stubBackend(calls: string[]): PanelBackend {
  const action = async (name: string) => {
    calls.push(name);
    return { ok: true, detail: `${name} done` };
  };
  return {
    status: () => ({
      version: "0.3.0",
      killed: false,
      shield: { provisioned: true, required: true, onUnavailable: "closed", baseUrl: "https://shield.example" },
      provider: { id: "stub", model: "stub-v0" },
      pendingApprovals: 1,
      spendTodayUsd: 0,
      spendMonthUsd: 0,
      governorMode: "enforcing" as const,
      permissiveToday: { count: 0, recent: [] },
      settings: {
        providerKey: "stored" as const,
        telegramConfigured: true,
        caps: { maxUsdPerTask: 2, maxUsdPerDay: 10, maxUsdPerMonth: 100 },
        delegates: 1,
        macWorkDirs: 4,
        approverPolicy: {
          gusApprovesDelegates: false,
          gusApprovesOwn: false,
          delegatesMayApprove: false,
          scope: "bounded" as const,
          maxApprovalsPerHour: 30,
        },
        voice: { enabled: false, configured: false },
      },
    }),
    ledger: () => ({
      entries: [],
      audit: { reserves: 0, settles: 0, refunds: 0, openReservations: 0, settledUsd: 0, reconciles: true },
      summary: { todayUsd: 0, monthUsd: 0, totalUsd: 0, caps: {} },
    }),
    jobs: () => [],
    approvals: () => [
      { id: "ap1", jobId: "job-1", summary: "Delete 3 files", reason: "destructive", createdAt: 1, expiresAt: 2 },
    ],
    approvalsHistory: () => [
      { id: "ap0", jobId: "job-0", summary: "Write a file", reason: "outside the sandbox", status: "approved", createdAt: 0, resolvedAt: 1, resolvedBy: "panel" },
    ],
    resolveApproval: async (id, approve) => {
      calls.push(`resolve:${id}:${approve}`);
      return { ok: true, detail: "resolved" };
    },
    setKilled: async (on) => {
      calls.push(`kill:${on}`);
      return { ok: true, detail: "kill toggled" };
    },
    setGovernorMode: async (mode) => {
      calls.push(`mode:${mode}`);
      return { ok: true, detail: "mode set" };
    },
    setApproverPolicy: async (p) => {
      calls.push(`approver:${p.scope}`);
      return { ok: true, detail: "approver policy set" };
    },
    setShieldPolicy: async (p) => {
      calls.push(`shield:${p.required}:${p.onUnavailable}`);
      return { ok: true, detail: "shield policy set" };
    },
    settingsDetail: () => ({
      macWorkDirs: ["/Users/op/work"],
      macShellAllowlist: ["ls"],
      delegates: [
        { conversationId: "-1001", operatorId: "42", delegates: [{ name: "Nova", senderId: "99" }] },
      ],
      bridge: { conversationId: "-1001", senderId: "99" },
    }),
    vaultNames: () => ["agent-shield"],
    storeSecret: (name) => {
      calls.push(`vault:${name}`);
      return { ok: true, detail: "stored" };
    },
    onboarding: () => ({
      steps: {
        shield: { done: false },
        telegram: { done: false },
        provider: { done: false },
        caps: { done: false },
        firstJob: { done: false },
      },
      suggestedCaps: { maxUsdPerTask: 2, maxUsdPerDay: 10, maxUsdPerMonth: 100 },
    }),
    onboardingShield: () => action("ob:shield"),
    onboardingTelegram: () => action("ob:telegram"),
    onboardingProvider: () => action("ob:provider"),
    onboardingCaps: () => action("ob:caps"),
    onboardingFirstJob: async () => ({ ok: true, detail: "started", jobId: "job-x" }),
    skills: () => [],
    installSkill: () => action("skill:install"),
    submitChat: async (text: string) => {
      calls.push(`chat:${text}`);
      return { ok: true, detail: "sent" };
    },
    chatHistory: () => ({ conversationId: "panel-chat", messages: [], jobs: [] }),
    watchFrame: async () => ({ ok: false as const, detail: "no frame in the stub" }),
    watchTimeline: () => [],
    voiceSettings: () => ({
      enabled: false,
      sttBaseUrl: "http://127.0.0.1:8000/v1",
      sttModel: "whisper-1",
      ttsBaseUrl: "http://127.0.0.1:8880/v1",
      ttsModel: "kokoro",
      ttsVoice: "af_heart",
    }),
    setVoiceSettings: () => action("voice:settings"),
    voiceCall: async () => ({ ok: false, kind: "unavailable", detail: "voice is not wired in this stub" }),
    voiceSessionStart: () => ({ ok: false, active: false, detail: "voice sessions are not wired in this stub", turns: [] }),
    voiceSessionAudio: () => ({ ok: false, detail: "voice sessions are not wired in this stub" }),
    voiceSessionTranscript: () => ({ ok: false, detail: "voice sessions are not wired in this stub" }),
    voiceSessionState: () => ({ ok: false, active: false, detail: "voice sessions are not wired in this stub", turns: [] }),
    voiceSessionNextAudio: () => ({ ok: false, detail: "voice sessions are not wired in this stub" }),
    voiceSessionInterrupt: () => ({ ok: false, detail: "voice sessions are not wired in this stub" }),
    voiceSessionEnd: () => ({ ok: false, active: false, detail: "voice sessions are not wired in this stub", turns: [] }),
  };
}

test("panel: token gates every route; approvals and kill delegate to the backend", async () => {
  const calls: string[] = [];
  const panel = new PanelServer(stubBackend(calls), { token: "test-token-123", port: 0 });
  await panel.start();
  try {
    const base = `http://127.0.0.1:${panel.port}`;
    const noAuth = await fetch(`${base}/api/status`);
    assert.equal(noAuth.status, 401);
    const badAuth = await fetch(`${base}/api/status`, {
      headers: { authorization: "Bearer wrong-token-999" },
    });
    assert.equal(badAuth.status, 401);
    const pageNoAuth = await fetch(`${base}/`);
    assert.equal(pageNoAuth.status, 401, "even the page itself requires the token");

    const okRes = await fetch(`${base}/api/status`, {
      headers: { authorization: "Bearer test-token-123" },
    });
    assert.equal(okRes.status, 200);
    const status = (await okRes.json()) as { version: string };
    assert.equal(status.version, "0.3.0");

    const page = await fetch(`${base}/?t=test-token-123`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("set-cookie") ?? "", /gus_panel=/);
    assert.match(await page.text(), /GUS control panel/);

    const approve = await fetch(`${base}/api/approvals/ap1/approve`, {
      method: "POST",
      headers: { authorization: "Bearer test-token-123", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(approve.status, 200);
    const kill = await fetch(`${base}/api/kill`, {
      method: "POST",
      headers: { authorization: "Bearer test-token-123", "content-type": "application/json" },
      body: JSON.stringify({ on: true }),
    });
    assert.equal(kill.status, 200);
    assert.deepEqual(calls, ["resolve:ap1:true", "kill:true"]);
  } finally {
    await panel.stop();
  }
});

// -------------------------------------------------------- onboarding

test("onboarding: five steps complete; secrets exist ONLY as vault ciphertext", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-p4-onb-"));
  const vault = new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key"));
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const client = new ShieldClient({
    vault,
    baseUrl: "https://shield.example",
    transport: fakeShieldTransport(calls),
  });
  const gate = new ShieldGate({
    client,
    policy: () => ({ required: false, onUnavailable: "closed" }),
    logPath: join(dir, "gate.jsonl"),
  });
  const policy = new PolicyStore(join(dir, "policy.json"));
  const governor = new Governor(dir);
  const onboarding = new Onboarding(dir, {
    vault,
    gate,
    policy,
    governor,
    runFirstJob: () => "job_digest_test",
  });

  const shield = await onboarding.shield("closed");
  assert.equal(shield.ok, true);
  assert.equal(policy.shieldPolicy().required, true);
  assert.equal(policy.shieldPolicy().onUnavailable, "closed");
  assert.equal(vault.has("agent-shield"), true);

  const badToken = onboarding.telegram("not-a-token");
  assert.equal(badToken.ok, false);
  const tg = onboarding.telegram("123456789:AAUnitTestTokenValue1234567");
  assert.equal(tg.ok, true);
  assert.equal(vault.has("telegram-bot"), true);

  const noKey = onboarding.provider({ provider: "openai", model: "gpt-5-mini" });
  assert.equal(noKey.ok, false, "a key-requiring provider without a key is refused plainly");
  const provider = onboarding.provider({
    provider: "anthropic",
    model: "claude-sonnet-5",
    apiKey: "sk-ant-UNITTESTSECRET",
  });
  assert.equal(provider.ok, true);
  assert.equal(loadProviderConfig(dir).provider, "anthropic");
  assert.equal(vault.has("anthropic"), true);

  const caps = onboarding.caps({});
  assert.equal(caps.ok, true);
  const govCfg = governor.config();
  assert.equal(govCfg.maxUsdPerTask, 2);
  assert.equal(govCfg.maxUsdPerDay, 10);
  assert.equal(govCfg.maxUsdPerMonth, 100);

  const first = onboarding.firstJob();
  assert.equal(first.ok, true);
  assert.equal(first.jobId, "job_digest_test");

  const view = onboarding.view();
  assert.ok(Object.values(view.steps).every((s) => s.done), "all five steps read back as done");

  // The hygiene assertion: walk every state file; the secret VALUES
  // must appear nowhere — the vault file holds ciphertext only.
  const secrets = [FAKE_SHIELD_KEY, "sk-ant-UNITTESTSECRET", "123456789:AAUnitTestTokenValue1234567"];
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((name) => {
      const p = join(d, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  for (const file of walk(dir)) {
    const content = readFileSync(file, "utf8");
    for (const secret of secrets) {
      assert.ok(!content.includes(secret), `secret leaked into ${file}`);
    }
  }
});

test("onboarding: Gemini is a choice inside the provider step (no new step, key to vault only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-p4-onb-gem-"));
  const vault = new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key"));
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const client = new ShieldClient({
    vault,
    baseUrl: "https://shield.example",
    transport: fakeShieldTransport(calls),
  });
  const gate = new ShieldGate({
    client,
    policy: () => ({ required: false, onUnavailable: "closed" }),
    logPath: join(dir, "gate.jsonl"),
  });
  const onboarding = new Onboarding(dir, {
    vault,
    gate,
    policy: new PolicyStore(join(dir, "policy.json")),
    governor: new Governor(dir),
    runFirstJob: () => "job_digest_gemini",
  });

  // Gemini without a key is refused plainly, like the other BYOK classes.
  const noKey = onboarding.provider({ provider: "gemini" });
  assert.equal(noKey.ok, false, "gemini without a key is refused plainly");

  const FAKE_GEMINI_KEY = "AIzaUnitTestWizardKey0000000000";
  const chosen = onboarding.provider({ provider: "gemini", apiKey: FAKE_GEMINI_KEY });
  assert.equal(chosen.ok, true);
  assert.ok(chosen.detail.includes(GEMINI_FREE_TIER_NOTE), "the free-tier disclosure rides the confirmation");
  // Default model pre-fill is the recommended starter model.
  const cfg = loadProviderConfig(dir);
  assert.equal(cfg.provider, "gemini");
  assert.equal(cfg.model, "gemini-3.5-flash");
  assert.equal(vault.has("gemini"), true);

  // The preview model is selectable in the same step.
  const preview = onboarding.provider({ provider: "gemini", model: "gemini-3-flash-preview" });
  assert.equal(preview.ok, true);
  assert.equal(loadProviderConfig(dir).model, "gemini-3-flash-preview");

  // Still exactly five steps in the wizard view — Gemini added none.
  const view = onboarding.view();
  assert.deepEqual(Object.keys(view.steps).sort(), ["caps", "firstJob", "provider", "shield", "telegram"]);
  assert.equal(view.steps.provider.done, true);

  // The key VALUE appears in no state file (vault ciphertext only).
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((name) => {
      const p = join(d, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  for (const file of walk(dir)) {
    assert.ok(!readFileSync(file, "utf8").includes(FAKE_GEMINI_KEY), `gemini key leaked into ${file}`);
  }
});
