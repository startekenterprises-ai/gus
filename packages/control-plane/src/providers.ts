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
 *   - v1 scope, stated plainly: real providers return TEXT replies.
 *     Provider-native tool-use wiring (mapping Anthropic/OpenAI tool
 *     calls onto GUS's fixed tool set) is not in this phase — the
 *     agent loop's tool path is exercised by the stub in drills and by
 *     the gateway classes as they are wired per deployment. A reply
 *     with no text is a provider error, never a silent empty success.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
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
        messages: [{ role: "user", content: prompt }],
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
    if (!text) throw new Error("Anthropic returned no text (tool-use-only replies are not wired in v1)");
    return {
      reply: { text },
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
      messages: [{ role: "user", content: prompt }],
    });
    const body = await this.expectOk(res, this.who);
    const choices = Array.isArray(body.choices) ? (body.choices as Array<Record<string, unknown>>) : [];
    const message = (choices[0]?.message ?? {}) as { content?: unknown };
    const text = typeof message.content === "string" ? message.content : "";
    const usage = (body.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
    if (!text) throw new Error(`${this.who} returned no text`);
    return {
      reply: { text },
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
