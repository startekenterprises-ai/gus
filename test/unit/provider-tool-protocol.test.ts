/**
 * Phase 9: real-model tool use + provider-refusal honesty.
 *
 * Field findings (2026-11-05, first real Mac install):
 *  - With a real provider configured, GUS could chat but never act:
 *    the remote providers returned text only, so the model — never
 *    shown a tool or a call format — answered "Open Calculator" with
 *    generic advice. The tool protocol now rides the prompt, and a
 *    bare-JSON reply is parsed into a tool call.
 *  - A Gemini HTTP 503 failed a job, and the operator was told it
 *    "failed its verification check" — the refusal produced no model
 *    output, so the output-hash post-condition could never match.
 *    The comm server now reports refusals (onModelRefused) and the
 *    host settles the job with the provider's reason in the notice.
 *  - Transient 429/503 responses are retried with backoff inside the
 *    provider call, before any refusal reaches a job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelAdapter, OutboundMessage } from "../../packages/shared/src/index.js";
import { VaultBroker } from "../../packages/vault/src/index.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";
import { GeminiProvider, type ProviderTransport } from "../../packages/control-plane/src/providers.js";
import { ChannelHost } from "../../packages/control-plane/src/channel-host.js";
import { Governor } from "../../packages/control-plane/src/governor.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-phase9-"));
}

function tempVault(dir: string): VaultBroker {
  const vault = new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key"));
  vault.add("gemini", "AIza-unit-test-key");
  return vault;
}

function chatTransport(content: string, seen?: { body?: string }[]): ProviderTransport {
  return async (_url, init) => {
    seen?.push({ body: init.body });
    return {
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    };
  };
}

test("tool protocol: a bare-JSON reply becomes a tool call, and the prompt carries the protocol", async () => {
  const dir = freshDir();
  const seen: { body?: string }[] = [];
  const gemini = new GeminiProvider(tempVault(dir), "gemini-3.5-flash", {
    transport: chatTransport('{"tool": "mac.open_app", "args": {"app": "Calculator"}}', seen),
  });
  const out = await gemini.complete("Open Calculator");
  assert.equal(out.reply.text, undefined);
  assert.equal(out.reply.toolCall?.tool, "mac.open_app");
  assert.deepEqual(out.reply.toolCall?.args, { app: "Calculator" });
  assert.equal(out.reply.toolCall?.declaredClass, "write");
  const sent = JSON.parse(seen[0].body ?? "{}") as { messages: { content: string }[] };
  assert.ok(sent.messages[0].content.includes("mac.open_app"), "protocol names the tools");
  assert.ok(sent.messages[0].content.endsWith("Open Calculator"), "operator prompt closes the message");
});

test("tool protocol: fenced JSON parses; read tools carry a read floor; plain text stays text", async () => {
  const dir = freshDir();
  const fenced = new GeminiProvider(tempVault(dir), "gemini-3.5-flash", {
    transport: chatTransport('```json\n{"tool": "mac.fs.read", "args": {"path": "/Users/zeus/gus/README.md"}}\n```'),
  });
  const readOut = await fenced.complete("read the readme");
  assert.equal(readOut.reply.toolCall?.tool, "mac.fs.read");
  assert.equal(readOut.reply.toolCall?.declaredClass, "read");

  const plain = new GeminiProvider(tempVault(dir), "gemini-3.5-flash", {
    transport: chatTransport("Done — Calculator is open."),
  });
  const textOut = await plain.complete("Open Calculator");
  assert.equal(textOut.reply.text, "Done — Calculator is open.");
  assert.equal(textOut.reply.toolCall, undefined);
});

test("provider retry: a 503 is retried and the call succeeds", async () => {
  const dir = freshDir();
  let calls = 0;
  const transport: ProviderTransport = async () => {
    calls++;
    if (calls === 1) return { status: 503, json: async () => ({}) };
    return {
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "recovered" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    };
  };
  const gemini = new GeminiProvider(tempVault(dir), "gemini-3.5-flash", { transport });
  const started = Date.now();
  const out = await gemini.complete("hi");
  assert.equal(out.reply.text, "recovered");
  assert.equal(calls, 2, "one retry after the 503");
  assert.ok(Date.now() - started >= 900, "the retry waited for the backoff");
});

class RecordingAdapter implements ChannelAdapter {
  readonly name = "telegram";
  sent: OutboundMessage[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }
}

test("provider refusal: the operator hears the provider's reason, not a verification failure", async () => {
  const dir = freshDir();
  const governor = new Governor(dir, { maxTokensPerJob: 100, maxTokensPerDay: 10_000 });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const adapter = new RecordingAdapter();
  const host = new ChannelHost(dir, governor, jobs, [adapter]);
  const job = jobs.create("chat", "424242", "Open Calculator");
  jobs.transition(job.id, "running");
  host.onModelRefused(job.id, "Gemini refused the call (HTTP 503) — check the provider key and model in Setup");
  await host.onJobFinal(job.id, "I couldn't complete that: Gemini refused the call (HTTP 503) — check the provider key and model in Setup");
  const settled = jobs.get(job.id);
  assert.equal(settled?.state, "failed-loudly");
  assert.match(settled?.outcomeNote ?? "", /provider refused the model call/);
  assert.equal(adapter.sent.length, 1);
  assert.ok(adapter.sent[0].text.includes("Gemini refused the call (HTTP 503)"), "notice names the real reason");
  assert.ok(!adapter.sent[0].text.includes("verification"), "notice is not the verification template");
});
