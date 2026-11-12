/**
 * Panel settings APIs (v0.8) — the desktop app's Settings window
 * rides on three additions, pinned here:
 *
 *  - GET /api/help serves the v0.5.1 help registry as JSON: the
 *    SAME entries the web panel's pop-ups and /help page render
 *    from, so the app's native pop-overs can never drift from the
 *    docs. Behind the operator token, like every route.
 *  - GET /api/settings-detail returns the settings detail the
 *    status summary only counts (Mac jail contents, named
 *    delegates, bridge binding) — read-only.
 *  - POST /api/shield-policy carries the Shield gate's operator
 *    policy (required + fail mode) to the backend, normalized the
 *    same way the approver-policy route normalizes its payload.
 *    Provisioning is NOT this route's job — it stays with the
 *    onboarding shield step.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_ENTRIES } from "../../packages/panel/src/help.js";
import { PanelServer } from "../../packages/panel/src/server.js";
import type {
  PanelBackend,
  PanelShieldPolicyData,
} from "../../packages/panel/src/types.js";

function stubBackend(calls: string[]): PanelBackend {
  const action = async () => ({ ok: true, detail: "ok" });
  return {
    status: () => ({
      version: "0.9.0",
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
        delegates: 1,
        macWorkDirs: 1,
        approverPolicy: {
          gusApprovesDelegates: false,
          gusApprovesOwn: false,
          delegatesMayApprove: false,
          scope: "bounded",
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
    approvals: () => [],
    approvalsHistory: () => [],
    resolveApproval: action,
    setKilled: action,
    setGovernorMode: action,
    setApproverPolicy: action,
    setShieldPolicy: async (p: PanelShieldPolicyData) => {
      calls.push(`shield:${p.required}:${p.onUnavailable}`);
      return { ok: true, detail: "shield policy set" };
    },
    settingsDetail: () => ({
      macWorkDirs: ["/Users/op/work"],
      macShellAllowlist: ["ls", "git status"],
      delegates: [
        {
          conversationId: "-1001",
          operatorId: "42",
          delegates: [{ name: "Nova", senderId: "99" }],
        },
      ],
      bridge: { conversationId: "-1001", senderId: "99" },
    }),
    vaultNames: () => [],
    storeSecret: () => ({ ok: true, detail: "ok" }),
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
      enabled: false,
      sttBaseUrl: "http://127.0.0.1:8000/v1",
      sttModel: "whisper-1",
      ttsBaseUrl: "http://127.0.0.1:8880/v1",
      ttsModel: "kokoro",
      ttsVoice: "af_heart",
    }),
    setVoiceSettings: action,
    voiceCall: async () => ({ ok: false, kind: "unavailable", detail: "voice is not wired in this stub" }),
  };
}

async function withPanel(fn: (base: string, calls: string[]) => Promise<void>): Promise<void> {
  const calls: string[] = [];
  const panel = new PanelServer(stubBackend(calls), { token: "test-token-123", port: 0 });
  await panel.start();
  try {
    await fn(`http://127.0.0.1:${panel.port}`, calls);
  } finally {
    await panel.stop();
  }
}

const AUTH = { authorization: "Bearer test-token-123" };

test("GET /api/help: token-gated; serves the registry verbatim", async () => {
  await withPanel(async (base) => {
    const noAuth = await fetch(`${base}/api/help`);
    assert.equal(noAuth.status, 401);
    const res = await fetch(`${base}/api/help`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: typeof HELP_ENTRIES };
    assert.equal(body.entries.length, HELP_ENTRIES.length);
    // The registry is the single source: ids, tips, and bodies match
    // the module the web surfaces render from, entry for entry.
    assert.deepEqual(
      body.entries.map((e) => e.id),
      HELP_ENTRIES.map((e) => e.id),
    );
    for (const entry of body.entries) {
      assert.ok(entry.title.length > 0);
      assert.ok(entry.tip.length > 0);
      assert.ok(entry.body.length > entry.tip.length);
    }
    const scope = body.entries.find((e) => e.id === "del-scope");
    assert.ok(scope);
    assert.match(scope.body, /never delegable/);
  });
});

test("GET /api/settings-detail: token-gated; returns jail + delegates + bridge", async () => {
  await withPanel(async (base) => {
    const noAuth = await fetch(`${base}/api/settings-detail`);
    assert.equal(noAuth.status, 401);
    const res = await fetch(`${base}/api/settings-detail`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      macWorkDirs: string[];
      macShellAllowlist: string[];
      delegates: { conversationId: string; delegates: { name: string }[] }[];
      bridge?: { conversationId: string };
    };
    assert.deepEqual(body.macWorkDirs, ["/Users/op/work"]);
    assert.deepEqual(body.macShellAllowlist, ["ls", "git status"]);
    assert.equal(body.delegates.length, 1);
    assert.equal(body.delegates[0].delegates[0].name, "Nova");
    assert.equal(body.bridge?.conversationId, "-1001");
  });
});

test("POST /api/shield-policy: token-gated; normalized payload reaches the backend", async () => {
  await withPanel(async (base, calls) => {
    const noAuth = await fetch(`${base}/api/shield-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ required: false, onUnavailable: "open" }),
    });
    assert.equal(noAuth.status, 401);
    assert.deepEqual(calls, [], "an unauthenticated call must never reach the backend");

    const res = await fetch(`${base}/api/shield-policy`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ required: false, onUnavailable: "open" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; detail: string };
    assert.equal(body.ok, true);
    assert.deepEqual(calls, ["shield:false:open"]);

    // A non-boolean `required` normalizes to false (only JSON true
    // counts), and a missing fail mode crosses as "" for the
    // backend to refuse — the route never invents a policy.
    const res2 = await fetch(`${base}/api/shield-policy`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ required: "yes" }),
    });
    assert.equal(res2.status, 200);
    assert.deepEqual(calls, ["shield:false:open", "shield:false:"]);
  });
});
