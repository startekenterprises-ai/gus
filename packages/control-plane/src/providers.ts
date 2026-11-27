/**
 * Provider classes (foundation spec §2.1) — Phase 4.
 *
 * Provider classes behind the interface the CommServer meters:
 * Anthropic (primary), OpenAI (secondary), Gemini (Google's
 * OpenAI-compatible endpoint), and Ollama — the local,
 * OpenAI-compatible endpoint — plus the "starter gateway" class (an
 * OpenAI-compatible StarTek gateway, when configured) and the Phase 0
 * deterministic stub, which remains the drill/offline provider.
 *
 * Rules that do not bend:
 *   - Keys come from the Vault Broker, by NAME, at call time, inside a
 *     withSecret callback. No provider holds a key between calls; no
 *     key appears in config files, errors, or logs.
 *   - Every class reports its model under a Governor price-table key
 *     ("anthropic/<model>", "openai/<model>", "ollama/<model>"…), so
 *     caps and the ledger price real calls exactly like stub calls.
 *     Ollama/local is $0 unless the operator prices it.
 *   - Tool use (Phase 9): real providers speak the prompt-carried
 *     tool protocol (TOOL_PROTOCOL below) — the model calls a tool by
 *     replying with a bare JSON object, and parseToolReply maps it
 *     onto GUS's fixed tool set with the declared class as a floor.
 *     Every call still crosses the classifier, the Shield gate, and
 *     the Governor exactly like a stub call. A reply with no text is
 *     a provider error, never a silent empty success.
 *   - Native tool use (v0.14.4): a provider whose API supports it
 *     also answers through the API's own tool-calling channel when
 *     the comm server's job loop supplies a structured conversation
 *     (complete's opts.messages): real JSON-Schema tool definitions
 *     ride the request, structured tool_calls come back, and tool
 *     results return as tool-role messages. The field evidence that
 *     forced this: the text protocol alone drew ZERO tool calls from
 *     the default model (openai/muse-spark-1.3) across three
 *     attempts at the self-build loop (Cycle 0, 2026-11-19) — with
 *     the wiring and the model both verified correct — while the
 *     same model answers a native tools request with a structured
 *     call on the first try (verified live against api.meta.ai the
 *     same day). Providers without native support, and every
 *     non-loop caller (the approver path passes no conversation),
 *     keep the text protocol byte for byte. Either way the parsed
 *     result is the same ProviderReply: the classifier remains the
 *     real authority and the declared class is still only a floor.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import type { MessageImage, ToolClass } from "@gus/shared";
import type { VaultBroker } from "@gus/vault";
import {
  estimateTokens,
  fakeComplete,
  FAKE_MODEL_NAME,
  type ProviderReply,
} from "./provider.js";

export type ProviderId = "stub" | "anthropic" | "openai" | "gemini" | "ollama" | "gateway";

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  /** OpenAI-compatible base (ollama/gateway); Anthropic base override. */
  baseUrl?: string;
  /** Output budget per call — the Governor reserves against this. */
  maxTokens?: number;
  /** v0.14.4: native tool-calling override. Absent = the provider
   *  class's own default (on for anthropic/openai/gemini, off for
   *  ollama/gateway, whose backends vary); an explicit value wins,
   *  so an operator can enable a tool-capable local model — or pin
   *  the text protocol — per install. */
  nativeTools?: boolean;
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  provider: "stub",
  model: "stub-v0",
};

export const DEFAULT_MAX_TOKENS = 1024;

/** Suggested starter models per class (onboarding pre-fills these;
 *  the operator can change them — config is theirs). */
export const SUGGESTED_MODELS: Record<Exclude<ProviderId, "stub">, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5-mini",
  gemini: "gemini-3.5-flash",
  ollama: "llama3.1:8b",
  gateway: "llama3.1:8b",
};

/** Google's OpenAI-compatible Gemini endpoint. The Gemini provider
 *  PINNED to this host: unlike the generic classes, its base URL is
 *  not operator-overridable, so the vault key can only ever be
 *  injected on calls to generativelanguage.googleapis.com. */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/** Gemini models the wizard offers out of the box (the operator can
 *  put any Gemini model id in provider.json — config is theirs). */
export const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-3-flash-preview"] as const;

export interface ProviderCompletion {
  reply: ProviderReply;
  tokensIn: number;
  tokensOut: number;
}

export interface Provider {
  readonly id: ProviderId;
  readonly model: string;
  /** Governor price-table key. */
  readonly modelKey: string;
  readonly maxTokensOut: number;
  /** "stub" completions are deterministic and free to pre-compute (the
   *  CommServer's exact-estimate path); "remote" completions spend. */
  readonly kind: "stub" | "remote";
  /** v0.14.4: this provider can answer through its API's native
   *  tool-calling channel when the comm server supplies a structured
   *  conversation (opts.messages). Absent/false = the prompt-carried
   *  text protocol is its only tool channel. Declared per class (and
   *  per install, via provider.json) — never probed silently, and
   *  the default provider path (openai) declares it. */
  readonly nativeTools?: boolean;
  /** v0.9.8: opts.maxTokensOut clamps THIS call's reply budget
   *  below the provider's configured maxTokensOut (the voice fast
   *  lane's spoken-reply budget). Absent = the configured budget,
   *  exactly as before. The Governor reservation for the call is
   *  made against the same clamped number (comm-server).
   *  v0.14.4: opts.messages, when present AND this provider is
   *  native-capable, runs the call on the native tool-calling
   *  channel instead of the text protocol. Only the comm server's
   *  job loop supplies it; every other caller gets the text
   *  protocol exactly as before.
   *  v0.24.0: opts.images carries a job's attached photos on the
   *  TEXT channel (the native channel carries them inside its
   *  messages instead). Remote providers present them to the
   *  model as image input alongside the prompt; the stub ignores
   *  them — it is a fixed text script and cannot see. */
  complete(
    prompt: string,
    opts?: { maxTokensOut?: number; messages?: NativeMessage[]; images?: MessageImage[] },
  ): Promise<ProviderCompletion>;
}

export type ProviderTransportResponse = {
  status: number;
  json: () => Promise<unknown>;
};

export type ProviderTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<ProviderTransportResponse>;

const defaultTransport: ProviderTransport = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, json: async () => res.json().catch(() => null) };
};

// ---------------------------------------------------------------- config

function configPath(stateDir: string): string {
  return `${stateDir}/provider.json`;
}

/** Active provider config, re-read per call (operator edits are live,
 *  like governor.json and policy.json). Missing/malformed = the stub —
 *  the offline-safe default every pre-Phase-4 drill relies on. */
export function loadProviderConfig(stateDir: string): ProviderConfig {
  try {
    if (existsSync(configPath(stateDir))) {
      const raw = JSON.parse(readFileSync(configPath(stateDir), "utf8")) as Partial<ProviderConfig>;
      const ids: ProviderId[] = ["stub", "anthropic", "openai", "gemini", "ollama", "gateway"];
      if (raw.provider && ids.includes(raw.provider) && typeof raw.model === "string" && raw.model) {
        return {
          provider: raw.provider,
          model: raw.model,
          baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
          maxTokens:
            typeof raw.maxTokens === "number" && raw.maxTokens > 0 ? raw.maxTokens : undefined,
          nativeTools: typeof raw.nativeTools === "boolean" ? raw.nativeTools : undefined,
        };
      }
    }
  } catch {
    /* malformed operator config: fall back to the stub, never to a
       half-configured remote provider */
  }
  return { ...DEFAULT_PROVIDER_CONFIG };
}

/** Operator-surface write (onboarding). Contains NO secret material —
 *  keys live in the vault; this file names only provider + model. */
export function writeProviderConfig(stateDir: string, cfg: ProviderConfig): void {
  writeFileSync(configPath(stateDir), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath(stateDir), 0o600);
}

// ---------------------------------------------------------------- stub

export class StubProvider implements Provider {
  readonly id = "stub" as const;
  readonly model = "stub-v0";
  readonly modelKey = FAKE_MODEL_NAME;
  readonly maxTokensOut = 0;
  readonly kind = "stub" as const;

  async complete(
    prompt: string,
    _opts?: { maxTokensOut?: number; messages?: NativeMessage[]; images?: MessageImage[] },
  ): Promise<ProviderCompletion> {
    // The stub's replies are fixed scripts; a reply budget has
    // nothing to clamp (the CommServer's stub path never passes
    // one — its estimates are exact by construction). The stub is
    // never native-capable: it declares no nativeTools, so the comm
    // server never supplies it a conversation. v0.24.0: images are
    // accepted and ignored — a fixed text script cannot see.
    const reply = fakeComplete(prompt);
    return {
      reply,
      tokensIn: estimateTokens(prompt),
      tokensOut: estimateTokens(reply.text ?? JSON.stringify(reply.toolCall ?? {})),
    };
  }
}

/** The CommServer's exact-estimate path for the stub: the reply is
 *  deterministic, so its true token counts are computable BEFORE
 *  authorization — reservation == settlement, by construction. */
export function stubCompletion(prompt: string): ProviderCompletion {
  const reply = fakeComplete(prompt);
  return {
    reply,
    tokensIn: estimateTokens(prompt),
    tokensOut: estimateTokens(reply.text ?? JSON.stringify(reply.toolCall ?? {})),
  };
}

// ---------------------------------------------------------------- remote

/** The prompt-carried tool protocol presented to every real model
 *  (Phase 9). One tool per reply, as a bare JSON object; plain text
 *  finishes the task. The arg shapes mirror the executors exactly
 *  (mac.ts, the comm server's workspace/fetch handlers) — a mismatch
 *  here makes real models guess, so keep the two in step. */
const TOOL_PROTOCOL = `You are GUS, a secure AI agent running on the operator's own computer. The operator talks to you through a chat channel and asks you to do tasks on this machine. You act by calling tools, one at a time.

To call a tool, reply with ONLY a JSON object in exactly this shape, and nothing else — no prose, no markdown:
{"tool": "<tool name>", "args": { ... }}

When the task is done, or to answer a question, reply with plain text (no JSON). Plain text ends the task, so do not answer in plain text until the work is actually done.

Available tools (args in braces):
- mac.observe {} — look at the screen: returns the front app, its windows, and the visible controls. Call this before clicking or typing when you need the current state.
- mac.open_app {"app": "Calculator"} — open an application by name.
- mac.focus_window {"app": "Calculator", "title": "optional window title"} — focus a window.
- mac.click {"element": "a control label from mac.observe"} OR {"x": 120, "y": 340} — click a control or a point.
- mac.type {"text": "..."} — type text into the focused control.
- mac.key {"combo": "cmd+s"} — press a key or shortcut.
- mac.scroll {"direction": "down", "amount": 3} — scroll the front window.
- mac.fs.read {"path": "/absolute/path"} — read a file (approved folders only).
- mac.fs.write {"path": "/absolute/path", "content": "..."} — write a file (approved folders only).
- mac.shell.run {"command": "git status", "cwd": "/absolute/dir"} — run a shell command; cwd defaults to an approved folder.
- mac.picker.select {"path": "/absolute/path"} — choose a file in an open file picker.
- workspace_read {"path": "relative/path"} — read a file in your sandbox workspace.
- workspace_write {"path": "relative/path", "content": "..."} — write a file in your sandbox workspace.
- fetch {"url": "https://...", "method": "GET"} — fetch a web page (via the egress proxy).
- github_publish_release {"tag": "v0.9.5", "dmgPath": "/absolute/path/GUS-0.9.5.dmg", "shaPath": "/absolute/path/GUS-0.9.5.dmg.sha256"} — publish a GUS release: upload the named DMG + checksum to the existing draft GitHub release for that tag and publish it. The control plane performs it with the vaulted publish token; the checksum is verified against the DMG before anything uploads. To publish the iOS pair to the same release instead, name "ipaPath": "/absolute/path/GUS-0.9.5.ipa" with the .ipa's own .sha256 as shaPath. Name exactly ONE artifact per call (dmgPath or ipaPath, never both).
- memory_propose {"category": "fact", "text": "...", "source": "where this came from, one line"} — propose a durable memory for the operator's curated context (category: fact, decision, preference, identity, or project). It ONLY records a candidate: the operator reviews candidates and promotes the ones that become memory — a proposal is never memory by itself. Never put secrets or credentials in a proposal. At most 3 proposals per job.

Rules:
- Some actions need the operator's approval. The system asks them automatically when your call requires it — never ask for permission in your text, and never describe an action as done until a TOOL_RESULT confirms it.
- After each tool call you receive a TOOL_RESULT line with the outcome. Use it to decide the next step.
- Keep final answers short and factual: say what you did and what the tool results showed.`;

/** The declared class a parsed tool call carries into the comm
 *  server. Only a floor — the classifier re-derives the real class
 *  from the tool and its arguments before anything executes. Mirrors
 *  MAC_TOOL_CLASSES (mac.ts) plus the workspace/fetch tools. */
function toolFloorClass(tool: string, args: Record<string, unknown>): ToolClass {
  switch (tool) {
    case "mac.observe":
    case "mac.fs.read":
    case "workspace_read":
      return "read";
    case "fetch": {
      const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
      return method === "GET" || method === "HEAD" ? "read" : "write";
    }
    case "github_publish_release":
      // v0.9.5: publishing is an external send by construction; the
      // floor says so before the classifier even looks (it parks
      // every publish regardless — policy.ts classifyGitHub).
      return "external-send";
    case "memory_propose":
      // v0.13.0: a proposal writes only to the candidates inbox;
      // the floor is "write" and the classifier allows it by code
      // rule (policy.ts §2e) — promotion is the operator's alone.
      return "write";
    default:
      return "write";
  }
}

// ---------------------------------------------------------------- native

/** v0.14.4: one executed (or to-be-executed) tool call inside a
 *  native conversation, under the provider API's own call id. The
 *  tool name here is the CANONICAL GUS name — the name mapping to
 *  the API's constraints happens at serialization, never in state. */
export interface NativeToolCallRef {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/** v0.14.4: the structured conversation the comm server maintains
 *  per job for native-capable providers (comm-server.ts owns the
 *  state machine; this is only the shape). A conversation is: the
 *  job's first prompt as the opening user message; each executed
 *  call as an assistant tool-call message paired with its tool-role
 *  result; each text reply kept as an assistant message, so a
 *  continuation (the task guard's, the voice lane's) can follow it
 *  as a fresh user message — the native mirror of the text loop's
 *  prompt-per-hop shape. */
export type NativeMessage =
  /** v0.24.0: a user message may carry the job's attached photos
   *  (only the conversation's opening message ever does — the
   *  comm server puts them there). Serializers present them as
   *  image input in each API's own shape. */
  | { role: "user"; text: string; images?: MessageImage[] }
  | { role: "assistant"; text: string }
  | { role: "assistant"; toolCall: NativeToolCallRef }
  | { role: "tool"; toolCallId: string; text: string };

/** v0.24.0: one attached photo as an OpenAI-compatible content
 *  part — a data URL, so the bytes ride the request itself and
 *  nothing is ever hosted or linked. */
function openAiImagePart(img: MessageImage): Record<string, unknown> {
  return {
    type: "image_url",
    image_url: { url: `data:${img.mediaType};base64,${img.data}` },
  };
}

/** v0.24.0: one attached photo as an Anthropic image block. */
function anthropicImageBlock(img: MessageImage): Record<string, unknown> {
  return {
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  };
}

/** The name a provider API sees for a canonical tool. Meta's
 *  chat-completions API rejects function names with more than one
 *  dot (verified live, 2026-11-19: "mac.shell.run" → HTTP 400,
 *  "may contain at most one dot"), so a multi-dot name collapses
 *  its tail segments with underscores: mac.shell.run →
 *  mac.shell_run, mac.fs.read → mac.fs_read. One-dot and dot-free
 *  names pass through unchanged. The mapping is bijective over the
 *  fixed tool set and is applied at serialization (outgoing) and
 *  parsing (incoming) only — executors, the classifier, and the
 *  comm wire only ever see canonical names. */
export function nativeToolName(tool: string): string {
  const parts = tool.split(".");
  return parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("_")}` : tool;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    additionalProperties: true,
    ...(required.length ? { required } : {}),
  };
}

const STR = { type: "string" };
const NUM = { type: "number" };

/** The native tool definitions: the TOOL_PROTOCOL tool set, with
 *  the same arg shapes, expressed as JSON Schema. The two lists are
 *  two presentations of one tool set — keep them in step, exactly
 *  as the protocol text and the executors are kept in step. */
export const NATIVE_TOOLS: {
  tool: string;
  description: string;
  parameters: Record<string, unknown>;
}[] = [
  { tool: "mac.observe", description: "look at the screen: returns the front app, its windows, and the visible controls. Call this before clicking or typing when you need the current state.", parameters: objectSchema({}) },
  { tool: "mac.open_app", description: "open an application by name.", parameters: objectSchema({ app: STR }, ["app"]) },
  { tool: "mac.focus_window", description: "focus a window by app name and optional window title.", parameters: objectSchema({ app: STR, title: STR }, ["app"]) },
  { tool: "mac.click", description: "click a control (by its label from mac.observe) or a point (x/y).", parameters: objectSchema({ element: STR, x: NUM, y: NUM }) },
  { tool: "mac.type", description: "type text into the focused control.", parameters: objectSchema({ text: STR }, ["text"]) },
  { tool: "mac.key", description: "press a key or shortcut, e.g. cmd+s.", parameters: objectSchema({ combo: STR }, ["combo"]) },
  { tool: "mac.scroll", description: "scroll the front window.", parameters: objectSchema({ direction: STR, amount: NUM }, ["direction"]) },
  { tool: "mac.fs.read", description: "read a file (approved folders only).", parameters: objectSchema({ path: STR }, ["path"]) },
  { tool: "mac.fs.write", description: "write a file (approved folders only).", parameters: objectSchema({ path: STR, content: STR }, ["path", "content"]) },
  { tool: "mac.shell.run", description: "run a shell command; cwd defaults to an approved folder.", parameters: objectSchema({ command: STR, cwd: STR }, ["command"]) },
  { tool: "mac.picker.select", description: "choose a file in an open file picker.", parameters: objectSchema({ path: STR }, ["path"]) },
  { tool: "workspace_read", description: "read a file in your sandbox workspace.", parameters: objectSchema({ path: STR }, ["path"]) },
  { tool: "workspace_write", description: "write a file in your sandbox workspace.", parameters: objectSchema({ path: STR, content: STR }, ["path", "content"]) },
  { tool: "fetch", description: "fetch a web page (via the egress proxy).", parameters: objectSchema({ url: STR, method: STR, body: STR, secretName: STR }, ["url"]) },
  { tool: "github_publish_release", description: "publish a GUS release: upload the named DMG + checksum to the existing draft GitHub release for that tag and publish it. The control plane performs it with the vaulted publish token; the checksum is verified against the DMG before anything uploads. To publish the iOS pair to the same release instead, name ipaPath with the .ipa's own .sha256 as shaPath. Name exactly ONE artifact per call (dmgPath or ipaPath, never both).", parameters: objectSchema({ tag: STR, dmgPath: STR, shaPath: STR, ipaPath: STR }, ["tag", "shaPath"]) },
  { tool: "memory_propose", description: "propose a durable memory for the operator's curated context (category: fact, decision, preference, identity, or project). It ONLY records a candidate: the operator reviews candidates and promotes the ones that become memory — a proposal is never memory by itself. Never put secrets or credentials in a proposal. At most 3 proposals per job.", parameters: objectSchema({ category: STR, text: STR, source: STR }, ["category", "text", "source"]) },
];

const CANONICAL_BY_NATIVE_NAME = new Map(NATIVE_TOOLS.map((t) => [nativeToolName(t.tool), t.tool]));

/** Map an API-returned function name back to the canonical tool.
 *  A name outside the table passes through unchanged — the same
 *  treatment the text protocol gives an invented tool name (the
 *  classifier and executors refuse it downstream). */
function canonicalToolName(name: string): string {
  return CANONICAL_BY_NATIVE_NAME.get(name) ?? name;
}

/** The native channel's system framing: the TOOL_PROTOCOL's rules
 *  with the reply-shape instructions replaced by the tool-calling
 *  interface itself. The tool list is NOT repeated here — the
 *  request's tool definitions carry it. */
const NATIVE_TOOL_PREAMBLE = `You are GUS, a secure AI agent running on the operator's own computer. The operator talks to you through a chat channel and asks you to do tasks on this machine. You act by calling tools through the tool-calling interface, one at a time.

When the task is done, or to answer a question, reply with plain text (no tool call). Plain text ends the task, so do not answer in plain text until the work is actually done.

Rules:
- Some actions need the operator's approval. The system asks them automatically when your call requires it — never ask for permission in your text, and never describe an action as done until a tool result confirms it.
- After each tool call you receive its result as a tool message. Use it to decide the next step.
- Keep final answers short and factual: say what you did and what the tool results showed.`;

/** Serialize the conversation for an OpenAI-compatible
 *  chat-completions request. The preamble rides the FIRST user
 *  message (the job's opening prompt), mirroring how the text
 *  protocol prepends TOOL_PROTOCOL to the prompt. */
function openAiNativeMessages(messages: NativeMessage[]): Record<string, unknown>[] {
  let prefaced = false;
  return messages.map((m) => {
    switch (m.role) {
      case "user": {
        const content = !prefaced ? `${NATIVE_TOOL_PREAMBLE}\n\n---\n\n${m.text}` : m.text;
        prefaced = true;
        // v0.24.0: photos turn the content into parts — text
        // first, then the images as data-URL parts.
        if (m.images?.length) {
          return {
            role: "user",
            content: [{ type: "text", text: content }, ...m.images.map(openAiImagePart)],
          };
        }
        return { role: "user", content };
      }
      case "assistant":
        if ("toolCall" in m) {
          return {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: m.toolCall.id,
                type: "function",
                function: {
                  name: nativeToolName(m.toolCall.tool),
                  arguments: JSON.stringify(m.toolCall.args),
                },
              },
            ],
          };
        }
        return { role: "assistant", content: m.text };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.text };
    }
  });
}

/** Serialize the conversation for Anthropic's Messages API: tool
 *  calls are tool_use content blocks, and a tool result is a
 *  tool_result block on a user message — the same conversation,
 *  the other vendor's shape. */
function anthropicNativeMessages(messages: NativeMessage[]): Record<string, unknown>[] {
  let prefaced = false;
  return messages.map((m) => {
    switch (m.role) {
      case "user": {
        const content = !prefaced ? `${NATIVE_TOOL_PREAMBLE}\n\n---\n\n${m.text}` : m.text;
        prefaced = true;
        // v0.24.0: photos become image blocks ahead of the text
        // block (the Messages API's multimodal message shape).
        if (m.images?.length) {
          return {
            role: "user",
            content: [...m.images.map(anthropicImageBlock), { type: "text", text: content }],
          };
        }
        return { role: "user", content };
      }
      case "assistant":
        if ("toolCall" in m) {
          return {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: m.toolCall.id,
                name: nativeToolName(m.toolCall.tool),
                input: m.toolCall.args,
              },
            ],
          };
        }
        return { role: "assistant", content: m.text };
      case "tool":
        return {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.text }],
        };
    }
  });
}

/** The text the Governor's estimator scores a native request
 *  against: the tool definitions (the API charges for them as
 *  input) plus every message's content. Approximation is the
 *  estimator's standing contract — settlement always uses the
 *  usage the API actually reports. */
export function nativeRequestEstimateText(messages: NativeMessage[]): string {
  const parts: string[] = [NATIVE_TOOL_PREAMBLE, JSON.stringify(NATIVE_TOOLS)];
  for (const m of messages) {
    if (m.role === "assistant" && "toolCall" in m) {
      parts.push(m.toolCall.tool, JSON.stringify(m.toolCall.args));
    } else {
      parts.push(m.text);
    }
  }
  return parts.join("\n");
}

abstract class RemoteProvider implements Provider {
  abstract readonly id: ProviderId;
  abstract readonly model: string;
  readonly kind = "remote" as const;
  readonly maxTokensOut: number;

  constructor(
    protected vault: VaultBroker,
    protected transport: ProviderTransport,
    maxTokensOut?: number,
  ) {
    this.maxTokensOut = maxTokensOut ?? DEFAULT_MAX_TOKENS;
  }

  get modelKey(): string {
    return `${this.id}/${this.model}`;
  }

  abstract complete(
    prompt: string,
    opts?: { maxTokensOut?: number; messages?: NativeMessage[]; images?: MessageImage[] },
  ): Promise<ProviderCompletion>;

  /** Phase 9: present the tool protocol to a real model. Until now the
   *  remote providers returned text only, so a real model could chat
   *  but could never call a tool — the agent loop's tool calls existed
   *  only in the stub's pattern matching (field finding, 2026-11-05:
   *  Gemini answered "I can't open apps directly on your device" to a
   *  request the Mac pack exists to serve). The protocol rides the
   *  prompt itself, so it works with every chat-completions-shaped
   *  provider, and the control plane's classifier remains the real
   *  authority: the declared class parsed here is only a floor. */
  protected promptWithToolProtocol(prompt: string): string {
    return `${TOOL_PROTOCOL}\n\n---\n\n${prompt}`;
  }

  /** Parse a real model's reply: a bare JSON object naming a tool is
   *  a tool call; anything else is the final answer text. Code fences
   *  are tolerated; a JSON object without a tool name is treated as
   *  text (models emit JSON for other reasons). */
  protected parseToolReply(text: string): ProviderReply {
    const unfenced = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      const obj = JSON.parse(unfenced) as { tool?: unknown; args?: unknown };
      if (obj && typeof obj.tool === "string" && obj.tool) {
        const args =
          obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
            ? (obj.args as Record<string, unknown>)
            : {};
        return { toolCall: { tool: obj.tool, declaredClass: toolFloorClass(obj.tool, args), args } };
      }
    } catch {
      /* not JSON — a final answer */
    }
    return { text };
  }

  /** v0.14.4: map a structured tool call from a native API response
   *  onto the same ProviderReply the text protocol produces — the
   *  API's function name is canonicalized, the declared class is
   *  the same floor parseToolReply computes, and the API's call id
   *  rides along for the comm server's conversation pairing. */
  protected nativeReply(name: string, args: Record<string, unknown>, id?: string): ProviderReply {
    const tool = canonicalToolName(name);
    return {
      toolCall: { tool, declaredClass: toolFloorClass(tool, args), args, ...(id ? { id } : {}) },
    };
  }

  /**
   * Run an HTTP call whose Authorization comes from a vault secret.
   * The value exists only inside the withSecret callback's closure.
   * `keyRequired` distinguishes BYOK classes (anthropic/openai: no key
   * = a clear operator error) from local ones (ollama/gateway: key
   * optional, attached when present).
   */
  protected async callWithKey(
    keyName: string,
    keyRequired: boolean,
    header: "authorization" | "x-api-key",
    url: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<ProviderTransportResponse> {
    const send = (key?: string) =>
      this.transport(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(extraHeaders ?? {}),
          ...(key
            ? header === "authorization"
              ? { authorization: `Bearer ${key}` }
              : { "x-api-key": key }
            : {}),
        },
        body: JSON.stringify(body),
      });
    const attempt = async (): Promise<ProviderTransportResponse> => {
      if (!this.vault.has(keyName)) {
        if (keyRequired) {
          throw new Error(
            `no vault secret named "${keyName}" — add your provider key in the panel (Setup → Provider); the agent never sees it`,
          );
        }
        return send(undefined);
      }
      const res = await this.vault.withSecret(keyName, (key) => send(key));
      if (!res) throw new Error(`vault secret "${keyName}" vanished mid-call`);
      return res;
    };
    // Transient provider failures (429 rate-limited, 503 overloaded)
    // are retried with backoff before any refusal reaches the job —
    // one hiccup shouldn't fail the operator's task (field: Gemini
    // answered a job with HTTP 503, 2026-11-05).
    let res = await attempt();
    for (const delayMs of [1_000, 3_000]) {
      if (res.status !== 429 && res.status !== 503) break;
      await new Promise((r) => setTimeout(r, delayMs));
      res = await attempt();
    }
    return res;
  }

  protected async expectOk(res: ProviderTransportResponse, who: string): Promise<Record<string, unknown>> {
    if (res.status !== 200) {
      throw new Error(`${who} refused the call (HTTP ${res.status}) — check the provider key and model in Setup`);
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new Error(`${who} returned an unreadable response`);
    return body;
  }
}

export class AnthropicProvider extends RemoteProvider {
  readonly id = "anthropic" as const;
  /** v0.14.4: the Messages API's tool use is native to it; on
   *  unless the operator's config pins the text protocol. */
  readonly nativeTools: boolean;
  private base: string;
  /** v0.9.11: the name failures are reported under — the vendor
   *  AND the configured model ("Anthropic (claude-sonnet-5)"),
   *  the same shape the OpenAI-compatible class composes, so an
   *  error always names the service that actually failed. */
  private who: string;

  constructor(
    vault: VaultBroker,
    readonly model: string,
    opts?: {
      baseUrl?: string;
      maxTokens?: number;
      transport?: ProviderTransport;
      nativeTools?: boolean;
    },
  ) {
    super(vault, opts?.transport ?? defaultTransport, opts?.maxTokens);
    this.base = (opts?.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.who = `Anthropic (${model})`;
    this.nativeTools = opts?.nativeTools ?? true;
  }

  async complete(
    prompt: string,
    opts?: { maxTokensOut?: number; messages?: NativeMessage[]; images?: MessageImage[] },
  ): Promise<ProviderCompletion> {
    // v0.14.4: a supplied conversation on a native-capable provider
    // runs the native channel; everything else — including every
    // non-loop caller — runs the text protocol below, unchanged.
    if (this.nativeTools && opts?.messages) return this.completeNative(opts.messages, opts);
    // v0.9.11: an EMPTY reply is retried ONCE before it may fail
    // the job — a real backend intermittently answers 200 with no
    // text at all, and one hiccup shouldn't kill the operator's
    // turn (the OpenAI-compatible class does the same; token
    // usage sums across both attempts when the API reports it
    // per attempt, and falls back to the estimates when it
    // doesn't, exactly as a single attempt did).
    // v0.24.0: photos make the user content a block array —
    // image blocks ahead of the protocol-carrying text block.
    // Without photos the content stays the plain string it has
    // always been, byte for byte.
    const fullPrompt = this.promptWithToolProtocol(prompt);
    const content: string | Record<string, unknown>[] = opts?.images?.length
      ? [...opts.images.map(anthropicImageBlock), { type: "text", text: fullPrompt }]
      : fullPrompt;
    let attempts = 0;
    let inSum = 0;
    let outSum = 0;
    let inReported = true;
    let outReported = true;
    let text = "";
    while (attempts < 2) {
      attempts++;
      const res = await this.callWithKey(
        "anthropic",
        true,
        "x-api-key",
        `${this.base}/v1/messages`,
        {
          model: this.model,
          max_tokens: opts?.maxTokensOut ?? this.maxTokensOut,
          messages: [{ role: "user", content }],
        },
        { "anthropic-version": "2023-06-01" },
      );
      const body = await this.expectOk(res, this.who);
      const blocks = Array.isArray(body.content) ? (body.content as Array<Record<string, unknown>>) : [];
      text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      const usage = (body.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      if (typeof usage.input_tokens === "number") inSum += usage.input_tokens;
      else inReported = false;
      if (typeof usage.output_tokens === "number") outSum += usage.output_tokens;
      else outReported = false;
      if (text) break;
    }
    if (!text) throw new Error(`${this.who} returned no text`);
    return {
      reply: this.parseToolReply(text),
      tokensIn: inReported ? inSum : estimateTokens(prompt),
      tokensOut: outReported ? outSum : estimateTokens(text),
    };
  }

  /** v0.14.4: the native channel — the conversation serialized in
   *  the Messages API's own shape (tool_use / tool_result blocks),
   *  the fixed tool set as native definitions, tool_choice auto.
   *  A tool_use block is the reply's tool call; text blocks are
   *  the reply's text (still run through parseToolReply, so a model
   *  answering in the old bare-JSON form is understood too). An
   *  attempt with neither is the 200-but-empty case and is retried
   *  once, exactly like the text path. */
  private async completeNative(
    messages: NativeMessage[],
    opts?: { maxTokensOut?: number },
  ): Promise<ProviderCompletion> {
    let attempts = 0;
    let inSum = 0;
    let outSum = 0;
    let inReported = true;
    let outReported = true;
    let reply: ProviderReply | undefined;
    while (attempts < 2) {
      attempts++;
      const res = await this.callWithKey(
        "anthropic",
        true,
        "x-api-key",
        `${this.base}/v1/messages`,
        {
          model: this.model,
          max_tokens: opts?.maxTokensOut ?? this.maxTokensOut,
          messages: anthropicNativeMessages(messages),
          tools: NATIVE_TOOLS.map((t) => ({
            name: nativeToolName(t.tool),
            description: t.description,
            input_schema: t.parameters,
          })),
          tool_choice: { type: "auto" },
        },
        { "anthropic-version": "2023-06-01" },
      );
      const body = await this.expectOk(res, this.who);
      const blocks = Array.isArray(body.content) ? (body.content as Array<Record<string, unknown>>) : [];
      const usage = (body.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      if (typeof usage.input_tokens === "number") inSum += usage.input_tokens;
      else inReported = false;
      if (typeof usage.output_tokens === "number") outSum += usage.output_tokens;
      else outReported = false;
      const toolUse = blocks.find((b) => b.type === "tool_use" && typeof b.name === "string" && b.name);
      if (toolUse) {
        const input =
          toolUse.input && typeof toolUse.input === "object" && !Array.isArray(toolUse.input)
            ? (toolUse.input as Record<string, unknown>)
            : {};
        reply = this.nativeReply(
          toolUse.name as string,
          input,
          typeof toolUse.id === "string" ? toolUse.id : undefined,
        );
        break;
      }
      const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      if (text) {
        reply = this.parseToolReply(text);
        break;
      }
    }
    if (!reply) throw new Error(`${this.who} returned no text`);
    return {
      reply,
      tokensIn: inReported ? inSum : estimateTokens(nativeRequestEstimateText(messages)),
      tokensOut: outReported ? outSum : estimateTokens(reply.text ?? JSON.stringify(reply.toolCall ?? {})),
    };
  }
}

export class OpenAiCompatibleProvider extends RemoteProvider {
  readonly id: ProviderId;
  readonly model: string;
  /** v0.14.4: set by the factory per class (on for openai/gemini,
   *  off for ollama/gateway) unless the operator's config overrides
   *  it — see resolveProvider. */
  readonly nativeTools: boolean;
  private base: string;
  private keyName: string;
  private keyRequired: boolean;
  private who: string;

  constructor(
    vault: VaultBroker,
    opts: {
      id: "openai" | "gemini" | "ollama" | "gateway";
      model: string;
      baseUrl: string;
      keyName: string;
      keyRequired: boolean;
      who: string;
      maxTokens?: number;
      transport?: ProviderTransport;
      nativeTools?: boolean;
    },
  ) {
    super(vault, opts?.transport ?? defaultTransport, opts?.maxTokens);
    this.id = opts.id;
    this.model = opts.model;
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.keyName = opts.keyName;
    this.keyRequired = opts.keyRequired;
    this.nativeTools = opts.nativeTools ?? false;
    // v0.9.11: `who` arrives as the backend's DISPLAY NAME (the
    // factory derives it from the configured base URL — see
    // backendDisplayName); the label failures are reported under
    // is that name plus the configured model, composed here so
    // every construction site inherits it: "Meta (muse-spark-1.3)
    // returned no text", never a bare vendor the config isn't
    // actually pointing at.
    this.who = `${opts.who} (${opts.model})`;
  }

  async complete(
    prompt: string,
    opts?: { maxTokensOut?: number; messages?: NativeMessage[]; images?: MessageImage[] },
  ): Promise<ProviderCompletion> {
    // v0.14.4: a supplied conversation on a native-capable provider
    // runs the native channel; everything else — including every
    // non-loop caller — runs the text protocol below, unchanged.
    if (this.nativeTools && opts?.messages) return this.completeNative(opts.messages, opts);
    // v0.9.11: an EMPTY reply is retried ONCE before it may fail
    // the job — a real backend intermittently answers 200 with no
    // text at all (field: Meta's API did this mid-call, in both
    // Shield modes, 2026-11-12), and one hiccup shouldn't kill
    // the operator's turn. Token usage sums across both attempts
    // when the API reports it per attempt, and falls back to the
    // estimates when it doesn't, exactly as a single attempt did.
    // (Transport-level 429/503 retries live in callWithKey; this
    // is the 200-but-empty case above them.)
    // v0.24.0: photos make the user content a parts array — the
    // protocol-carrying text part first, then the images as
    // data-URL parts. Without photos the content stays the plain
    // string it has always been, byte for byte.
    const fullPrompt = this.promptWithToolProtocol(prompt);
    const content: string | Record<string, unknown>[] = opts?.images?.length
      ? [{ type: "text", text: fullPrompt }, ...opts.images.map(openAiImagePart)]
      : fullPrompt;
    let attempts = 0;
    let inSum = 0;
    let outSum = 0;
    let inReported = true;
    let outReported = true;
    let text = "";
    while (attempts < 2) {
      attempts++;
      const res = await this.callWithKey(this.keyName, this.keyRequired, "authorization", `${this.base}/chat/completions`, {
        model: this.model,
        max_tokens: opts?.maxTokensOut ?? this.maxTokensOut,
        messages: [{ role: "user", content }],
      });
      const body = await this.expectOk(res, this.who);
      const choices = Array.isArray(body.choices) ? (body.choices as Array<Record<string, unknown>>) : [];
      const message = (choices[0]?.message ?? {}) as { content?: unknown };
      text = typeof message.content === "string" ? message.content : "";
      const usage = (body.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
      if (typeof usage.prompt_tokens === "number") inSum += usage.prompt_tokens;
      else inReported = false;
      if (typeof usage.completion_tokens === "number") outSum += usage.completion_tokens;
      else outReported = false;
      if (text) break;
    }
    if (!text) throw new Error(`${this.who} returned no text`);
    return {
      reply: this.parseToolReply(text),
      tokensIn: inReported ? inSum : estimateTokens(prompt),
      tokensOut: outReported ? outSum : estimateTokens(text),
    };
  }

  /** v0.14.4: the native channel — the conversation serialized as
   *  chat-completions messages (assistant tool_calls + tool-role
   *  results), the fixed tool set as function definitions, and
   *  tool_choice "auto": the only value every OpenAI-compatible
   *  backend accepts (Meta's API rejects "required", "none", and
   *  named choices outright — verified live, 2026-11-19). The
   *  FIRST structured tool call is the reply's tool call — the
   *  loop executes one call at a time, so any further calls in the
   *  same response are dropped, never recorded as answered; the
   *  model re-issues what is still needed after the result. Text
   *  content is the reply's text (still run through parseToolReply,
   *  so a model answering in the old bare-JSON form is understood
   *  too); content accompanying a tool call is commentary and is
   *  dropped, the same precedence the text protocol gives a JSON
   *  reply. An attempt with neither a tool call nor text is the
   *  200-but-empty case and is retried once, exactly like the text
   *  path. */
  private async completeNative(
    messages: NativeMessage[],
    opts?: { maxTokensOut?: number },
  ): Promise<ProviderCompletion> {
    let attempts = 0;
    let inSum = 0;
    let outSum = 0;
    let inReported = true;
    let outReported = true;
    let reply: ProviderReply | undefined;
    while (attempts < 2) {
      attempts++;
      const res = await this.callWithKey(this.keyName, this.keyRequired, "authorization", `${this.base}/chat/completions`, {
        model: this.model,
        max_tokens: opts?.maxTokensOut ?? this.maxTokensOut,
        messages: openAiNativeMessages(messages),
        tools: NATIVE_TOOLS.map((t) => ({
          type: "function",
          function: {
            name: nativeToolName(t.tool),
            description: t.description,
            parameters: t.parameters,
          },
        })),
        tool_choice: "auto",
      });
      const body = await this.expectOk(res, this.who);
      const choices = Array.isArray(body.choices) ? (body.choices as Array<Record<string, unknown>>) : [];
      const message = (choices[0]?.message ?? {}) as {
        content?: unknown;
        tool_calls?: unknown;
      };
      const usage = (body.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
      if (typeof usage.prompt_tokens === "number") inSum += usage.prompt_tokens;
      else inReported = false;
      if (typeof usage.completion_tokens === "number") outSum += usage.completion_tokens;
      else outReported = false;
      const calls = Array.isArray(message.tool_calls)
        ? (message.tool_calls as Array<Record<string, unknown>>)
        : [];
      const first = calls[0];
      const fn = (first?.function ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof fn.name === "string" && fn.name) {
        let args: Record<string, unknown> = {};
        if (typeof fn.arguments === "string" && fn.arguments.trim()) {
          try {
            const parsed = JSON.parse(fn.arguments) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            /* malformed arguments: empty args — the classifier and
               the executor's own validation answer with a tool
               error the model can see and correct, rather than the
               call dying here as an opaque provider failure */
          }
        }
        reply = this.nativeReply(fn.name, args, typeof first.id === "string" ? first.id : undefined);
        break;
      }
      const text = typeof message.content === "string" ? message.content : "";
      if (text) {
        reply = this.parseToolReply(text);
        break;
      }
    }
    if (!reply) throw new Error(`${this.who} returned no text`);
    return {
      reply,
      tokensIn: inReported ? inSum : estimateTokens(nativeRequestEstimateText(messages)),
      tokensOut: outReported ? outSum : estimateTokens(reply.text ?? JSON.stringify(reply.toolCall ?? {})),
    };
  }
}

/**
 * Gemini — Google's models through their OpenAI-compatible endpoint.
 * A thin specialization of the OpenAI-compatible class, not a parallel
 * implementation: same request shape, same usage parsing, same
 * Governor metering under "gemini/<model>". Two differences, both
 * deliberate: the key is REQUIRED (there is no local Gemini), and the
 * base URL is pinned to GEMINI_BASE_URL — a baseUrl in provider.json
 * is ignored for this class, so the key can only be injected at
 * Google's host.
 */
export class GeminiProvider extends OpenAiCompatibleProvider {
  constructor(
    vault: VaultBroker,
    model: string,
    opts?: { maxTokens?: number; transport?: ProviderTransport; nativeTools?: boolean },
  ) {
    super(vault, {
      id: "gemini",
      model,
      baseUrl: GEMINI_BASE_URL,
      keyName: "gemini",
      keyRequired: true,
      who: "Gemini",
      maxTokens: opts?.maxTokens,
      transport: opts?.transport,
      // v0.14.4: Google's OpenAI-compatible endpoint serves native
      // function calling; on unless the factory passes an explicit
      // operator override (including false).
      nativeTools: opts?.nativeTools ?? true,
    });
  }
}

// ---------------------------------------------------------------- factory

/** v0.9.11: the display name of the backend a base URL actually
 *  points at. An OpenAI-compatible config can point at ANY
 *  vendor's endpoint — the operator's points at Meta's — while
 *  the class is named for the API SHAPE ("openai"), so a
 *  per-class name is only true for the class's canonical host.
 *  The name failures are reported under is therefore derived
 *  from the configured host: api.meta.ai is Meta whatever the
 *  class is called, and api.openai.com is OpenAI. A local
 *  endpoint (an IP literal, localhost) names no vendor, so the
 *  class fallback stands. Well-known hosts get their brand
 *  casing; any other host is named by its own first label,
 *  capitalized — derived from the config in every case, never
 *  a vendor hard-coded against a different one's endpoint. */
const BACKEND_BRAND_NAMES: Record<string, string> = {
  openai: "OpenAI",
  meta: "Meta",
  anthropic: "Anthropic",
  google: "Google",
  googleapis: "Google",
  ollama: "Ollama",
};

function backendDisplayName(baseUrl: string, fallback: string): string {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return fallback;
  }
  if (!host || host === "localhost" || host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return fallback;
  }
  const labels = host.split(".").filter((l) => l.length > 0);
  while (labels.length > 1 && (labels[0] === "api" || labels[0] === "www")) labels.shift();
  const label = labels[0] ?? "";
  if (!label) return fallback;
  return BACKEND_BRAND_NAMES[label] ?? label.charAt(0).toUpperCase() + label.slice(1);
}

/** Resolve the active provider from config (re-read per call). */
export function resolveProvider(
  stateDir: string,
  vault: VaultBroker,
  transport?: ProviderTransport,
): Provider {
  const cfg = loadProviderConfig(stateDir);
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicProvider(vault, cfg.model, {
        baseUrl: cfg.baseUrl,
        maxTokens: cfg.maxTokens,
        transport,
        // v0.14.4: undefined = the class default (native on); an
        // explicit provider.json value wins either way.
        nativeTools: cfg.nativeTools,
      });
    case "openai":
      return new OpenAiCompatibleProvider(vault, {
        id: "openai",
        model: cfg.model,
        baseUrl: cfg.baseUrl ?? "https://api.openai.com/v1",
        keyName: "openai",
        keyRequired: true,
        // v0.9.11: named for the backend the config POINTS at
        // (Meta, when baseUrl is Meta's) — not for the API shape.
        who: backendDisplayName(cfg.baseUrl ?? "https://api.openai.com/v1", "OpenAI"),
        maxTokens: cfg.maxTokens,
        transport,
        // v0.14.4: the default provider path is native — this is
        // the Cycle 0 path (openai/muse-spark-1.3 at Meta), and it
        // must never silently degrade to the text protocol. An
        // explicit provider.json "nativeTools": false is the
        // operator's own pin, honored as config.
        nativeTools: cfg.nativeTools ?? true,
      });
    case "gemini":
      // cfg.baseUrl deliberately NOT honored: the Gemini key is only
      // ever injected at Google's pinned endpoint (see GeminiProvider).
      return new GeminiProvider(vault, cfg.model, {
        maxTokens: cfg.maxTokens,
        transport,
        nativeTools: cfg.nativeTools,
      });
    case "ollama":
      return new OpenAiCompatibleProvider(vault, {
        id: "ollama",
        model: cfg.model,
        baseUrl: cfg.baseUrl ?? "http://127.0.0.1:11434/v1",
        keyName: "ollama",
        keyRequired: false,
        // v0.9.11: a local base URL keeps the class name (the
        // derivation's fallback); a remote one names its host.
        who: backendDisplayName(cfg.baseUrl ?? "http://127.0.0.1:11434/v1", "Ollama"),
        maxTokens: cfg.maxTokens,
        transport,
        // v0.14.4: off by default — a local endpoint's tool support
        // depends on the model behind it, and the text protocol is
        // this class's known-good path. The operator enables native
        // per install ("nativeTools": true) for a tool-capable
        // local model.
        nativeTools: cfg.nativeTools ?? false,
      });
    case "gateway":
      return new OpenAiCompatibleProvider(vault, {
        id: "gateway",
        model: cfg.model,
        baseUrl: cfg.baseUrl ?? "https://chat.0rang3.com/v1",
        keyName: "starter-gateway",
        keyRequired: false,
        who: "the starter gateway",
        maxTokens: cfg.maxTokens,
        transport,
        // v0.14.4: off by default, like ollama — the gateway's
        // backend varies, and its text protocol is unchanged.
        nativeTools: cfg.nativeTools ?? false,
      });
    default:
      return new StubProvider();
  }
}
