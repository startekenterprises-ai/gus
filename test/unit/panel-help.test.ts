/**
 * Panel help system (v0.5.1) — one registry, two surfaces.
 *
 * What is pinned here:
 *  - The registry covers every setting Glenn named: governor mode,
 *    the kill switch, the five delegation controls, the three spend
 *    caps, provider and model — each with a tip and a docs body.
 *  - The panel page renders a "?" marker per covered setting,
 *    carrying the registry tip, and "Settings on file" renders
 *    FIRST — directly under the header, before the Status section.
 *  - Every marker's id resolves to an anchor on the /help page
 *    (the pop-up's "More in Help" link can never 404 its target).
 *  - /help sits behind the same operator-token auth as every other
 *    panel route.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HELP_BY_ID,
  HELP_ENTRIES,
  HELP_HTML,
  escapeHtml,
} from "../../packages/panel/src/help.js";
import { PANEL_HTML } from "../../packages/panel/src/page.js";
import { PanelServer } from "../../packages/panel/src/server.js";
import type { PanelBackend } from "../../packages/panel/src/types.js";

const REQUIRED_IDS = [
  "kill-switch",
  "governor-mode",
  "approval-delegation",
  "del-gus-delegates",
  "del-gus-own",
  "del-delegates",
  "del-scope",
  "del-max-approvals",
  "provider",
  "model",
  "cap-per-task",
  "cap-per-day",
  "cap-per-month",
];

test("help registry: covers the required settings, ids unique, every entry complete", () => {
  const ids = HELP_ENTRIES.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  for (const id of REQUIRED_IDS) {
    const entry = HELP_BY_ID.get(id);
    assert.ok(entry, `registry is missing ${id}`);
    assert.ok(entry.title.length > 0, `${id} needs a title`);
    assert.ok(entry.tip.length > 20, `${id} needs a real tip`);
    assert.ok(entry.body.length > entry.tip.length, `${id} body should say more than its tip`);
  }
});

test("help registry: floors are stated honestly in the delegation copy", () => {
  const scope = HELP_BY_ID.get("del-scope");
  assert.ok(scope);
  assert.match(scope.body, /never delegable/);
  assert.match(scope.body, /git push/);
  const own = HELP_BY_ID.get("del-gus-own");
  assert.ok(own);
  assert.match(own.tip, /only self-approval path/);
  const task = HELP_BY_ID.get("cap-per-task");
  assert.ok(task);
  assert.match(task.tip, /no prompt, approval, or delegation can raise it/);
});

test("panel page: a help marker with the registry tip rides beside each covered setting", () => {
  for (const id of REQUIRED_IDS) {
    assert.ok(PANEL_HTML.includes(`data-help="${id}"`), `page has no marker for ${id}`);
    const entry = HELP_BY_ID.get(id);
    assert.ok(entry);
    assert.ok(
      PANEL_HTML.includes(`data-tip="${escapeHtml(entry.tip)}"`),
      `page does not carry the registry tip for ${id}`,
    );
  }
  assert.ok(PANEL_HTML.includes('href="/help"'), "page links to the help page");
  assert.ok(PANEL_HTML.includes('id="helppop"'), "page has the pop-up card");
});

test("panel page: Settings on file renders first, directly under the header", () => {
  const settingsAt = PANEL_HTML.indexOf("Settings on file");
  assert.ok(settingsAt > 0, "settings section exists");
  assert.ok(settingsAt < PANEL_HTML.indexOf("<h2>Status</h2>"), "settings precede the Status section");
  assert.ok(settingsAt < PANEL_HTML.indexOf("Kill switch"), "settings precede the status rows");
  assert.ok(settingsAt < PANEL_HTML.indexOf("Approvals waiting"), "settings precede approvals");
  // Exactly once — the move must not duplicate the section.
  assert.equal(PANEL_HTML.split("Settings on file").length - 1, 1);
  assert.equal(PANEL_HTML.split('id="settings-on-file"').length - 1, 1);
});

test("help page: every marker id resolves to an anchor; every entry is printed", () => {
  const markerIds = [...PANEL_HTML.matchAll(/data-help="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(markerIds.length >= REQUIRED_IDS.length);
  for (const id of new Set(markerIds)) {
    assert.ok(HELP_HTML.includes(`id="${id}"`), `/help has no anchor for marker ${id}`);
  }
  for (const entry of HELP_ENTRIES) {
    assert.ok(HELP_HTML.includes(`id="${entry.id}"`), `/help missing section ${entry.id}`);
    assert.ok(HELP_HTML.includes(escapeHtml(entry.title)), `/help missing title ${entry.id}`);
  }
});

function stubBackend(): PanelBackend {
  const action = async () => ({ ok: true, detail: "ok" });
  return {
    status: () => ({
      version: "0.5.1",
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
      },
    }),
    ledger: () => ({
      entries: [],
      audit: { reserves: 0, settles: 0, refunds: 0, openReservations: 0, settledUsd: 0, reconciles: true },
      summary: { todayUsd: 0, monthUsd: 0, totalUsd: 0, caps: {} },
    }),
    jobs: () => [],
    approvals: () => [],
    resolveApproval: action,
    setKilled: action,
    setGovernorMode: action,
    setApproverPolicy: action,
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
  };
}

test("panel server: /help requires the operator token and serves the docs", async () => {
  const panel = new PanelServer(stubBackend(), { token: "test-token-123", port: 0 });
  await panel.start();
  try {
    const base = `http://127.0.0.1:${panel.port}`;
    const noAuth = await fetch(`${base}/help`);
    assert.equal(noAuth.status, 401, "/help without a token is refused");
    const badAuth = await fetch(`${base}/help`, {
      headers: { authorization: "Bearer wrong-token-999" },
    });
    assert.equal(badAuth.status, 401);
    const ok = await fetch(`${base}/help`, {
      headers: { authorization: "Bearer test-token-123" },
    });
    assert.equal(ok.status, 200);
    const html = await ok.text();
    assert.match(html, /GUS help &amp; docs/);
    assert.ok(html.includes('id="governor-mode"'));
    assert.ok(html.includes('id="cap-per-month"'));
    assert.match(html, /never delegable/);
  } finally {
    await panel.stop();
  }
});
