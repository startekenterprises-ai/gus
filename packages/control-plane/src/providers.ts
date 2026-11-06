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
 *     Provider-native tool-use APIs are deliberately NOT used: the
 *     protocol works identically across providers, and every call
 *     still crosses the classifier, the Shield gate, and the Governor
 *     exactly like a stub call. A reply with no text is a provider
 *     error, never a silent empty success.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import type { ToolClass } from "@gus/shared";
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
  complete(prompt: string): Promise<ProviderCompletion>;
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

  async complete(prompt: string): Promise<ProviderCompletion> {
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
    default:
      return "write";
  }
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

  abstract complete(prompt: string): Promise<ProviderCompletion>;

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
  private base: string;

  constructor(
    vault: VaultBroker,
    readonly model: string,
    opts?: { baseUrl?: string; maxTokens?: number; transport?: ProviderTransport },
  ) {
    super(vault, opts?.transport ?? defaultTransport, opts?.maxTokens);
    this.base = (opts?.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  }

  async complete(prompt: string): Promise<ProviderCompletion> {
    const res = await this.callWithKey(
      "anthropic",
      true,
      "x-api-key",
      `${this.base}/v1/messages`,
      {
        model: this.model,
        max_tokens: this.maxTokensOut,
        messages: [{ role: "user", content: this.promptWithToolProtocol(prompt) }],
      },
      { "anthropic-version": "2023-06-01" },
    );
    const body = await this.expectOk(res, "Anthropic");
    const blocks = Array.isArray(body.content) ? (body.content as Array<Record<string, unknown>>) : [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    const usage = (body.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    if (!text) throw new Error("Anthropic returned no text");
    return {
      reply: this.parseToolReply(text),
      tokensIn: usage.input_tokens ?? estimateTokens(prompt),
      tokensOut: usage.output_tokens ?? estimateTokens(text),
    };
  }
}

export class OpenAiCompatibleProvider extends RemoteProvider {
  readonly id: ProviderId;
  readonly model: string;
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
    },
  ) {
    super(vault, opts?.transport ?? defaultTransport, opts?.maxTokens);
    this.id = opts.id;
    this.model = opts.model;
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.keyName = opts.keyName;
    this.keyRequired = opts.keyRequired;
    this.who = opts.who;
  }

  async complete(prompt: string): Promise<ProviderCompletion> {
    const res = await this.callWithKey(this.keyName, this.keyRequired, "authorization", `${this.base}/chat/completions`, {
      model: this.model,
      max_tokens: this.maxTokensOut,
      messages: [{ role: "user", content: this.promptWithToolProtocol(prompt) }],
    });
    const body = await this.expectOk(res, this.who);
    const choices = Array.isArray(body.choices) ? (body.choices as Array<Record<string, unknown>>) : [];
    const message = (choices[0]?.message ?? {}) as { content?: unknown };
    const text = typeof message.content === "string" ? message.content : "";
    const usage = (body.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
    if (!text) throw new Error(`${this.who} returned no text`);
    return {
      reply: this.parseToolReply(text),
      tokensIn: usage.prompt_tokens ?? estimateTokens(prompt),
      tokensOut: usage.completion_tokens ?? estimateTokens(text),
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
    opts?: { maxTokens?: number; transport?: ProviderTransport },
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
    });
  }
}

// ---------------------------------------------------------------- factory

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
      });
    case "openai":
      return new OpenAiCompatibleProvider(vault, {
        id: "openai",
        model: cfg.model,
        baseUrl: cfg.baseUrl ?? "https://api.openai.com/v1",
        keyName: "openai",
        keyRequired: true,
        who: "OpenAI",
        maxTokens: cfg.maxTokens,
        transport,
      });
    case "gemini":
      // cfg.baseUrl deliberately NOT honored: the Gemini key is only
      // ever injected at Google's pinned endpoint (see GeminiProvider).
      return new GeminiProvider(vault, cfg.model, {
        maxTokens: cfg.maxTokens,
        transport,
      });
    case "ollama":
      return new OpenAiCompatibleProvider(vault, {
        id: "ollama",
        model: cfg.model,
        baseUrl: cfg.baseUrl ?? "http://127.0.0.1:11434/v1",
        keyName: "ollama",
        keyRequired: false,
        who: "Ollama",
        maxTokens: cfg.maxTokens,
        transport,
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
      });
    default:
      return new StubProvider();
  }
}
