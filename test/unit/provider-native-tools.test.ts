/**
 * Native tool use (v0.14.4) — the provider layer's second channel.
 *
 * Why this exists (field, 2026-11-19): the self-build loop (Cycle 0)
 * ran three times against the default provider (openai/muse-spark-1.3)
 * and the model made ZERO tool calls — it answered the multi-step
 * task in prose on every hop, even after the v0.14.3 guard served
 * the exact bare-JSON skeleton twice. The transcript audit ruled
 * out the wiring (skeleton verbatim in the prompt) and the model
 * (the right one answered); the text protocol itself could not
 * elicit a call. Verified live against api.meta.ai the same day:
 * the same model answers a native `tools` request with a
 * structured tool_call on the first try, accepts assistant
 * tool_calls + tool-role continuation messages — with two hard
 * constraints these tests pin: function names may contain at most
 * ONE dot (multi-dot names are rejected with HTTP 400), and
 * tool_choice supports "auto" only.
 *
 * What is pinned here:
 *  - Native elicitation: a supplied conversation runs the native
 *    channel — real tool definitions (names mapped to the API's
 *    one-dot rule), tool_choice "auto", the native preamble on the
 *    first user message — and a structured tool_call comes back as
 *    the SAME ProviderReply shape the text protocol produces,
 *    canonical tool name and all.
 *  - Continuation: an executed call and its result serialize as an
 *    assistant tool_calls message paired with a tool-role message
 *    under the call's own id; a final text answer finalizes.
 *  - The guard on the native path, end to end (real ChannelHost +
 *    CommServer + Bridge Inbox + a REAL provider class over a
 *    scripted transport + the protocol-faithful fake runtime): a
 *    prose-only model on a task job is continued exactly twice and
 *    fails loudly with the guard's cause — never verified-done;
 *    a chat job's prose finalizes in one call.
 *  - The fallback is byte-for-byte: no conversation supplied (every
 *    non-loop caller) or a non-native provider → the request is
 *    the pre-v0.14.4 text-protocol request, tools field absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import type {
  ChannelAdapter,
  ControlMessage,
  OutboundMessage,
  RuntimeRequest,
} from "../../packages/shared/src/index.js";
import { VaultBroker } from "../../packages/vault/src/index.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";
import type { ShieldGate } from "../../packages/gate/src/index.js";
import {
  AnthropicProvider,
  NATIVE_TOOLS,
  OpenAiCompatibleProvider,
  nativeToolName,
  resolveProvider,
  writeProviderConfig,
  type NativeMessage,
  type ProviderTransport,
} from "../../packages/control-plane/src/providers.js";
import { BridgeInboxAdapter } from "../../packages/control-plane/src/bridge-inbox.js";
import { ChannelHost } from "../../packages/control-plane/src/channel-host.js";
import { Governor } from "../../packages/control-plane/src/governor.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { PolicyStore, DEFAULT_POLICY } from "../../packages/control-plane/src/policy.js";
import { ApprovalEngine } from "../../packages/control-plane/src/approvals.js";
import { CommServer, type HostHooks } from "../../packages/control-plane/src/comm-server.js";
import { FakeMacHostAdapter, MacService } from "../../packages/control-plane/src/mac.js";
import { loadGovernorMode } from "../../packages/control-plane/src/governor-mode.js";
import { Workspace, executeTool } from "../../packages/runtime/src/tools.js";
import {
  TaskGuard,
  taskGuardExhaustedFinalText,
  taskGuardExhaustedNote,
} from "../../packages/runtime/src/task-guard.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-native-"));
}

function tempVault(dir: string, ...keyNames: string[]): VaultBroker {
  const vault = new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key"));
  for (const name of keyNames) vault.add(name, `unit-test-${name}-key`);
  return vault;
}

interface SeenBody {
  messages: Record<string, unknown>[];
  tools?: { type: string; function: { name: string; description: string; parameters: unknown } }[];
  tool_choice?: unknown;
  model?: string;
  [k: string]: unknown;
}

function recordingTransport(
  respond: (body: SeenBody, call: number) => Record<string, unknown>,
  seen: SeenBody[],
): ProviderTransport {
  return async (_url, init) => {
    const body = JSON.parse(init.body ?? "{}") as SeenBody;
    seen.push(body);
    return { status: 200, json: async () => respond(body, seen.length) };
  };
}

function toolCallResponse(id: string, name: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "",
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 500, completion_tokens: 40 },
  };
}

function textResponse(text: string) {
  return {
    choices: [{ finish_reason: "stop", message: { content: text } }],
    usage: { prompt_tokens: 300, completion_tokens: 25 },
  };
}

function openAiProvider(dir: string, transport: ProviderTransport, nativeTools = true) {
  return new OpenAiCompatibleProvider(tempVault(dir, "openai"), {
    id: "openai",
    model: "muse-spark-1.3",
    baseUrl: "https://api.meta.ai/v1",
    keyName: "openai",
    keyRequired: true,
    who: "Meta",
    transport,
    nativeTools,
  });
}

// ------------------------------------------------------------ names

test("native names: at most one dot — multi-dot tails collapse, the rest pass through", () => {
  assert.equal(nativeToolName("mac.shell.run"), "mac.shell_run");
  assert.equal(nativeToolName("mac.fs.read"), "mac.fs_read");
  assert.equal(nativeToolName("mac.fs.write"), "mac.fs_write");
  assert.equal(nativeToolName("mac.picker.select"), "mac.picker_select");
  assert.equal(nativeToolName("mac.open_app"), "mac.open_app");
  assert.equal(nativeToolName("mac.observe"), "mac.observe");
  assert.equal(nativeToolName("workspace_write"), "workspace_write");
  assert.equal(nativeToolName("fetch"), "fetch");
  const mapped = NATIVE_TOOLS.map((t) => nativeToolName(t.tool));
  assert.equal(new Set(mapped).size, mapped.length, "the mapping is bijective over the tool set");
  assert.ok(mapped.every((n) => n.split(".").length <= 2), "no native name has more than one dot");
  assert.deepEqual(
    NATIVE_TOOLS.map((t) => t.tool),
    [
      "mac.observe", "mac.open_app", "mac.focus_window", "mac.click", "mac.type", "mac.key",
      "mac.scroll", "mac.fs.read", "mac.fs.write", "mac.shell.run", "mac.picker.select",
      "workspace_read", "workspace_write", "fetch", "github_publish_release", "memory_propose",
    ],
    "the native table is the TOOL_PROTOCOL tool set, in order",
  );
});

// ------------------------------------------------------ native path

test("native: a structured tool_call comes back as the canonical ProviderReply", async () => {
  const dir = freshDir();
  const seen: SeenBody[] = [];
  const provider = openAiProvider(
    dir,
    recordingTransport(
      () => toolCallResponse("call_1", "mac.shell_run", { command: "git status", cwd: "/Users/zeus/gus" }),
      seen,
    ),
  );
  const messages: NativeMessage[] = [{ role: "user", text: "Run git status in /Users/zeus/gus" }];
  const out = await provider.complete("Run git status in /Users/zeus/gus", { messages });
  assert.equal(out.reply.text, undefined);
  assert.equal(out.reply.toolCall?.tool, "mac.shell.run", "the API name maps back to the canonical tool");
  assert.deepEqual(out.reply.toolCall?.args, { command: "git status", cwd: "/Users/zeus/gus" });
  assert.equal(out.reply.toolCall?.declaredClass, "write");
  assert.equal(out.reply.toolCall?.id, "call_1", "the API's call id rides the reply for conversation pairing");
  assert.equal(out.tokensIn, 500);
  assert.equal(out.tokensOut, 40);

  const body = seen[0];
  assert.equal(body.tool_choice, "auto", "auto is the only tool_choice the default backend accepts");
  const names = (body.tools ?? []).map((t) => t.function.name);
  assert.ok(names.includes("mac.shell_run"), "definitions carry the mapped name");
  assert.ok(!names.includes("mac.shell.run"), "and never the two-dot name the API rejects");
  assert.equal(names.length, 16, "the whole fixed tool set is defined");
  const first = body.messages[0] as { role: string; content: string };
  assert.equal(first.role, "user");
  assert.ok(first.content.includes("tool-calling interface"), "the native preamble opens the conversation");
  assert.ok(first.content.endsWith("Run git status in /Users/zeus/gus"), "the job prompt closes the first message");
  assert.ok(!first.content.includes("reply with ONLY a JSON object"), "the text protocol's reply-shape instruction is absent");
});

test("native: an executed call and its result serialize as a tool_calls/tool pair under the call id", async () => {
  const dir = freshDir();
  const seen: SeenBody[] = [];
  const provider = openAiProvider(dir, recordingTransport(() => textResponse("Done — the tree is clean."), seen));
  const messages: NativeMessage[] = [
    { role: "user", text: "Run git status in /Users/zeus/gus" },
    { role: "assistant", toolCall: { id: "call_1", tool: "mac.shell.run", args: { command: "git status", cwd: "/Users/zeus/gus" } } },
    { role: "tool", toolCallId: "call_1", text: "shell ok: On branch main, nothing to commit" },
  ];
  const out = await provider.complete("TOOL_RESULT (text-path representation)", { messages });
  assert.equal(out.reply.text, "Done — the tree is clean.");
  const sent = seen[0].messages as Record<string, unknown>[];
  assert.equal(sent.length, 3);
  const assistant = sent[1] as {
    role: string;
    tool_calls: { id: string; function: { name: string; arguments: string } }[];
  };
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.tool_calls[0].id, "call_1");
  assert.equal(assistant.tool_calls[0].function.name, "mac.shell_run");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), {
    command: "git status",
    cwd: "/Users/zeus/gus",
  });
  const toolMsg = sent[2] as { role: string; tool_call_id: string; content: string };
  assert.equal(toolMsg.role, "tool");
  assert.equal(toolMsg.tool_call_id, "call_1", "the result pairs with the call under its own id");
  assert.ok(toolMsg.content.includes("nothing to commit"));
});

test("native: text content in the old bare-JSON form is still understood as a call", async () => {
  const dir = freshDir();
  const seen: SeenBody[] = [];
  const provider = openAiProvider(
    dir,
    recordingTransport(() => textResponse('{"tool": "workspace_read", "args": {"path": "notes.txt"}}'), seen),
  );
  const out = await provider.complete("read notes", {
    messages: [{ role: "user", text: "read notes" }],
  });
  assert.equal(out.reply.toolCall?.tool, "workspace_read");
  assert.equal(out.reply.toolCall?.declaredClass, "read");
});

test("native: a 200 with neither text nor tool_calls is retried once, like the text path", async () => {
  const dir = freshDir();
  const seen: SeenBody[] = [];
  const provider = openAiProvider(
    dir,
    recordingTransport((_body, call) =>
      call === 1
        ? { choices: [{ message: {} }], usage: { prompt_tokens: 10, completion_tokens: 0 } }
        : toolCallResponse("call_9", "workspace_write", { path: "a.txt", content: "x" }),
      seen,
    ),
  );
  const out = await provider.complete("write a.txt", { messages: [{ role: "user", text: "write a.txt" }] });
  assert.equal(seen.length, 2, "one retry after the empty attempt");
  assert.equal(out.reply.toolCall?.tool, "workspace_write");
  assert.equal(out.tokensIn, 510, "usage sums across both attempts");
});

test("native (anthropic): a tool_use block maps to the canonical reply; results serialize as tool_result", async () => {
  const dir = freshDir();
  const seen: SeenBody[] = [];
  const transport: ProviderTransport = async (_url, init) => {
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    seen.push(body as SeenBody);
    return {
      status: 200,
      json: async () => ({
        content: [{ type: "tool_use", id: "toolu_1", name: "mac.fs_read", input: { path: "/x/README.md" } }],
        usage: { input_tokens: 90, output_tokens: 12 },
      }),
    };
  };
  const provider = new AnthropicProvider(tempVault(dir, "anthropic"), "claude-sonnet-5", { transport });
  assert.equal(provider.nativeTools, true, "anthropic declares native by default");
  const messages: NativeMessage[] = [
    { role: "user", text: "read the readme" },
    { role: "assistant", toolCall: { id: "toolu_0", tool: "mac.observe", args: {} } },
    { role: "tool", toolCallId: "toolu_0", text: "front app: Finder" },
  ];
  const out = await provider.complete("read the readme", { messages });
  assert.equal(out.reply.toolCall?.tool, "mac.fs.read");
  assert.equal(out.reply.toolCall?.declaredClass, "read");
  assert.deepEqual(out.reply.toolCall?.args, { path: "/x/README.md" });
  assert.equal(out.reply.toolCall?.id, "toolu_1");
  const body = seen[0] as unknown as {
    tools: { name: string; input_schema: unknown }[];
    tool_choice: unknown;
    messages: Record<string, unknown>[];
  };
  assert.equal(body.tools.length, 16);
  assert.ok(body.tools.every((t) => t.input_schema), "definitions carry input_schema");
  assert.deepEqual(body.tool_choice, { type: "auto" });
  const toolResultMsg = body.messages[2] as { role: string; content: { type: string; tool_use_id: string }[] };
  assert.equal(toolResultMsg.role, "user");
  assert.equal(toolResultMsg.content[0].type, "tool_result");
  assert.equal(toolResultMsg.content[0].tool_use_id, "toolu_0");
});

// --------------------------------------------------------- fallback

test("fallback: no conversation supplied — the request is the text protocol, byte for byte", async () => {
  const dir = freshDir();
  const seen: SeenBody[] = [];
  const provider = openAiProvider(
    dir,
    recordingTransport(() => textResponse("ok"), seen),
  );
  await provider.complete("Open Calculator");
  const body = seen[0];
  assert.equal(body.tools, undefined, "no tools field rides a text-protocol request");
  assert.equal(body.tool_choice, undefined);
  assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model"]);
  const content = (body.messages[0] as { content: string }).content;
  assert.ok(content.startsWith("You are GUS, a secure AI agent"), "the TOOL_PROTOCOL opens the message");
  assert.ok(content.includes('{"tool": "<tool name>", "args": { ... }}'), "the bare-JSON shape is instructed");
  assert.ok(content.endsWith("Open Calculator"));
});

test("fallback: a non-native provider ignores a supplied conversation entirely", async () => {
  const dir = freshDir();
  const seen: SeenBody[] = [];
  const provider = new OpenAiCompatibleProvider(tempVault(dir, "ollama"), {
    id: "ollama",
    model: "llama3.1:8b",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyName: "ollama",
    keyRequired: false,
    who: "Ollama",
    transport: recordingTransport(() => textResponse("local answer"), seen),
    nativeTools: false,
  });
  const out = await provider.complete("hello", { messages: [{ role: "user", text: "hello" }] });
  assert.equal(out.reply.text, "local answer");
  assert.equal(seen[0].tools, undefined, "no native channel for a non-native provider");
  assert.ok((seen[0].messages[0] as { content: string }).content.endsWith("hello"));
});

test("factory: native defaults per class, operator config override wins", () => {
  const dir = freshDir();
  const vault = tempVault(dir, "openai", "anthropic", "ollama", "gemini");
  writeProviderConfig(dir, { provider: "openai", model: "muse-spark-1.3", baseUrl: "https://api.meta.ai/v1" });
  assert.equal(resolveProvider(dir, vault).nativeTools, true, "the default path is native");
  writeProviderConfig(dir, { provider: "openai", model: "muse-spark-1.3", nativeTools: false });
  assert.equal(resolveProvider(dir, vault).nativeTools, false, "an explicit pin to the text protocol is honored");
  writeProviderConfig(dir, { provider: "ollama", model: "llama3.1:8b" });
  assert.equal(resolveProvider(dir, vault).nativeTools, false, "ollama defaults to the text protocol");
  writeProviderConfig(dir, { provider: "ollama", model: "llama3.1:8b", nativeTools: true });
  assert.equal(resolveProvider(dir, vault).nativeTools, true, "and the operator can enable it per install");
  writeProviderConfig(dir, { provider: "anthropic", model: "claude-sonnet-5" });
  assert.equal(resolveProvider(dir, vault).nativeTools, true, "anthropic defaults native");
  writeProviderConfig(dir, { provider: "gemini", model: "gemini-3.5-flash" });
  assert.equal(resolveProvider(dir, vault).nativeTools, true, "gemini defaults native");
});

// ------------------------------------------------------------ e2e rig
//
// The whole pipeline, wired the way main.ts wires it (the same rig
// shape as bridge-task.test.ts): Bridge Inbox → ChannelHost →
// CommServer → (socket) → a protocol-faithful fake runtime running
// the REAL TaskGuard and the REAL tool executors. The difference:
// the provider is a REAL OpenAiCompatibleProvider (native on) over
// a scripted transport playing the model's part at the HTTP layer,
// so what is exercised is the actual native request/response
// handling and the comm server's conversation state machine — not
// a scripted ProviderReply.

const GROUP = "-100999";
const OPERATOR = "111";
const NOVA = "222";

function delegatesJson(): string {
  return JSON.stringify({
    conversations: {
      [GROUP]: { operatorId: OPERATOR, delegates: [{ senderId: NOVA, name: "Nova" }] },
    },
    bridge: { conversationId: GROUP, senderId: NOVA },
  });
}

class RecordingAdapter implements ChannelAdapter {
  readonly name = "telegram";
  sent: OutboundMessage[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }
}

const FAKE_SHIELD_RECEIPT = "rcpt_fake_native";

function fakeShieldGate(): ShieldGate {
  return {
    scanSurface: async () => ({
      action: "allow" as const,
      scanned: true,
      verdict: "clean",
      receipt: { receiptId: FAKE_SHIELD_RECEIPT } as never,
      detail: "fake gate allow",
    }),
  } as unknown as ShieldGate;
}

class FakeRuntime {
  private sock?: Socket;
  private buf = "";
  private seq = 0;
  private waiters = new Map<string, (m: ControlMessage) => void>();
  readonly ws: Workspace;

  constructor(
    private socketPath: string,
    workspaceRoot: string,
  ) {
    this.ws = new Workspace(workspaceRoot);
  }

  async connect(): Promise<void> {
    this.sock = createConnection(this.socketPath);
    await new Promise<void>((resolve) => this.sock!.once("connect", resolve));
    this.sock.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      let idx;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (line.trim()) this.onMessage(JSON.parse(line) as ControlMessage);
      }
    });
    this.send({ t: "hello", runtimeVersion: "test" });
  }

  close(): void {
    this.sock?.destroy();
  }

  private send(req: RuntimeRequest): void {
    this.sock?.write(JSON.stringify(req) + "\n");
  }

  private request<T extends ControlMessage>(
    req: RuntimeRequest,
    match: (m: ControlMessage) => boolean,
  ): Promise<T> {
    return new Promise((resolvePromise) => {
      const key = `w${++this.seq}`;
      this.waiters.set(key, (m) => {
        if (match(m)) {
          this.waiters.delete(key);
          resolvePromise(m as T);
        }
      });
      this.send(req);
    });
  }

  private onMessage(m: ControlMessage): void {
    for (const w of [...this.waiters.values()]) w(m);
    if (m.t === "user_message") {
      void this.runTurn(m.jobId, m.text, m.kind);
    } else if (m.t === "verify") {
      try {
        if (m.check.tool === "workspace_read") {
          const digest = this.ws.digest(String(m.check.args.path));
          this.send({ t: "verify_result", reqId: m.reqId, ok: true, digest });
        } else if (m.check.tool === "workspace_absent") {
          const paths = Array.isArray(m.check.args.paths) ? m.check.args.paths.map(String) : [];
          const absent = paths.every((p) => !this.ws.exists(p));
          this.send({ t: "verify_result", reqId: m.reqId, ok: absent, note: absent ? "all absent" : "some present" });
        } else {
          this.send({ t: "verify_result", reqId: m.reqId, ok: false, note: `no checker for ${m.check.tool}` });
        }
      } catch (e) {
        this.send({ t: "verify_result", reqId: m.reqId, ok: false, note: String(e) });
      }
    }
  }

  /** driveLoop mirrored from packages/runtime/src/main.ts, task
   *  guard included (the REAL TaskGuard, as in bridge-task). */
  private async runTurn(jobId: string, text: string, kind = ""): Promise<void> {
    const signal = { aborted: false };
    const guard = TaskGuard.forJob(kind);
    let prompt = text;
    for (let hop = 0; hop < 100; hop++) {
      const res = await this.request<Extract<ControlMessage, { t: "model_response" }>>(
        { t: "model_request", reqId: `mr${++this.seq}`, jobId, workClass: "primary", prompt },
        (m) => m.t === "model_response",
      );
      if (!res.ok) {
        this.send({ t: "job_final", jobId, text: `I couldn't complete that: ${res.detail ?? "provider error"}` });
        return;
      }
      if (res.toolCall) {
        const tc = res.toolCall;
        const auth = await this.request<Extract<ControlMessage, { t: "tool_result" }>>(
          { t: "tool_call", reqId: `tc${++this.seq}`, jobId, tool: tc.tool, declaredClass: tc.declaredClass, args: tc.args },
          (m) => m.t === "tool_result",
        );
        if (auth.status === "denied") {
          this.send({ t: "job_final", jobId, text: `Denied by the control plane: ${auth.note ?? "the action was refused"}` });
          return;
        }
        if (auth.status !== "authorized") return; // parked
        let outcome: { ok: boolean; summary: string };
        if (auth.result) {
          outcome = auth.result;
        } else {
          try {
            outcome = await executeTool(this.ws, tc.tool, tc.args, signal, () => {});
          } catch (e) {
            outcome = { ok: false, summary: `tool error: ${e instanceof Error ? e.message : String(e)}` };
          }
        }
        this.send({ t: "tool_report", reqId: `tr${++this.seq}`, jobId, ok: outcome.ok, summary: outcome.summary });
        guard.noteToolExecuted();
        prompt =
          `TOOL_RESULT ${tc.tool}: ${outcome.summary}\n` +
          `(The operator's original request was: "${text}". Continue it, or reply with plain text to finish.)`;
        continue;
      }
      if (res.text !== undefined) {
        const verdict = guard.onTextReply();
        if (verdict === "continue") {
          prompt = guard.continuationPrompt(text);
          continue;
        }
        if (verdict === "exhausted") {
          this.send({ t: "job_update", jobId, note: taskGuardExhaustedNote() });
          this.send({ t: "job_final", jobId, text: taskGuardExhaustedFinalText() });
          return;
        }
        this.send({ t: "job_final", jobId, text: res.text });
        return;
      }
    }
  }
}

interface NativeStackRig {
  dir: string;
  work: string;
  jobs: JobRunner;
  bodies: SeenBody[];
  primary: RecordingAdapter;
  drop(name: string, body: unknown): void;
  close(): Promise<void>;
}

async function nativeStackRig(
  respond: (body: SeenBody, call: number) => Record<string, unknown>,
): Promise<NativeStackRig> {
  const dir = mkdtempSync(join(tmpdir(), "gus-native-stack-"));
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(dir, "delegates.json"), delegatesJson());
  writeFileSync(
    join(dir, "policy.json"),
    JSON.stringify({ ...DEFAULT_POLICY, mac: { workDirs: [work], shellAllowlist: ["echo"] } }),
  );
  const governor = new Governor(dir, {
    maxTokensPerJob: 1_000_000,
    maxTokensPerDay: 10_000_000,
    defaultPriceUsdPer1k: 0.01,
  });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const approvals = new ApprovalEngine(dir, () => 10 * 60 * 1000);
  const policy = new PolicyStore(join(dir, "policy.json"));
  const macAdapter = new FakeMacHostAdapter();
  const mac = new MacService(macAdapter, { workDirs: () => [work] });
  const gate = fakeShieldGate();

  const primary = new RecordingAdapter();
  const bridge = new BridgeInboxAdapter(dir, {
    sendVia: async (m) => void primary.sent.push(m),
    pollMs: 25,
  });

  const bodies: SeenBody[] = [];
  const provider = openAiProvider(dir, recordingTransport(respond, bodies));

  const host = new ChannelHost(dir, governor, jobs, [bridge, primary], approvals, gate);
  const socketPath = join(dir, "gus.sock");
  const hooks: HostHooks = {
    onRuntimeHello: () => host.onRuntimeHello(),
    onModelIssued: (jobId, text) => host.onModelIssued(jobId, text),
    onModelRefused: (jobId, detail) => host.onModelRefused(jobId, detail),
    noteAuthorizedWrite: (jobId, path, content) => host.noteAuthorizedWrite(jobId, path, content),
    onApprovalRequested: (req) => host.onApprovalRequested(req),
    noteApprovedExecution: (jobId, tool, args) => host.noteApprovedExecution(jobId, tool, args),
    onDenied: (jobId, tool, note) => host.onDenied(jobId, tool, note),
    onCapExceeded: (jobId, detail) => host.onCapExceeded(jobId, detail),
    onJobUpdate: (jobId, note) => host.onJobUpdate(jobId, note),
    onJobFinal: (jobId, text) => host.onJobFinal(jobId, text),
    onPermissiveAction: (jobId, detail) => host.onPermissiveAction(jobId, detail),
    logRuntime: () => {},
  };
  const comm = new CommServer(
    socketPath,
    governor,
    jobs,
    hooks,
    policy,
    approvals,
    undefined,
    gate,
    () => provider,
    undefined,
    mac,
    () => loadGovernorMode(dir),
    undefined,
  );
  host.attachComm(comm);
  await comm.start();
  const runtime = new FakeRuntime(socketPath, work);
  await runtime.connect();
  await host.start();

  return {
    dir,
    work,
    jobs,
    bodies,
    primary,
    drop(name, body) {
      writeFileSync(join(dir, "bridge-inbox", name), JSON.stringify(body));
    },
    async close() {
      runtime.close();
      await bridge.stop();
      await comm.close();
      approvals.stop();
    },
  };
}

async function until<T>(fn: () => T | undefined, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function settledJob(r: NativeStackRig) {
  const j = r.jobs.list(10)[0];
  return j && (j.state === "verified-done" || j.state === "failed-loudly") ? j : undefined;
}

// ------------------------------------------------------------ e2e

test("e2e native: a task job's structured call executes through the real path and settles verified-done", async () => {
  const FINAL = "Done — the result file is written via a native tool call.";
  const r = await nativeStackRig((body) => {
    const msgs = body.messages as Record<string, unknown>[];
    if (msgs.some((m) => m.role === "tool")) return textResponse(FINAL);
    return toolCallResponse("call_w1", "workspace_write", {
      path: "out/result.txt",
      content: "native tools live\n",
    });
  });
  try {
    const deliverable = join(r.work, "out/result.txt");
    r.drop("1700000000000-task.json", {
      id: "cycle-native-1",
      text: "Produce the result file in the workdir.",
      kind: "task",
      deliverables: [deliverable],
    });
    const job = await until(() => settledJob(r), "the native task job to settle");
    assert.equal(job.state, "verified-done", `outcome: ${job.outcomeNote}`);
    assert.equal(readFileSync(deliverable, "utf8"), "native tools live\n", "the structured call executed for real");
    assert.equal(r.bodies.length, 2, "two model calls: the tool call and the final");

    const first = r.bodies[0];
    assert.equal(first.tool_choice, "auto");
    const names = (first.tools ?? []).map((t) => t.function.name);
    assert.ok(names.includes("mac.shell_run") && !names.includes("mac.shell.run"), "mapped names on the wire");

    const second = r.bodies[1].messages as Record<string, unknown>[];
    assert.equal(second.length, 3, "user, assistant call, tool result");
    const assistant = second[1] as {
      tool_calls: { id: string; function: { name: string } }[];
    };
    assert.equal(assistant.tool_calls[0].id, "call_w1");
    assert.equal(assistant.tool_calls[0].function.name, "workspace_write");
    const toolMsg = second[2] as { role: string; tool_call_id: string; content: string };
    assert.equal(toolMsg.role, "tool", "the result came back as a tool-role message");
    assert.equal(toolMsg.tool_call_id, "call_w1");
    assert.ok(toolMsg.content.length > 0, "the tool outcome rides the tool message");
  } finally {
    await r.close();
  }
});

test("e2e native: a prose-only model on a task job is guard-continued twice, then fails loudly", async () => {
  const r = await nativeStackRig(() => textResponse("I will get right on that."));
  try {
    r.drop("1700000000000-task.json", {
      id: "cycle-native-guard",
      text: "Carry out the checklist in the workdir.",
      kind: "task",
    });
    const job = await until(() => settledJob(r), "the prose-only native task job to settle");
    assert.equal(job.state, "failed-loudly", "a task job that did no work must never settle verified-done");
    assert.equal(job.outcomeNote, "task job produced no tool calls after 2 continuations");
    assert.equal(r.bodies.length, 3, "exactly the initial call plus 2 continuations");
    for (const i of [1, 2]) {
      const msgs = r.bodies[i].messages as { role: string; content?: string }[];
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      assert.ok(
        (lastUser?.content ?? "").includes("You have not called any tool yet"),
        `continuation ${i} rides the native conversation as a user message`,
      );
      const assistantTexts = msgs.filter((m) => m.role === "assistant");
      assert.ok(assistantTexts.length >= 1, "the model's prose is kept as assistant messages");
    }
    assert.ok(
      r.primary.sent.some((m) => m.text.includes("never called a tool")),
      "the operator hears the real reason",
    );
  } finally {
    await r.close();
  }
});

test("e2e native: a chat job's prose answer finalizes in exactly one call — the guard does not apply", async () => {
  const r = await nativeStackRig(() => textResponse("Just an answer, no work needed."));
  try {
    r.drop("1700000000000-chat.json", {
      id: "cycle-native-chat",
      text: "Quick question: what is the status?",
    });
    const job = await until(() => settledJob(r), "the native chat job to settle");
    assert.equal(job.kind, "chat");
    assert.equal(job.state, "verified-done", `outcome: ${job.outcomeNote}`);
    assert.equal(r.bodies.length, 1, "one model call, no continuation — exactly the pre-guard behavior");
  } finally {
    await r.close();
  }
});
