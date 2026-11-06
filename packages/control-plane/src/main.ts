/**
 * Control plane entrypoint.
 *
 * Env:
 *   GUS_STATE_DIR     durable state (ledger, jobs, receipts, kill flag)
 *   GUS_COMM_SOCKET   unix socket path inside the shared comm volume
 *   GUS_CHANNEL       "fake-file" (Phase 0 harness) | "telegram"
 *   GUS_FAKE_INBOUND / GUS_FAKE_OUTBOUND   fake transport files
 *   GUS_TELEGRAM_BOT_TOKEN                 telegram channel credential
 *   GUS_TELEGRAM_TRANSPORT "botapi" (default when channel=telegram)
 *   GUS_VAULT_KEY_FILE  host key for the Vault Broker
 *                       (default: <state>/vault.key, created 0600)
 *   GUS_EGRESS_POLICY   egress allowlist + injection bindings
 *                       (default: <state>/egress-policy.json; a missing
 *                       file is a deny-all policy, by design)
 *   GUS_POLICY          approval policy file (default:
 *                       <state>/policy.json; a missing file is the
 *                       strict built-in policy, by design)
 *   Governor caps:      <state>/governor.json (re-read per call; a
 *                       missing file is the conservative default caps)
 *   Phase 3 (Updater):  GUS_INSTALL_DIR (default /install; the slot
 *                       pointer there is what makes updates available),
 *                       GUS_RELEASES_DIR (default <state>/releases —
 *                       release bundles are read from <dir>/<version>/),
 *                       GUS_UPDATE_PUBKEY (default <state>/update-pubkey.pem;
 *                       no pinned key = updates refuse, by design)
 *
 * Operator vault admin (never reachable from the sandbox):
 *   node main.js vault-admin <add <name> <value|->|list|remove <name>>
 * runs against the state dir and exits before any server starts.
 * Phase 6 (Gmail pack): node main.js gmail-admin <status|revoke>
 * likewise; the pack's OAuth credential is the vault secret
 * "gmail-oauth" (docs/gmail-pack.md), its learned directory is
 * <state>/gmail-directory.json.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { ChannelAdapter } from "@gus/shared";
import { GUS_VERSION } from "@gus/shared";
import { LocalReceiptIssuer, ShieldClient, ShieldGate } from "@gus/gate";
import { VaultBroker } from "@gus/vault";
import { EgressProxy } from "@gus/egress";
import { PanelServer, type PanelBackend } from "@gus/panel";
import { Governor } from "./governor.js";
import { JobRunner } from "./jobs.js";
import { CommServer } from "./comm-server.js";
import { ChannelHost } from "./channel-host.js";
import { PolicyStore } from "./policy.js";
import { ApprovalEngine } from "./approvals.js";
import { Updater } from "./updater.js";
import { runVaultAdmin } from "./vault-admin.js";
import { loadProviderConfig, resolveProvider } from "./providers.js";
import { GmailDirectory, GmailService, HttpGmailTransport, runGmailAdmin } from "./gmail.js";
import { MacService } from "./mac.js";
import { createMacHostAdapter } from "./mac-native.js";
import { Onboarding, DIGEST_PROMPT } from "./onboarding.js";
import { resolveChannelAdapter } from "./channel-setup.js";
import { BridgeInboxAdapter } from "./bridge-inbox.js";
import { loadDelegates } from "./delegates.js";
import {
  loadGovernorMode,
  readPermissiveActions,
  writeGovernorMode,
} from "./governor-mode.js";
import { loadApproverPolicy, writeApproverPolicy } from "./approver-policy.js";
import { SkillInstaller } from "./skills.js";
import { startHeartbeat } from "./heartbeat.js";

const stateDir = process.env.GUS_STATE_DIR ?? "/state";
const socketPath = process.env.GUS_COMM_SOCKET ?? "/comm/gus.sock";
mkdirSync(stateDir, { recursive: true });

const vault = new VaultBroker(
  `${stateDir}/vault.json`,
  process.env.GUS_VAULT_KEY_FILE ?? `${stateDir}/vault.key`,
);

if (process.argv[2] === "vault-admin") {
  process.exit(runVaultAdmin(process.argv.slice(3), vault));
}

// Phase 6: the Gmail pack's learned directory (known correspondents +
// blocked senders). Constructed before the gmail-admin branch so the
// CLI can report/revoke against the same file the service maintains.
const gmailDirectory = new GmailDirectory(`${stateDir}/gmail-directory.json`);

if (process.argv[2] === "gmail-admin") {
  process.exit(runGmailAdmin(process.argv.slice(3), vault, gmailDirectory));
}

const governor = new Governor(stateDir);
const receipts = new LocalReceiptIssuer(`${stateDir}/receipt-stub.key`);
const jobs = new JobRunner(stateDir, receipts);

// Phase 1: the egress proxy — the sandbox's only path outside, executed
// here in the control plane. The vault is handed to the proxy (injection
// happens in this process's memory) and to nothing else.
const egress = new EgressProxy({
  vault,
  policyPath: process.env.GUS_EGRESS_POLICY ?? `${stateDir}/egress-policy.json`,
  logPath: `${stateDir}/egress.jsonl`,
  receiptsPath: `${stateDir}/egress-receipts.jsonl`,
  issuer: receipts,
});

/** The control plane's runtime log: JSON lines in the state dir —
 *  the same shape the panel-binding and boot-sweep entries below use. */
function runtimeLog(level: "info" | "warn" | "error", text: string): void {
  appendFileSync(
    `${stateDir}/runtime-log.jsonl`,
    JSON.stringify({ ts: Date.now(), level, text }) + "\n",
  );
}

// Channel resolution (channel-setup.ts): telegram WITH a token — env
// first, the vault's "telegram-bot" secret (stored by the panel's
// setup wizard) as fallback — is a live TelegramAdapter, exactly as
// before. Telegram with NO token yet no longer throws: startup
// continues with an unconfigured stand-in adapter and one loud
// warning, so the setup panel binds and the first-run wizard can
// store the token. (The throw crash-looped fresh installs under the
// Mac app's launchd KeepAlive before the panel ever came up — the
// panel is the only place the token can be stored, so throwing made
// onboarding impossible without CLI knowledge.)
const channelKind = process.env.GUS_CHANNEL ?? "fake-file";
const adapter: ChannelAdapter = resolveChannelAdapter({
  channelKind,
  envToken: process.env.GUS_TELEGRAM_BOT_TOKEN,
  fakeInbound: process.env.GUS_FAKE_INBOUND,
  fakeOutbound: process.env.GUS_FAKE_OUTBOUND,
  readVaultSecret: (name) => vault.withSecret(name, (v) => v),
  log: runtimeLog,
}).adapter;

// Phase 2: the Approval Engine + policy store. Policy is re-read from
// its file on every classification; approval timeouts come from the
// same file, re-read at creation time. Expiry settles parked jobs via
// the host (timeout = deny, failed-loudly, receipted).
const policy = new PolicyStore(process.env.GUS_POLICY ?? `${stateDir}/policy.json`, {
  gmailDirectoryPath: `${stateDir}/gmail-directory.json`,
});
const approvals = new ApprovalEngine(stateDir, () => policy.load().approvalTimeoutMs);

// Phase 4: the Agent-Shield gate (spec §1.7). The API key lives in
// the vault; before onboarding provisions one, the gate is inert
// unless policy requires it — then it fails closed and says so. The
// base URL is config (GUS_SHIELD_BASE_URL) so drills can point the
// identical wiring at a stand-in when the live API is unreachable.
const shieldGate = new ShieldGate({
  client: new ShieldClient({ vault, baseUrl: process.env.GUS_SHIELD_BASE_URL }),
  policy: () => policy.shieldPolicy(),
  logPath: `${stateDir}/gate.jsonl`,
  // v0.4: the Governor mode (governor-mode.ts) — re-read per scan.
  mode: () => loadGovernorMode(stateDir),
});

// Phase 6: the Gmail pack. Executes in this process (like the egress
// proxy): the OAuth credential stays in the vault, inbound mail is
// Shield-scanned before it can reach the model, outbound mail passes
// the secret-guard, and the classifier reads the same directory file
// this service maintains. Until the operator stores a "gmail-oauth"
// secret, every pack call fails loudly with the setup pointer.
const gmail = new GmailService(new HttpGmailTransport(vault), {
  directory: gmailDirectory,
  shield: shieldGate,
  vault,
});

// Phase 7: the Mac-control pack. Executes in this process (like the
// Gmail pack): the classifier applies the Nova Always/Once model, the
// service enforces the fs/shell jail from the policy's mac section,
// and every executed action verifies its post-condition against the
// host. Phase 8: the host adapter is the native bridge when the
// GusMacHost helper is present on this host. The wiring resolves
// lazily, per call (mac-native.ts): a helper that appears after this
// process booted is picked up on the next mac_* call, and until one
// exists the unavailable adapter refuses every mac_* execution
// plainly and loudly, exactly as before.
const mac = new MacService(createMacHostAdapter(), {
  workDirs: () => policy.load().mac.workDirs,
  shield: shieldGate,
  vault,
});

// Phase 10: the Bridge Inbox — file-based delegate ingress (Telegram
// never delivers bot-to-bot messages, so Nova's requests arrive as
// files; bridge-inbox.ts). Inert without a `bridge` binding in
// delegates.json. Its outbound forwards through the primary adapter,
// and results/approvals post via adapters[0] as usual.
const bridge = new BridgeInboxAdapter(stateDir, {
  sendVia: (msg) => adapter.send(msg),
});
const host = new ChannelHost(stateDir, governor, jobs, [adapter, bridge], approvals, shieldGate);
approvals.onExpire = (req) => host.handleApprovalExpired(req);
const comm = new CommServer(socketPath, governor, jobs, {
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
  logRuntime: (level, text) =>
    appendFileSync(`${stateDir}/runtime-log.jsonl`, JSON.stringify({ ts: Date.now(), level, text }) + "\n"),
}, policy, approvals, egress, shieldGate, () => resolveProvider(stateDir, vault), gmail, mac, () => loadGovernorMode(stateDir), () => loadApproverPolicy(stateDir));
host.attachComm(comm);

// Phase 3: the Updater. Constructed always (its queries power
// /version), but the pipeline only runs in a slots layout — with no
// install pointer (the legacy flat containers of Phases 0–2) begin()
// refuses plainly. Promotion restarts THIS process via requestSelfExit:
// the slot launcher boots whatever the pointer names.
const updater = new Updater(
  stateDir,
  process.env.GUS_INSTALL_DIR ?? "/install",
  process.env.GUS_RELEASES_DIR ?? `${stateDir}/releases`,
  process.env.GUS_UPDATE_PUBKEY ?? `${stateDir}/update-pubkey.pem`,
  dirname(socketPath),
  jobs,
  governor,
  approvals,
  policy,
  comm,
  egress,
);
updater.bindHost({
  notify: (conversationId, text) => host.notifyOperator(conversationId, text),
  requestSelfExit: () => {
    // Give the just-sent notice a beat to land, then exit cleanly;
    // the launcher starts the pointer's slot.
    setTimeout(() => process.exit(0), 300);
  },
  pushConfirmationJob: (conversationId) => host.runSystemJob(conversationId, "hello — update confirmation check"),
});
host.bindUpdateCommands({
  startUpdate: (conversationId, version) => {
    const job = jobs.create("update", conversationId, `update to ${version}`);
    jobs.transition(job.id, "running");
    return updater.begin(job.id, version, conversationId);
  },
  // v0.4: stage the latest APP release for the one-click installer.
  // Only metadata crosses here — release tag, DMG URL, and the
  // published sha256 — into pending-update.json; the app downloads
  // and verifies before it swaps anything.
  stageUpdate: async () => {
    const isNewer = (a: string, b: string): boolean => {
      const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
      const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y) return x > y;
      }
      return false;
    };
    const res = await fetch("https://api.github.com/repos/startekenterprises-ai/gus/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": "gus-control-plane" },
    });
    if (!res.ok) return `Couldn't reach GitHub releases (HTTP ${res.status}). Nothing staged.`;
    const rel = (await res.json()) as {
      tag_name?: string;
      assets?: { name: string; browser_download_url: string }[];
    };
    const version = (rel.tag_name ?? "").replace(/^v/, "");
    if (!version) return "The latest release has no version tag. Nothing staged.";
    if (!isNewer(version, GUS_VERSION)) {
      return `Already current — this GUS is v${GUS_VERSION} and the latest release is v${version}. Nothing staged.`;
    }
    const dmg = rel.assets?.find((a) => a.name.endsWith(".dmg"));
    const shaAsset = rel.assets?.find((a) => a.name.endsWith(".dmg.sha256"));
    if (!dmg || !shaAsset) return `Release v${version} has no DMG + checksum attached yet. Nothing staged.`;
    const shaRes = await fetch(shaAsset.browser_download_url);
    if (!shaRes.ok) return `Couldn't fetch the release checksum (HTTP ${shaRes.status}). Nothing staged.`;
    const sha256 = (await shaRes.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!/^[0-9a-f]{64}$/.test(sha256)) return "The release checksum file didn't contain a sha256. Nothing staged.";
    writeFileSync(
      `${stateDir}/pending-update.json`,
      JSON.stringify(
        { version, dmgUrl: dmg.browser_download_url, sha256, stagedBy: "control-plane", ts: Date.now() },
        null,
        2,
      ) + "\n",
    );
    return (
      `📦 Update staged: GUS v${version} (this GUS is v${GUS_VERSION}). ` +
      `Install it from the GUS.app menu — "Install Staged Update" — it downloads, verifies the sha256, swaps, and relaunches. ` +
      `Vault, policy, jobs and receipts are never touched by an update.`
    );
  },
  versionText: () => {
    const { pointer, runtimeVersion } = updater.versionInfo();
    return (
      `GUS control plane v${GUS_VERSION} · agent runtime v${runtimeVersion ?? "(not connected)"}` +
      (pointer ? ` · slot ${pointer.slot} live (v${pointer.version})` : " · flat layout (no install slots)")
    );
  },
});

// Phase 4: onboarding service + skill installer + the operator
// panel. The panel backend delegates EVERYTHING to the engines above
// — approvals resolve through ChannelHost.resolveApproval (the same
// hash-bound path as Telegram buttons), the kill switch is the
// Governor's flag, secrets go vault.add() and are never read back.
const onboarding = new Onboarding(stateDir, {
  vault,
  gate: shieldGate,
  policy,
  governor,
  runFirstJob: () => host.runSystemJob("onboarding", DIGEST_PROMPT, "digest"),
});
const skillInstaller = new SkillInstaller(stateDir);

function shieldVerifyUrls(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const logPath = `${stateDir}/gate.jsonl`;
    if (!existsSync(logPath)) return map;
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { receipt?: { receiptId?: string; verifyUrl?: string } };
        if (r.receipt?.receiptId && r.receipt.verifyUrl) map.set(r.receipt.receiptId, r.receipt.verifyUrl);
      } catch { /* skip torn lines */ }
    }
  } catch { /* no gate log yet */ }
  return map;
}

const panelBackend: PanelBackend = {
  status: () => {
    const cfg = loadProviderConfig(stateDir);
    const spend = governor.spendSummary();
    const sp = policy.shieldPolicy();
    return {
      version: GUS_VERSION,
      killed: governor.isKilled(),
      shield: {
        provisioned: shieldGate.provisioned(),
        required: sp.required,
        onUnavailable: sp.onUnavailable,
        baseUrl: shieldGate.client.baseUrl,
      },
      provider: { id: cfg.provider, model: cfg.model },
      pendingApprovals: approvals.pending().length,
      spendTodayUsd: spend.todayUsd,
      spendMonthUsd: spend.monthUsd,
      settings: (() => {
        const names = vault.listNames();
        const keyNameByProvider: Record<string, string> = {
          gemini: "gemini",
          openai: "openai",
          anthropic: "anthropic",
        };
        const keyName = keyNameByProvider[cfg.provider];
        const caps = governor.config();
        return {
          providerKey: (keyName
            ? names.includes(keyName)
              ? "stored"
              : "missing"
            : "not-required") as "stored" | "missing" | "not-required",
          telegramConfigured: names.includes("telegram-bot"),
          caps: {
            maxUsdPerTask: caps.maxUsdPerTask,
            maxUsdPerDay: caps.maxUsdPerDay,
            maxUsdPerMonth: caps.maxUsdPerMonth,
          },
          delegates: Object.values(loadDelegates(stateDir).conversations).reduce(
            (n, c) => n + c.delegates.length,
            0,
          ),
          macWorkDirs: policy.load().mac.workDirs.length,
          approverPolicy: loadApproverPolicy(stateDir),
        };
      })(),
      governorMode: loadGovernorMode(stateDir),
      permissiveToday: (() => {
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        const all = readPermissiveActions(stateDir, dayStart.getTime());
        return {
          count: all.length,
          recent: all.slice(-8).reverse().map((a) => ({ ts: a.ts, kind: a.kind, detail: a.detail })),
        };
      })(),
    };
  },
  ledger: () => ({
    entries: governor.recentEntries(200) as unknown as Record<string, unknown>[],
    audit: governor.audit(),
    summary: { ...governor.spendSummary(), caps: governor.config() as unknown as Record<string, unknown> },
  }),
  jobs: () => {
    const urls = shieldVerifyUrls();
    return jobs.list(50).map((j) => ({
      id: j.id,
      kind: j.kind,
      state: j.state,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      costUsd: j.costUsd,
      tokensIn: j.tokensIn,
      tokensOut: j.tokensOut,
      outcomeNote: j.outcomeNote,
      receiptId: j.receiptId,
      receiptVerifyUrl: j.receiptId?.startsWith("rcpt_")
        ? (urls.get(j.receiptId) ?? `${shieldGate.client.baseUrl}/v/${j.receiptId}`)
        : undefined,
      shieldReceipts: (j.shieldReceiptIds ?? []).map((id) => ({
        receiptId: id,
        verifyUrl: urls.get(id),
      })),
    }));
  },
  approvals: () =>
    approvals.pending().map((r) => ({
      id: r.id,
      jobId: r.jobId,
      summary: r.summary,
      reason: r.reason,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    })),
  resolveApproval: async (id, approve) => {
    const req = approvals.get(id);
    if (!req || req.status !== "pending") {
      return { ok: false, detail: `Approval ${id} is not pending. Nothing was executed.` };
    }
    await host.resolveApproval(adapter.name, req.conversationId, id, approve, "panel");
    const after = approvals.get(id);
    return after && after.status !== "pending"
      ? { ok: true, detail: approve ? "Approved — executing exactly that." : "Denied. Nothing ran." }
      : { ok: false, detail: "The approval could not be resolved (kill switch on, or it just expired). Nothing was executed." };
  },
  setGovernorMode: async (mode) => {
    if (mode !== "enforcing" && mode !== "permissive") {
      return { ok: false, detail: `Unknown mode "${mode}" — expected "enforcing" or "permissive". Nothing changed.` };
    }
    writeGovernorMode(stateDir, mode, "panel");
    return {
      ok: true,
      detail:
        mode === "permissive"
          ? "Governor mode: PERMISSIVE — blocks and parks are recorded, not enforced. Caps, kill switch, and scanning unchanged."
          : "Governor mode: ENFORCING — Shield verdicts and approval parks bind.",
    };
  },
  setApproverPolicy: async (p) => {
    if (p.scope !== "bounded" && p.scope !== "all_except_floors") {
      return { ok: false, detail: `Unknown delegation scope "${String(p.scope)}" — expected "bounded" or "all_except_floors". Nothing changed.` };
    }
    if (
      typeof p.maxApprovalsPerHour !== "number" ||
      !Number.isFinite(p.maxApprovalsPerHour) ||
      p.maxApprovalsPerHour < 0 ||
      p.maxApprovalsPerHour > 1000
    ) {
      return { ok: false, detail: "Max agent approvals per hour must be a number from 0 to 1000. Nothing changed." };
    }
    writeApproverPolicy(
      stateDir,
      {
        gusApprovesDelegates: p.gusApprovesDelegates === true,
        gusApprovesOwn: p.gusApprovesOwn === true,
        delegatesMayApprove: p.delegatesMayApprove === true,
        scope: p.scope,
        maxApprovalsPerHour: Math.floor(p.maxApprovalsPerHour),
      },
      "panel",
    );
    const anyOn = p.gusApprovesDelegates || p.gusApprovesOwn || p.delegatesMayApprove;
    return {
      ok: true,
      detail: anyOn
        ? "Approval delegation saved. It applies only while the Governor is PERMISSIVE — in Enforcing, approvals stay with the operator. Floors (vault, deletes, installs, sends, git push, sudo-class shell, keychain) are never delegable."
        : "Approval delegation saved — all paths off. Parks are the operator's (and in Permissive they proceed stamped, as before).",
    };
  },
  setKilled: async (on) => {
    if (on) {
      const { settled } = host.killAll("panel");
      return { ok: true, detail: `Kill switch ON — GUS is stopped. ${settled} unsettled job(s) settled failed-loudly.` };
    }
    host.resumeAll("panel");
    return { ok: true, detail: "Kill switch OFF — GUS is live." };
  },
  vaultNames: () => vault.listNames(),
  storeSecret: (name, value) => {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
      return { ok: false, detail: "Secret names are lowercase letters, digits, dashes and underscores (max 64 chars)." };
    }
    if (!value) return { ok: false, detail: "The value is empty — nothing was stored." };
    try {
      vault.add(name, value);
      return { ok: true, detail: `Stored "${name}" in the vault. The value is never shown again, anywhere.` };
    } catch (e) {
      return { ok: false, detail: `Could not store: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
  onboarding: () => onboarding.view(),
  onboardingShield: (payload) => onboarding.shield(payload.onUnavailable),
  onboardingTelegram: async (payload) => onboarding.telegram(payload.token),
  onboardingProvider: async (payload) => onboarding.provider(payload),
  onboardingCaps: async (payload) => onboarding.caps(payload),
  onboardingFirstJob: async () => onboarding.firstJob(),
  skills: () => skillInstaller.listInstalled(),
  installSkill: async (payload) => skillInstaller.install(payload.path ?? ""),
};

// The operator token: a 0600 file in control-plane state, minted on
// first boot. The value is never printed — the operator opens the
// panel with the token file (or an SSH-tunneled ?t= link made from it).
const panelTokenPath = `${stateDir}/panel-token`;
let panelToken = "";
try {
  if (existsSync(panelTokenPath)) panelToken = readFileSync(panelTokenPath, "utf8").trim();
} catch { /* fall through to minting */ }
if (!panelToken) {
  panelToken = randomBytes(24).toString("hex");
  writeFileSync(panelTokenPath, panelToken + "\n", { mode: 0o600 });
}
const panelPort = Number(process.env.GUS_PANEL_PORT ?? "8731") || 8731;
const panel = new PanelServer(panelBackend, {
  token: panelToken,
  host: process.env.GUS_PANEL_HOST ?? "127.0.0.1",
  port: panelPort,
  onError: (e) =>
    appendFileSync(
      `${stateDir}/runtime-log.jsonl`,
      JSON.stringify({ ts: Date.now(), level: "warn", text: `panel could not bind: ${e.message} (control plane continues without it)` }) + "\n",
    ),
});
await panel.start();
appendFileSync(
  `${stateDir}/runtime-log.jsonl`,
  JSON.stringify({
    ts: Date.now(),
    level: "info",
    text: `panel listening on ${process.env.GUS_PANEL_HOST ?? "127.0.0.1"}:${panel.port ?? panelPort} (operator token: ${panelTokenPath})`,
  }) + "\n",
);

await comm.start();
await host.start();
// Phase 5: the Job Runner boot sweep. Jobs a previous incarnation left
// queued/running have no driver in this one — settle them failed-loudly
// with receipts instead of leaving them hanging (spec §1.5: no silent
// failure). Update jobs are swept too UNLESS an update record is still
// in flight: promotion works by exiting this process, so a live record
// means bootReconcile (below) owns that job and settles it from the
// record — confirmed, rolled back, or aborted.
const updRec = updater.readRecord();
const updateInFlight =
  updRec !== null &&
  ["waiting-idle", "verifying", "staging", "canary", "promoting"].includes(updRec.status);
const swept = jobs.sweepOrphanedJobs({ includeUpdateJobs: !updateInFlight });
for (const rec of swept) {
  appendFileSync(
    `${stateDir}/runtime-log.jsonl`,
    JSON.stringify({
      ts: Date.now(),
      level: "warn",
      text: `boot sweep: job ${rec.id} (${rec.kind}) left unsettled by a previous incarnation — settled failed-loudly, receipt ${rec.receiptId}`,
    }) + "\n",
  );
  void host
    .notifyOperator(
      rec.conversationId,
      `⚠️ GUS restarted and a job didn't survive it: the ${rec.kind} job from ${new Date(rec.createdAt).toLocaleString()} was settled as FAILED with a receipt (id ${rec.receiptId ?? "—"}) rather than left hanging. Nothing from it ran after the restart.`,
    )
    .catch(() => {});
}
// Settle anything a previous incarnation left in flight — above all a
// promotion this process was booted to confirm (updater.ts).
void updater.bootReconcile(GUS_VERSION);
// Spec §5 kill-criteria instrumentation: the anonymous install
// heartbeat. OFF unless the operator opted in (GUS_HEARTBEAT=1 with a
// counter URL); the payload is { version, mode } and nothing else.
startHeartbeat();
appendFileSync(
  `${stateDir}/runtime-log.jsonl`,
  JSON.stringify({ ts: Date.now(), level: "info", text: `control plane up; channel=${adapter.name} transport=${channelKind} killed=${governor.isKilled()}` }) + "\n",
);
console.log(`gus control plane up (channel=${channelKind}, killed=${governor.isKilled()})`);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
