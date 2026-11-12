/**
 * Voice you can test (v0.9.9) — the Settings → Voice test
 * surfaces and the Shield-scan switch's plumbing, pinned.
 *
 *  - probeEndpointDetailed: the call-start probe's full answer
 *    (reachable, latency, model list, model presence) — the
 *    data Test Connection shows. The boolean probeEndpoint the
 *    session resolves modes with is unchanged in behavior.
 *  - The panel routes carry the test: POST /api/voice/
 *    test-connection and /api/voice/test-speech hand the
 *    backend the form's CURRENT values (unsaved), a settings
 *    save carries shieldScan through, and a backend that
 *    doesn't wire the test routes answers 501, never success.
 *  - shieldScan config: default ON; only a literal false turns
 *    it off; anything malformed fails toward ON (scanned).
 *  - The host-level rule: with the switch off, a VOICE message
 *    skips the ingress scan and its delivery stats name the
 *    skip — while a message on another adapter is scanned
 *    exactly as before. The flag cannot leak across channels.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChannelAdapter,
  ChannelEvent,
  OutboundMessage,
} from "../../packages/shared/src/index.js";
import { ChannelHost } from "../../packages/control-plane/src/channel-host.js";
import { Governor } from "../../packages/control-plane/src/governor.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { ApprovalEngine } from "../../packages/control-plane/src/approvals.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";
import { PanelServer, type PanelBackend } from "../../packages/panel/src/index.js";
import {
  VoiceAdapter,
  parseVoiceConfig,
  probeEndpoint,
  probeEndpointDetailed,
  DEFAULT_VOICE_CONFIG,
} from "../../packages/channels/voice/src/index.js";

// ---------------------------------------------------------------- the detailed probe

function modelsFetch(models: string[] | "down" | "garbage"): typeof fetch {
  return (async () => {
    if (models === "down") throw new Error("connection refused");
    if (models === "garbage") return new Response("this is not json", { status: 200 });
    return Response.json({ data: models.map((id) => ({ id })) });
  }) as typeof fetch;
}

test("probe (v0.9.9): reachable, latency measured, configured model present", async () => {
  let t = 1_000;
  const now = () => (t += 40);
  const r = await probeEndpointDetailed(modelsFetch(["whisper-1", "kokoro"]), "http://stt.test/v1", "whisper-1", 5_000, now);
  assert.equal(r.reachable, true);
  assert.equal(r.latencyMs, 40, "latency is the measured round trip, from the injected clock");
  assert.deepEqual(r.models, ["whisper-1", "kokoro"]);
  assert.equal(r.modelPresent, true);
});

test("probe (v0.9.9): reachable but the model is NOT listed — stated, not rounded up", async () => {
  const r = await probeEndpointDetailed(modelsFetch(["kokoro"]), "http://stt.test/v1", "whisper-1");
  assert.equal(r.reachable, true);
  assert.equal(r.modelPresent, false);
  assert.deepEqual(r.models, ["kokoro"]);
});

test("probe (v0.9.9): answered without a readable model list — model presence is null (unverifiable)", async () => {
  const r = await probeEndpointDetailed(modelsFetch("garbage"), "http://stt.test/v1", "whisper-1");
  assert.equal(r.reachable, true);
  assert.equal(r.modelPresent, null);
  assert.deepEqual(r.models, []);
});

test("probe (v0.9.9): unreachable never throws — and the boolean probe still agrees", async () => {
  const r = await probeEndpointDetailed(modelsFetch("down"), "http://stt.test/v1", "whisper-1");
  assert.equal(r.reachable, false);
  assert.equal(r.modelPresent, null);
  assert.equal(await probeEndpoint(modelsFetch("down"), "http://stt.test/v1"), false);
  assert.equal(await probeEndpoint(modelsFetch(["whisper-1"]), "http://stt.test/v1"), true);
  const http500 = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  const r500 = await probeEndpointDetailed(http500, "http://stt.test/v1", "whisper-1");
  assert.equal(r500.reachable, false, "an HTTP error is not reachability");
});

// ---------------------------------------------------------------- shieldScan config

test("voice config (v0.9.9): shieldScan defaults ON — only a literal false turns it off", () => {
  assert.equal(DEFAULT_VOICE_CONFIG.shieldScan, true, "the shipped default is scanned");
  assert.equal(parseVoiceConfig({}).shieldScan, true, "a file without the field is scanned (pre-0.9.9 files included)");
  assert.equal(parseVoiceConfig({ shieldScan: false }).shieldScan, false, "a literal false is the operator's switch");
  assert.equal(parseVoiceConfig({ shieldScan: "no" }).shieldScan, true, "a string is not a switch — fails toward scanned");
  assert.equal(parseVoiceConfig({ shieldScan: 0 }).shieldScan, true, "0 is not false — fails toward scanned");
  assert.equal(parseVoiceConfig(null).shieldScan, true);
});

// ---------------------------------------------------------------- the host rule

class CaptureAdapter implements ChannelAdapter {
  readonly name: string;
  sent: OutboundMessage[] = [];
  private onEvent?: (ev: ChannelEvent) => void;
  constructor(name: string) {
    this.name = name;
  }
  async start(onEvent: (ev: ChannelEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }
  async stop(): Promise<void> {}
  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }
  emit(text: string, conversationId: string): void {
    this.onEvent?.({
      type: "message",
      message: {
        conversationId,
        messageId: `${this.name}-${Math.random()}`,
        senderId: "operator",
        text,
        receivedAt: Date.now(),
      },
    });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 10));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  assert.ok(cond(), `timed out waiting for ${what}`);
}

test("host (v0.9.9): the scan skip is voice-only — other channels are still scanned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-voice-skip-host-"));
  const calls = { n: 0 };
  const gate = {
    scanSurface: async () => {
      calls.n++;
      return { action: "allow", scanned: true, detail: "test verdict: clean" };
    },
  };
  const governor = new Governor(dir, { maxTokensPerJob: 100_000, maxTokensPerDay: 10_000_000 });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const approvals = new ApprovalEngine(dir, () => 120_000);
  const telegram = new CaptureAdapter("telegram");
  const voice = new VoiceAdapter();
  // The switch is OFF (the predicate says so) — the strongest
  // case: even then, only voice may skip.
  const host = new ChannelHost(dir, governor, jobs, [telegram, voice], approvals, gate as never, () => true);
  const pushed: { jobId: string; text: string }[] = [];
  host.attachComm({
    pushUserMessage: (m: { jobId: string; text: string }) => pushed.push(m),
    broadcast: () => {},
    executeApproval: () => {},
  } as never);
  await host.start();

  // A voice turn: submitted through the real adapter, skipped.
  const submitted = voice.submit("hello from a voice turn");
  assert.equal(submitted.ok, true);
  await until(() => pushed.length === 1, "the voice turn to become a job");
  assert.equal(calls.n, 0, "the voice turn was NOT scanned");
  const voiceJobId = pushed[0].jobId;
  host.onModelIssued(voiceJobId, "voice reply");
  await host.onJobFinal(voiceJobId, "voice reply");
  const delivery = await voice.waitForReply(1_000);
  assert.ok(delivery, "the voice reply was delivered");
  assert.equal(delivery.stats?.shieldSkipped, true, "the delivery stats name the skip");
  assert.equal(delivery.stats?.shieldMs, 0, "with shieldMs 0 beside it");

  // A telegram message in the same host, same switch: scanned.
  telegram.emit("hello from telegram", "tg-1");
  await until(() => pushed.length === 2, "the telegram message to become a job");
  assert.equal(calls.n, 1, "the telegram message WAS scanned — the flag cannot leak across channels");
});

// ---------------------------------------------------------------- panel routes

function stubBackend(rec: Record<string, unknown>, wired: boolean): PanelBackend {
  const action = async () => ({ ok: true, detail: "ok" });
  const backend: PanelBackend = {
    status: () => ({
      version: "0.9.9",
      killed: false,
      shield: { provisioned: true, required: true, onUnavailable: "closed", baseUrl: "" },
      provider: { id: "stub", model: "stub-v0" },
      pendingApprovals: 0,
      spendTodayUsd: 0,
      spendMonthUsd: 0,
      governorMode: "enforcing",
      permissiveToday: { count: 0, recent: [] },
      settings: {
        providerKey: "not-required",
        telegramConfigured: false,
        caps: {},
        delegates: 0,
        macWorkDirs: 0,
        approverPolicy: {
          gusApprovesDelegates: false,
          gusApprovesOwn: false,
          delegatesMayApprove: false,
          scope: "bounded",
          maxApprovalsPerHour: 30,
        },
        voice: { enabled: true, configured: true },
      },
    }),
    ledger: () => ({
      entries: [],
      audit: { reserves: 0, settles: 0, refunds: 0, openReservations: 0, settledUsd: 0, reconciles: true },
      summary: { todayUsd: 0, monthUsd: 0, totalUsd: 0, caps: {} },
    }),
    jobs: () => [],
    approvals: () => [],
    approvalsHistory: () => [],
    resolveApproval: action,
    setKilled: action,
    setGovernorMode: action,
    setApproverPolicy: action,
    setShieldPolicy: action,
    settingsDetail: () => ({ macWorkDirs: [], macShellAllowlist: [], delegates: [] }),
    vaultNames: () => [],
    storeSecret: () => ({ ok: true, detail: "ok" }),
    onboarding: () => ({
      steps: {
        shield: { done: false }, telegram: { done: false }, provider: { done: false },
        caps: { done: false }, firstJob: { done: false },
      },
      suggestedCaps: { maxUsdPerTask: 2, maxUsdPerDay: 10, maxUsdPerMonth: 100 },
    }),
    onboardingShield: action,
    onboardingTelegram: action,
    onboardingProvider: action,
    onboardingCaps: action,
    onboardingFirstJob: async () => ({ ok: true, detail: "ok" }),
    skills: () => [],
    installSkill: action,
    submitChat: action,
    chatHistory: () => ({ conversationId: "panel-chat", messages: [], jobs: [] }),
    watchFrame: async () => ({ ok: false as const, detail: "no frame in the stub" }),
    watchTimeline: () => [],
    voiceSettings: () => ({
      enabled: true,
      sttBaseUrl: "http://127.0.0.1:8000/v1",
      sttModel: "whisper-1",
      ttsBaseUrl: "http://127.0.0.1:8880/v1",
      ttsModel: "kokoro",
      ttsVoice: "af_heart",
    }),
    setVoiceSettings: async (s) => {
      rec.savedSettings = s;
      return { ok: true, detail: "voice settings saved" };
    },
    voiceCall: async () => ({ ok: false, kind: "unavailable", detail: "voice is not wired in this stub" }),
    voiceSessionStart: () => ({ ok: false, active: false, detail: "voice sessions are not wired in this stub", turns: [] }),
    voiceSessionAudio: () => ({ ok: false, detail: "voice sessions are not wired in this stub" }),
    voiceSessionTranscript: () => ({ ok: false, detail: "voice sessions are not wired in this stub" }),
    voiceSessionState: () => ({ ok: false, active: false, detail: "voice sessions are not wired in this stub", turns: [] }),
    voiceSessionNextAudio: () => ({ ok: false, detail: "voice sessions are not wired in this stub" }),
    voiceSessionInterrupt: () => ({ ok: false, detail: "voice sessions are not wired in this stub" }),
    voiceSessionEnd: () => ({ ok: false, active: false, detail: "voice sessions are not wired in this stub", turns: [] }),
  };
  if (wired) {
    backend.voiceTestConnection = async (kind, baseUrl, model) => {
      rec.testConnection = { kind, baseUrl, model };
      return {
        ok: true,
        reachable: true,
        latencyMs: 42,
        models: [model],
        modelPresent: true,
        detail: "Reachable in 42 ms.",
      };
    };
    backend.voiceTestSpeech = async (baseUrl, model, voice) => {
      rec.testSpeech = { baseUrl, model, voice };
      return {
        ok: true,
        detail: "Synthesized.",
        audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
        audioContentType: "audio/mpeg",
      };
    };
  }
  return backend;
}

test("panel routes (v0.9.9): test-connection and test-speech carry the form's current values; settings carry shieldScan", async () => {
  const rec: Record<string, unknown> = {};
  const panel = new PanelServer(stubBackend(rec, true), { token: "test-token-123", port: 0 });
  await panel.start();
  try {
    const base = `http://127.0.0.1:${panel.port}`;
    const AUTH = { authorization: "Bearer " + "test-token-123", "content-type": "application/json" };

    const noAuth = await fetch(`${base}/api/voice/test-connection`, { method: "POST", body: "{}" });
    assert.equal(noAuth.status, 401, "the test routes sit behind the operator token like every route");

    const conn = await fetch(`${base}/api/voice/test-connection`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ kind: "stt", baseUrl: "http://192.0.2.10:8000/v1", model: "Systran/faster-whisper-base" }),
    });
    assert.equal(conn.status, 200);
    const connBody = (await conn.json()) as { ok: boolean; reachable: boolean; modelPresent: boolean | null };
    assert.equal(connBody.ok, true);
    assert.equal(connBody.reachable, true);
    assert.equal(connBody.modelPresent, true);
    assert.deepEqual(
      rec.testConnection,
      { kind: "stt", baseUrl: "http://192.0.2.10:8000/v1", model: "Systran/faster-whisper-base" },
      "the backend got the form's unsaved values verbatim",
    );

    const speech = await fetch(`${base}/api/voice/test-speech`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ baseUrl: "http://192.0.2.10:8880/v1", model: "kokoro", voice: "af_heart" }),
    });
    assert.equal(speech.status, 200);
    const speechBody = (await speech.json()) as { ok: boolean; audioBase64?: string };
    assert.equal(speechBody.ok, true);
    assert.ok(speechBody.audioBase64, "the synthesized test sentence came back as audio");
    assert.deepEqual(rec.testSpeech, { baseUrl: "http://192.0.2.10:8880/v1", model: "kokoro", voice: "af_heart" });

    const save = await fetch(`${base}/api/voice/settings`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        enabled: true,
        sttBaseUrl: "http://127.0.0.1:8000/v1",
        sttModel: "whisper-1",
        ttsBaseUrl: "http://127.0.0.1:8880/v1",
        ttsModel: "kokoro",
        ttsVoice: "af_heart",
        shieldScan: false,
      }),
    });
    assert.equal(save.status, 200);
    const saved = rec.savedSettings as { shieldScan?: boolean };
    assert.equal(saved.shieldScan, false, "a settings save carries shieldScan to the backend — the switch is real, not decorative");
  } finally {
    await panel.stop();
  }
});

test("panel routes (v0.9.9): a backend without the test wiring answers 501, never a fake success", async () => {
  const rec: Record<string, unknown> = {};
  const panel = new PanelServer(stubBackend(rec, false), { token: "test-token-123", port: 0 });
  await panel.start();
  try {
    const base = `http://127.0.0.1:${panel.port}`;
    const AUTH = { authorization: "Bearer " + "test-token-123", "content-type": "application/json" };
    const conn = await fetch(`${base}/api/voice/test-connection`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ kind: "stt", baseUrl: "http://x/v1", model: "m" }),
    });
    assert.equal(conn.status, 501);
    const body = (await conn.json()) as { ok: boolean; reachable: boolean };
    assert.equal(body.ok, false);
    assert.equal(body.reachable, false);
  } finally {
    await panel.stop();
  }
});
