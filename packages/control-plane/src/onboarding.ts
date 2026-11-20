/**
 * Onboarding (foundation spec §1.6) — Phase 4.
 *
 * The five-step guided first run, driven from the panel (and only the
 * panel — no terminal beyond the single install command, and no secret
 * ever travels through a channel: Telegram is not end-to-end encrypted,
 * spec Amendment A3, and the wizard says so where the operator pastes).
 *
 * State is a small JSON file in control-plane state recording WHICH
 * steps are done and operator-visible details (provider id + model,
 * the fail-mode choice). It never contains a secret value: keys go
 * vault.add() or nowhere — the drill asserts the key strings appear in
 * no state file except the vault's ciphertext.
 *
 * Steps:
 *   1. shield   — zero-form Agent-Shield signup; the returned key goes
 *      straight into the vault (ShieldClient.provision), and the
 *      operator's fail-mode choice is recorded in policy. From this
 *      moment the gate is REQUIRED by policy.
 *   2. telegram — the bot token is stored in the vault as
 *      "telegram-bot". (Boot note: the adapter reads env first, then
 *      this vault entry — main.ts — so a token stored here takes
 *      effect on the next control-plane start; the step records that
 *      plainly rather than pretending a live rewire happened.)
 *   3. provider — provider + model into provider.json; the API key,
 *      when the class needs one, into the vault under the provider's
 *      name. Ollama needs no key and costs $0.
 *   4. caps     — USD ceilings into governor.json, pre-filled with
 *      conservative defaults the operator may edit.
 *   5. firstJob — the daily digest, run through the full pipeline
 *      (create → gate → meter → verify → settle) as the proof.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { VaultBroker } from "@gus/vault";
import type { ShieldGate } from "@gus/gate";
import type { Governor } from "./governor.js";
import type { PolicyStore } from "./policy.js";
import {
  loadProviderConfig,
  writeProviderConfig,
  SUGGESTED_MODELS,
  type ProviderId,
} from "./providers.js";

export const TELEGRAM_SECRET_NAME = "telegram-bot";

/** The one-sentence free-tier disclosure shown wherever the Gemini
 *  choice is presented (wizard + install docs use this same text). */
export const GEMINI_FREE_TIER_NOTE =
  "One honest catch: on Google's free tier, Google may use what you send to improve its models — a paid Gemini key removes that.";

/** The first guided job (spec §2.1, job type 1). Read-only by design. */
export const DIGEST_PROMPT =
  "daily digest — summarize today's email and calendar headlines, read-only, no sends, no changes";

/** Conservative starter ceilings (USD), pre-filled in the wizard. */
export const SUGGESTED_CAPS = {
  maxUsdPerTask: 2,
  maxUsdPerDay: 10,
  maxUsdPerMonth: 100,
};

export interface OnboardingStepRecord {
  doneAt: number;
  detail: string;
}

export interface OnboardingState {
  version: 1;
  steps: {
    shield?: OnboardingStepRecord & { onUnavailable?: string };
    telegram?: OnboardingStepRecord;
    provider?: OnboardingStepRecord & { provider?: string; model?: string };
    caps?: OnboardingStepRecord;
    firstJob?: OnboardingStepRecord & { jobId?: string };
  };
}

/** The vault name a provider class reads its key from. */
export const PROVIDER_KEY_NAMES: Record<Exclude<ProviderId, "stub">, string> = {
  anthropic: "anthropic",
  openai: "openai",
  gemini: "gemini",
  ollama: "ollama",
  gateway: "starter-gateway",
};

const PROVIDER_IDS: ProviderId[] = ["stub", "anthropic", "openai", "gemini", "ollama", "gateway"];

export class Onboarding {
  constructor(
    private stateDir: string,
    private deps: {
      vault: VaultBroker;
      gate: ShieldGate;
      policy: PolicyStore;
      governor: Governor;
      /** Runs the digest through the live pipeline; returns the job id. */
      runFirstJob: () => string;
    },
  ) {}

  private statePath(): string {
    return `${this.stateDir}/onboarding.json`;
  }

  state(): OnboardingState {
    try {
      if (existsSync(this.statePath())) {
        const raw = JSON.parse(readFileSync(this.statePath(), "utf8")) as OnboardingState;
        if (raw.version === 1 && raw.steps) return raw;
      }
    } catch {
      /* a torn onboarding file restarts the wizard, never wedges it */
    }
    return { version: 1, steps: {} };
  }

  private save(state: OnboardingState): void {
    writeFileSync(this.statePath(), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    chmodSync(this.statePath(), 0o600);
  }

  /** The panel's view: which steps are done + the pre-filled values. */
  view(): {
    steps: Record<"shield" | "telegram" | "provider" | "caps" | "firstJob", { done: boolean; detail?: string }>;
    suggestedCaps: typeof SUGGESTED_CAPS;
    currentProvider: { provider: string; model: string; baseUrl?: string };
  } {
    const s = this.state();
    const step = (r?: OnboardingStepRecord) => ({ done: !!r, detail: r?.detail });
    const cfg = loadProviderConfig(this.stateDir);
    return {
      steps: {
        shield: step(s.steps.shield),
        telegram: step(s.steps.telegram),
        provider: step(s.steps.provider),
        caps: step(s.steps.caps),
        firstJob: step(s.steps.firstJob),
      },
      suggestedCaps: { ...SUGGESTED_CAPS },
      currentProvider: { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl },
    };
  }

  /** Step 1 — provision the Shield key (zero-form) + record the
   *  operator's fail-mode choice in policy. */
  async shield(onUnavailableRaw?: string): Promise<{ ok: boolean; detail: string }> {
    const onUnavailable = onUnavailableRaw === "open" ? "open" : "closed";
    const result = await this.deps.gate.provision();
    if (!result.ok) {
      return { ok: false, detail: `Could not provision the Agent-Shield key: ${result.detail}` };
    }
    this.deps.policy.writeShield({ required: true, onUnavailable });
    const s = this.state();
    s.steps.shield = {
      doneAt: Date.now(),
      onUnavailable,
      detail: result.already
        ? `gate already provisioned; fail mode recorded as fail-${onUnavailable}`
        : `free key provisioned into the vault; fail mode recorded as fail-${onUnavailable}`,
    };
    this.save(s);
    return {
      ok: true,
      detail:
        `Agent-Shield gate is ON. If the Shield can't be reached, GUS will ` +
        (onUnavailable === "closed"
          ? "block messages and actions (fail-closed)."
          : "let things through unscanned, flagged, with no receipt (fail-open)."),
    };
  }

  /** Step 2 — Telegram bot token into the vault (panel-only path). */
  telegram(tokenRaw?: string): { ok: boolean; detail: string } {
    const token = (tokenRaw ?? "").trim();
    if (token.length < 20 || token.length > 120 || !token.includes(":")) {
      return {
        ok: false,
        detail: "That doesn't look like a Telegram bot token (it should look like 123456789:AA…). Nothing was stored.",
      };
    }
    try {
      this.deps.vault.add(TELEGRAM_SECRET_NAME, token);
    } catch (e) {
      return { ok: false, detail: `Could not store the token: ${e instanceof Error ? e.message : String(e)}` };
    }
    const s = this.state();
    s.steps.telegram = {
      doneAt: Date.now(),
      detail: "bot token stored in the vault (takes effect on the next control-plane start if the channel isn't already connected)",
    };
    this.save(s);
    return { ok: true, detail: "Telegram bot token is in the vault. It was never written anywhere else." };
  }

  /** Step 3 — provider choice; the key (when any) goes to the vault. */
  provider(payload: Record<string, unknown>): { ok: boolean; detail: string } {
    const provider = String(payload.provider ?? "") as ProviderId;
    if (!PROVIDER_IDS.includes(provider)) {
      return { ok: false, detail: `Unknown provider "${String(payload.provider)}". Nothing was changed.` };
    }
    const model =
      typeof payload.model === "string" && payload.model.trim()
        ? payload.model.trim().slice(0, 100)
        : provider === "stub"
          ? "stub-v0"
          : SUGGESTED_MODELS[provider as Exclude<ProviderId, "stub">];
    const baseUrl =
      typeof payload.baseUrl === "string" && payload.baseUrl.trim()
        ? payload.baseUrl.trim().slice(0, 200)
        : undefined;
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    if ((provider === "anthropic" || provider === "openai" || provider === "gemini") && !apiKey) {
      const keyName = PROVIDER_KEY_NAMES[provider as Exclude<ProviderId, "stub">];
      if (!this.deps.vault.has(keyName)) {
        return {
          ok: false,
          detail: `${provider} needs an API key — paste it here and it goes straight into the vault (or store one under the name "${keyName}" in the Vault section). Nothing was changed.`,
        };
      }
    }
    if (apiKey && provider !== "stub") {
      try {
        this.deps.vault.add(PROVIDER_KEY_NAMES[provider as Exclude<ProviderId, "stub">], apiKey);
      } catch (e) {
        return { ok: false, detail: `Could not store the key: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    writeProviderConfig(this.stateDir, { provider, model, baseUrl });
    const s = this.state();
    s.steps.provider = {
      doneAt: Date.now(),
      provider,
      model,
      detail: `provider=${provider} model=${model}${apiKey ? " (key stored in the vault)" : ""}`,
    };
    this.save(s);
    return {
      ok: true,
      detail:
        provider === "stub"
          ? "Offline stub selected — fine for testing the plumbing; it is not a real model."
          : provider === "gemini"
            ? `Provider saved: gemini / ${model}. Keys live in the vault; the Governor meters every call. ${GEMINI_FREE_TIER_NOTE}`
            : `Provider saved: ${provider} / ${model}. Keys live in the vault; the Governor meters every call.`,
    };
  }

  /** Step 4 — spending caps (defaults pre-filled; numbers validated). */
  caps(payload: Record<string, unknown>): { ok: boolean; detail: string } {
    const num = (v: unknown, fallback: number): number => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) && n > 0 && n <= 100_000 ? n : fallback;
    };
    const patch = {
      maxUsdPerTask: num(payload.maxUsdPerTask, SUGGESTED_CAPS.maxUsdPerTask),
      maxUsdPerDay: num(payload.maxUsdPerDay, SUGGESTED_CAPS.maxUsdPerDay),
      maxUsdPerMonth: num(payload.maxUsdPerMonth, SUGGESTED_CAPS.maxUsdPerMonth),
    };
    this.deps.governor.writeCaps(patch);
    const s = this.state();
    s.steps.caps = {
      doneAt: Date.now(),
      detail: `per task $${patch.maxUsdPerTask} · per day $${patch.maxUsdPerDay} · per month $${patch.maxUsdPerMonth}`,
    };
    this.save(s);
    return {
      ok: true,
      detail: `Caps are set: $${patch.maxUsdPerTask} per task, $${patch.maxUsdPerDay} per day, $${patch.maxUsdPerMonth} per month. Enforced by the Governor, outside the model — the agent cannot change them.`,
    };
  }

  /** Step 5 — the first guided job: the daily digest, live pipeline. */
  firstJob(): { ok: boolean; detail: string; jobId?: string } {
    if (this.deps.governor.isKilled()) {
      return { ok: false, detail: "The kill switch is ON — turn it off (Status → Resume) before running the first job." };
    }
    const jobId = this.deps.runFirstJob();
    const s = this.state();
    s.steps.firstJob = {
      doneAt: Date.now(),
      jobId,
      detail: `digest job ${jobId} created through the live pipeline`,
    };
    this.save(s);
    return {
      ok: true,
      jobId,
      detail: `Your first job (${jobId}) is running: the daily digest, through the gate, the Governor, and verification. Watch it settle under Jobs & receipts.`,
    };
  }
}


