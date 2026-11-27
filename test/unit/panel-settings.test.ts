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
 *  - GET /api/gmail-cleanup/batches/<id> (v0.17.8, cleanup chunk
 *    4) serves one cleanup batch's full record — the tap-through
 *    behind the morning report. Read-only: writes on the path
 *    404 without reaching the backend; an unwired backend
 *    answers 501; an unknown batch answers 404.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_ENTRIES } from "../../packages/panel/src/help.js";
import { PanelServer } from "../../packages/panel/src/server.js";
import type {
  PanelBackend,
  PanelGmailCleanupBatchData,
  PanelShieldPolicyData,
} from "../../packages/panel/src/types.js";

/** The chunk-4 cleanup batch fixture the stub backend serves. */
const CLEANUP_BATCH_FIXTURE: PanelGmailCleanupBatchData = {
  batchId: "cleanup-fixture-1",
  jobId: "gmail-cleanup-cleanup-fixture-1",
  receiptId: "rcpt_fixture",
  status: "verified-done",
  startedAt: 1795185000000,
  finishedAt: 1795185060000,
  ruleFileHash: "fixturehash",
  cap: 200,
  counts: { total: 1, done: 1, failed: 0, skippedStale: 0, undone: 0 },
  plan: null,
  entries: [
    {
      id: "m1",
      threadId: "t1",
      from: "deals@shop.example",
      subject: "Big sale",
      date: "Thu, 01 Oct 2026 10:00:00 GMT",
      priorLabelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      rule: "promos>30d",
      state: "done",
    },
  ],
};

function stubBackend(calls: string[], opts?: { wireCleanupBatch?: boolean }): PanelBackend {
  const action = async () => ({ ok: true, detail: "ok" });
  const backend: PanelBackend = {
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
    chatSync: () => ({ deviceId: "test-core", missing: [], wantIds: [], conflicts: 0 }),
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
    voiceSessionStart: () => ({ ok: false, active: false, detail: "voice sessions are not wired in this stub", turns: [] }),
    voiceSessionAudio: () => ({ ok: false, detail: "voice sessions are not wired in this stub" }),
    voiceSessionTranscript: () => ({ ok: false, detail: "voice sessions are not wired in this stub" }),
    voiceSessionState: () => ({ ok: false, active: false, detail: "voice sessions are not wired in this stub", turns: [] }),
    voiceSessionNextAudio: () => ({ ok: false, detail: "voice sessions are not wired in this stub" }),
    voiceSessionInterrupt: () => ({ ok: false, detail: "voice sessions are not wired in this stub" }),
    voiceSessionEnd: () => ({ ok: false, active: false, detail: "voice sessions are not wired in this stub", turns: [] }),
  };
  if (opts?.wireCleanupBatch !== false) {
    backend.gmailCleanupBatch = (batchId: string) => {
      calls.push(`cleanupBatch:${batchId}`);
      return batchId === CLEANUP_BATCH_FIXTURE.batchId ? CLEANUP_BATCH_FIXTURE : null;
    };
  }
  return backend;
}

async function withPanel(
  fn: (base: string, calls: string[]) => Promise<void>,
  opts?: { wireCleanupBatch?: boolean },
): Promise<void> {
  const calls: string[] = [];
  const panel = new PanelServer(stubBackend(calls, opts), { token: "test-token-123", port: 0 });
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

test("GET /api/gmail-cleanup/batches/<id>: token-gated; returns the batch record; unknown batch 404s", async () => {
  await withPanel(async (base, calls) => {
    const noAuth = await fetch(`${base}/api/gmail-cleanup/batches/cleanup-fixture-1`);
    assert.equal(noAuth.status, 401);
    assert.deepEqual(calls, [], "an unauthenticated call must never reach the backend");

    const res = await fetch(`${base}/api/gmail-cleanup/batches/cleanup-fixture-1`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = (await res.json()) as PanelGmailCleanupBatchData;
    assert.deepEqual(body, CLEANUP_BATCH_FIXTURE);
    assert.deepEqual(calls, ["cleanupBatch:cleanup-fixture-1"]);

    const missing = await fetch(`${base}/api/gmail-cleanup/batches/nope`, { headers: AUTH });
    assert.equal(missing.status, 404);
    const missingBody = (await missing.json()) as { ok: boolean; detail: string };
    assert.equal(missingBody.ok, false);
    assert.match(missingBody.detail, /no gmail cleanup batch "nope"/);
  });
});

test("the cleanup batch route is read-only: writes are refused and never reach the backend", async () => {
  await withPanel(async (base, calls) => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(`${base}/api/gmail-cleanup/batches/cleanup-fixture-1`, {
        method,
        headers: { ...AUTH, "content-type": "application/json" },
        body: method === "DELETE" ? undefined : JSON.stringify({ state: "undone" }),
      });
      assert.equal(res.status, 404, `${method} on the batch path must not exist`);
    }
    assert.deepEqual(calls, [], "no write attempt reached the backend");
  });
});

test("GET /api/gmail-cleanup/batches/<id>: an unwired backend answers 501, never a fake record", async () => {
  await withPanel(
    async (base) => {
      const res = await fetch(`${base}/api/gmail-cleanup/batches/cleanup-fixture-1`, { headers: AUTH });
      assert.equal(res.status, 501);
      const body = (await res.json()) as { ok: boolean; detail: string };
      assert.equal(body.ok, false);
      assert.match(body.detail, /aren't wired/);
    },
    { wireCleanupBatch: false },
  );
});
