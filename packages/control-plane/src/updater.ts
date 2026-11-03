/**
 * Updater (foundation spec §1.1) — Phase 3: boring updates.
 *
 * The promise: an update never breaks the user's working agent. The
 * mechanism, in order, all of it in the control plane (the sandbox
 * never updates itself; it merely runs whatever slot the pointer
 * names, under its launcher):
 *
 *   1. IDLE GATE — an update never starts while a job is running or
 *      an approval is parked. It waits (the update job sits in
 *      "running" with the gate as its note) and gives up loudly after
 *      a bounded wait. In-flight work is never interrupted for an
 *      update; the drill proves a running job finishes first.
 *   2. VERIFY — the release's signed manifest is verified against the
 *      pinned release key and every file's hash, before anything is
 *      staged (release.ts). A corrupt bundle is refused here and the
 *      running version is untouched.
 *   3. SNAPSHOT — operator config is copied aside (slots.ts: config
 *      rolls back; data never does — the append-only stores are
 *      recorded by size/hash for the integrity record, never copied,
 *      never restored).
 *   4. STAGE — the verified bundle is copied into the idle slot and
 *      re-verified in place.
 *   5. CANARY — the candidate runtime boots in check mode (sandbox
 *      launcher directive on the comm volume) and the recorded canary
 *      suite replays against it (canary.ts). The live version keeps
 *      serving. Any failure: config snapshot restored, update job
 *      failed-loudly with a receipt, operator notified, old version
 *      still live — a rollback that had nothing to roll back.
 *   6. PROMOTE — the pointer flips to the new slot with
 *      confirmPending set, and this process exits; its launcher boots
 *      the new slot's control plane, and the sandbox launcher boots
 *      the new slot's runtime. Confirmation (bootReconcile, run by
 *      the NEW control plane): the live socket must announce the new
 *      runtime version and a live confirmation job must settle
 *      verified-done. Then the update job settles verified-done, the
 *      operator is told, confirmPending clears.
 *   7. ROLLBACK paths — confirmation failure in the new control plane
 *      flips the pointer back itself and restarts into the old slot;
 *      a new control plane that cannot even boot is flipped back by
 *      its launcher's watchdog, and the old control plane finalizes
 *      the update as rolled back when it boots. Either way the
 *      operator hears "rolled back", with a receipt.
 *
 * Update jobs are ordinary jobs (kind "update"): durable, three-state,
 * receipted. The record of the in-flight update lives in
 * <state>/update.json so a control-plane restart — which is HOW
 * promotion happens — can reconcile it on boot.
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Governor } from "./governor.js";
import type { JobRunner } from "./jobs.js";
import type { ApprovalEngine } from "./approvals.js";
import type { PolicyStore } from "./policy.js";
import type { CommServer, FetchGate } from "./comm-server.js";
import { CanaryRunner, type CanaryReport } from "./canary.js";
import { verifyRelease } from "./release.js";
import {
  otherSlot,
  readPointer,
  restoreConfig,
  slotDir,
  slotVersion,
  snapshotConfig,
  snapshotDirFor,
  snapshotStores,
  storesPrefixIntact,
  writePointer,
  type SlotPointer,
} from "./slots.js";

export type UpdateStatus =
  | "waiting-idle"
  | "verifying"
  | "staging"
  | "canary"
  | "promoting"
  | "confirmed"
  | "rolled-back"
  | "failed";

export interface UpdateRecord {
  id: string;
  jobId: string;
  conversationId: string;
  fromVersion: string;
  toVersion: string;
  fromSlot: string;
  toSlot: string;
  status: UpdateStatus;
  detail?: string;
  startedAt: number;
  updatedAt: number;
}

/** The host surface the Updater needs. Bound from main.ts after the
 *  ChannelHost exists (the host owns the channel; the updater owns the
 *  pipeline; neither imports the other). */
export interface UpdaterHost {
  notify(conversationId: string, text: string): Promise<void>;
  /** Graceful self-exit so the launcher boots the pointer's slot. */
  requestSelfExit(): void;
  /** Create a real job through the live channel pipeline (used by the
   *  post-promotion confirmation) and return its id. */
  pushConfirmationJob(conversationId: string): string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export class Updater {
  private host?: UpdaterHost;

  constructor(
    private stateDir: string,
    private installDir: string,
    private releasesDir: string,
    private pubkeyPath: string,
    private commDir: string,
    private jobs: JobRunner,
    private governor: Governor,
    private approvals: ApprovalEngine,
    private policy: PolicyStore,
    private comm: CommServer,
    private fetchGate?: FetchGate,
  ) {}

  bindHost(host: UpdaterHost): void {
    this.host = host;
  }

  // ------------------------------------------------------------ record

  private recordPath(): string {
    return join(this.stateDir, "update.json");
  }

  readRecord(): UpdateRecord | null {
    try {
      return JSON.parse(readFileSync(this.recordPath(), "utf8")) as UpdateRecord;
    } catch {
      return null;
    }
  }

  private writeRecord(rec: UpdateRecord): void {
    rec.updatedAt = Date.now();
    const tmp = `${this.recordPath()}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
    renameSync(tmp, this.recordPath());
  }

  private logEvent(obj: unknown): void {
    appendFileSync(join(this.stateDir, "updates.jsonl"), JSON.stringify({ ts: Date.now(), ...(obj as object) }) + "\n");
  }

  private async notify(rec: UpdateRecord, text: string): Promise<void> {
    await this.host?.notify(rec.conversationId, text).catch(() => {});
  }

  private settle(rec: UpdateRecord, ok: boolean, note: string): void {
    try {
      this.jobs.transition(rec.jobId, ok ? "verified-done" : "failed-loudly", note);
    } catch {
      /* already settled (kill raced us) — the outcome stands */
    }
  }

  // ------------------------------------------------------------ queries

  /** Slots are in use only when the install pointer exists. In the
   *  legacy flat layout (Phases 0–2 containers, no launcher) there is
   *  no pointer and updates are unavailable — said plainly, not faked. */
  slotsActive(): boolean {
    return readPointer(this.installDir) !== null;
  }

  versionInfo(): { pointer: SlotPointer | null; runtimeVersion?: string } {
    return { pointer: readPointer(this.installDir), runtimeVersion: this.comm.runtimeVersion };
  }

  private activeRecord(): UpdateRecord | null {
    const rec = this.readRecord();
    if (!rec) return null;
    return ["waiting-idle", "verifying", "staging", "canary", "promoting"].includes(rec.status) ? rec : null;
  }

  // ------------------------------------------------------------ begin

  /**
   * Start an update. Called by the channel host's /update handler with
   * the update job already created. Returns an immediate ack string;
   * the pipeline runs asynchronously and reports over the channel.
   */
  begin(jobId: string, version: string, conversationId: string): string {
    if (!this.slotsActive()) {
      this.settle({ jobId } as UpdateRecord, false, "updates unavailable: this deployment does not use install slots");
      return "Updates aren't available in this deployment layout (no install slots) — nothing was changed.";
    }
    if (this.activeRecord()) {
      this.settle({ jobId } as UpdateRecord, false, "another update is already in progress");
      return "An update is already in progress — one at a time. Nothing was changed.";
    }
    if (!existsSync(this.pubkeyPath)) {
      this.settle({ jobId } as UpdateRecord, false, "no release signing key is pinned (update-pubkey.pem missing)");
      return "I can't verify releases yet — no release signing key is pinned on this install. Nothing was changed.";
    }
    const pointer = readPointer(this.installDir)!;
    const rec: UpdateRecord = {
      id: `upd_${Date.now().toString(36)}`,
      jobId,
      conversationId,
      fromVersion: pointer.version,
      toVersion: version,
      fromSlot: pointer.slot,
      toSlot: otherSlot(pointer.slot),
      status: "waiting-idle",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.writeRecord(rec);
    this.logEvent({ kind: "update_begin", ...rec });
    void this.run(rec).catch(async (e) => {
      const note = `update pipeline error: ${e instanceof Error ? e.message : String(e)}`;
      rec.status = "failed";
      rec.detail = note;
      this.writeRecord(rec);
      this.settle(rec, false, note);
      await this.notify(rec, `⚠️ The update to v${rec.toVersion} hit an internal error and was abandoned safely: ${note}. You are still on v${rec.fromVersion}.`);
    });
    return `Update to v${version}: I'll verify the release and check it against your automations before anything changes. Your current version (v${pointer.version}) keeps running throughout.`;
  }

  private async run(rec: UpdateRecord): Promise<void> {
    // ---- 1. idle gate ------------------------------------------------
    if (this.governor.isKilled()) {
      return this.fail(rec, "the kill switch is on — updates do not run while GUS is stopped");
    }
    const maxWait = envMs("GUS_UPDATE_MAX_WAIT_MS", 120_000);
    const deadline = Date.now() + maxWait;
    while (this.jobs.hasActiveJobsExcept(rec.jobId) || this.approvals.hasPending()) {
      if (Date.now() > deadline) {
        return this.fail(rec, `the system stayed busy for ${Math.round(maxWait / 1000)}s — the update was deferred, not forced. Nothing was changed.`);
      }
      await sleep(250);
    }

    // ---- 2. verify the release --------------------------------------
    rec.status = "verifying";
    this.writeRecord(rec);
    const releaseDir = join(this.releasesDir, rec.toVersion);
    if (!existsSync(releaseDir)) {
      return this.fail(rec, `no release bundle found for version ${rec.toVersion}`);
    }
    const pubkey = readFileSync(this.pubkeyPath, "utf8");
    const verification = verifyRelease(releaseDir, pubkey);
    if (!verification.ok) {
      return this.fail(rec, `release rejected before staging: ${verification.error}. The running version was not touched.`);
    }
    if (verification.manifest.version !== rec.toVersion) {
      return this.fail(rec, `release manifest is for v${verification.manifest.version}, not v${rec.toVersion} — refused.`);
    }
    if (rec.toVersion === rec.fromVersion) {
      return this.fail(rec, `already running v${rec.fromVersion} — nothing to update.`);
    }

    // ---- 3. snapshot --------------------------------------------------
    rec.status = "staging";
    this.writeRecord(rec);
    const snapDir = snapshotDirFor(this.stateDir, rec.id);
    snapshotConfig(this.stateDir, snapDir);
    const storesBefore = snapshotStores(this.stateDir);
    writeFileSync(join(snapDir, "stores-before.json"), JSON.stringify(storesBefore, null, 2) + "\n");

    // ---- 4. stage into the idle slot + re-verify in place -------------
    const staging = join(this.installDir, "staging", rec.id);
    rmSync(staging, { recursive: true, force: true });
    cpSync(releaseDir, staging, { recursive: true });
    const stagedCheck = verifyRelease(staging, pubkey);
    if (!stagedCheck.ok) {
      return this.fail(rec, `staged copy failed verification: ${stagedCheck.error}. The running version was not touched.`);
    }
    const dest = slotDir(this.installDir, rec.toSlot);
    rmSync(dest, { recursive: true, force: true });
    cpSync(staging, dest, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    if (slotVersion(this.installDir, rec.toSlot) !== rec.toVersion) {
      return this.fail(rec, `staged slot does not declare version ${rec.toVersion} — refusing to boot it.`);
    }
    this.logEvent({ kind: "update_staged", id: rec.id, slot: rec.toSlot, version: rec.toVersion });

    // ---- 5. canary replay against the candidate runtime ---------------
    rec.status = "canary";
    this.writeRecord(rec);
    await this.notify(
      rec,
      `Update to v${rec.toVersion}: the release verified and is staged. Now checking it against your recorded automations — your current version keeps running while I do.`,
    );
    const report = await this.runCanary(rec);
    if (!report.pass) {
      const failed = report.results.find((r) => !r.ok);
      const why = !report.healthOk
        ? report.healthDetail
        : `canary scenario "${failed?.name}" failed: ${failed?.detail}`;
      restoreConfig(this.stateDir, snapDir);
      rec.status = "failed";
      rec.detail = `pre-promotion verification failed — ${why}`;
      this.writeRecord(rec);
      this.logEvent({ kind: "update_canary_failed", id: rec.id, why, report });
      this.settle(rec, false, `update to v${rec.toVersion} rolled back before going live: ${why}`);
      await this.notify(
        rec,
        `↩️ Update to v${rec.toVersion} did NOT go live: ${why}. It was rolled back before it ever replaced your working version — you are still on v${rec.fromVersion}, and it never stopped serving. The update job ended as failed-loudly with a receipt.`,
      );
      return;
    }
    this.logEvent({ kind: "update_canary_passed", id: rec.id, report });

    // ---- 6. promote: flip the pointer and restart into the new slot ---
    rec.status = "promoting";
    this.writeRecord(rec);
    const pointer: SlotPointer = {
      slot: rec.toSlot,
      version: rec.toVersion,
      previous: { slot: rec.fromSlot, version: rec.fromVersion },
      confirmPending: true,
      updatedAt: Date.now(),
      note: "updater",
    };
    writePointer(this.installDir, pointer);
    this.logEvent({ kind: "update_promoted", id: rec.id, pointer });
    await this.notify(
      rec,
      `✅ v${rec.toVersion} passed every check. Switching over now — this takes a few seconds.`,
    );
    // Exit so the launcher boots the new slot's control plane; the new
    // incarnation reconciles this record in bootReconcile(). If no
    // launcher is supervising (should not happen in a slots layout),
    // the record stays "promoting" and the next boot reconciles it.
    this.host?.requestSelfExit();
  }

  private async fail(rec: UpdateRecord, note: string): Promise<void> {
    rec.status = "failed";
    rec.detail = note;
    this.writeRecord(rec);
    this.logEvent({ kind: "update_failed", id: rec.id, note });
    this.settle(rec, false, `update to v${rec.toVersion} did not happen: ${note}`);
    await this.notify(rec, `⚠️ Update to v${rec.toVersion} did not happen: ${note} You are still on v${rec.fromVersion}.`);
  }

  // ------------------------------------------------------------ canary plumbing

  private canaryDirectivePath(): string {
    return join(this.commDir, "canary-boot.json");
  }

  private writeCanaryDirective(obj: unknown): void {
    const tmp = join(this.commDir, `.canary-boot.json.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(obj) + "\n");
    renameSync(tmp, this.canaryDirectivePath());
  }

  private async runCanary(rec: UpdateRecord): Promise<CanaryReport> {
    const seq = Date.now();
    this.writeCanaryDirective({ seq, action: "start", slot: rec.toSlot, version: rec.toVersion });
    const runner = new CanaryRunner(
      this.stateDir,
      join(this.commDir, "gus-canary.sock"),
      this.jobs,
      this.policy,
      this.fetchGate,
    );
    try {
      return await runner.run(rec.toVersion, {
        healthTimeoutMs: envMs("GUS_CANARY_HEALTH_TIMEOUT_MS", 25_000),
        scenarioTimeoutMs: envMs("GUS_CANARY_SCENARIO_TIMEOUT_MS", 20_000),
      });
    } finally {
      this.writeCanaryDirective({ seq: seq + 1, action: "stop" });
    }
  }

  // ------------------------------------------------------------ boot reconcile

  /**
   * Run once by every control-plane boot (main.ts). Settles whatever a
   * previous incarnation left in flight — most importantly the
   * promotion the previous incarnation exited to perform.
   */
  async bootReconcile(myVersion: string): Promise<void> {
    const rec = this.readRecord();
    if (!rec) return;
    const snapDir = snapshotDirFor(this.stateDir, rec.id);

    if (["waiting-idle", "verifying", "staging", "canary"].includes(rec.status)) {
      // The previous control plane died before promotion. The pointer
      // was never flipped; the current version is untouched. Abort
      // loudly rather than resuming a half-staged update.
      this.writeCanaryDirective({ seq: Date.now(), action: "stop" });
      restoreConfig(this.stateDir, snapDir);
      rec.status = "failed";
      rec.detail = "control plane restarted mid-update, before promotion — aborted safely";
      this.writeRecord(rec);
      this.logEvent({ kind: "update_aborted_on_boot", id: rec.id });
      this.settle(rec, false, `update to v${rec.toVersion} aborted: the control plane restarted before promotion. v${rec.fromVersion} was never replaced.`);
      await this.notify(rec, `⚠️ The update to v${rec.toVersion} was interrupted by a restart before it went live, so I abandoned it safely. You are still on v${rec.fromVersion}.`);
      return;
    }

    if (rec.status !== "promoting") return;
    const pointer = readPointer(this.installDir);

    if (pointer && pointer.version === rec.toVersion && myVersion === rec.toVersion) {
      // I AM the new control plane. Confirm the new runtime is live on
      // the real socket, then prove the real pipeline end-to-end with
      // a confirmation job through the actual channel host.
      const helloOk = await this.comm.waitRuntimeVersion(rec.toVersion, envMs("GUS_CONFIRM_HELLO_TIMEOUT_MS", 30_000));
      let jobOk = false;
      let jobDetail = "runtime did not announce the new version on the live socket";
      if (helloOk && this.host) {
        const jobId = this.host.pushConfirmationJob(rec.conversationId);
        const deadline = Date.now() + envMs("GUS_CONFIRM_JOB_TIMEOUT_MS", 30_000);
        while (Date.now() < deadline) {
          const st = this.jobs.get(jobId)?.state;
          if (st === "verified-done") {
            jobOk = true;
            break;
          }
          if (st === "failed-loudly") {
            jobDetail = `confirmation job failed: ${this.jobs.get(jobId)?.outcomeNote ?? "?"}`;
            break;
          }
          await sleep(150);
        }
        if (!jobOk && jobDetail.startsWith("runtime")) jobDetail = "confirmation job did not settle in time";
      }
      if (helloOk && jobOk) {
        // Integrity, proven at the moment of confirmation: the update
        // appended to the data stores and lost nothing.
        let integrity = "stores not snapshotted";
        try {
          const before = JSON.parse(readFileSync(join(snapDir, "stores-before.json"), "utf8"));
          integrity = storesPrefixIntact(this.stateDir, before)
            ? "append-only stores intact (prefix check passed)"
            : "WARNING: an append-only store changed non-append-only during the update";
        } catch {
          /* snapshot absent — nothing to check against */
        }
        rec.status = "confirmed";
        rec.detail = integrity;
        this.writeRecord(rec);
        writePointer(this.installDir, { ...pointer, confirmPending: false, updatedAt: Date.now(), note: "updater-confirmed" });
        this.logEvent({ kind: "update_confirmed", id: rec.id, integrity });
        this.settle(rec, true, `updated to v${rec.toVersion}; canary replay passed; live confirmation job verified-done; ${integrity}`);
        await this.notify(
          rec,
          `✅ Update complete — you are now running v${rec.toVersion}. Your automations were replayed against it before it went live, and a live check just passed on the new version.`,
        );
        return;
      }
      // Confirmation failed: I roll back myself. Flip the pointer,
      // restore config, settle loudly, and exit so the launcher boots
      // the old slot (whose boot sees a finalized record and stands
      // down).
      restoreConfig(this.stateDir, snapDir);
      writePointer(this.installDir, {
        slot: rec.fromSlot,
        version: rec.fromVersion,
        previous: null,
        confirmPending: false,
        updatedAt: Date.now(),
        note: "updater-self-rollback",
      });
      rec.status = "rolled-back";
      rec.detail = `live confirmation failed: ${jobDetail}`;
      this.writeRecord(rec);
      this.logEvent({ kind: "update_self_rollback", id: rec.id, jobDetail });
      this.settle(rec, false, `update to v${rec.toVersion} rolled back: ${jobDetail}. v${rec.fromVersion} restored.`);
      await this.notify(
        rec,
        `↩️ The update to v${rec.toVersion} passed its pre-checks but failed live confirmation (${jobDetail}), so I rolled back automatically. You are on v${rec.fromVersion} again.`,
      );
      this.host?.requestSelfExit();
      return;
    }

    if (myVersion === rec.fromVersion) {
      // The pointer no longer names the new slot and I am the OLD
      // control plane: the launcher watchdog flipped back because the
      // new control plane died before finalizing. Finalize as a
      // rollback (the watchdog already restored service; this settles
      // the paperwork and tells the operator).
      restoreConfig(this.stateDir, snapDir);
      rec.status = "rolled-back";
      rec.detail = "new control plane failed to start; launcher watchdog rolled back";
      this.writeRecord(rec);
      this.logEvent({ kind: "update_watchdog_rollback", id: rec.id });
      this.settle(rec, false, `update to v${rec.toVersion} rolled back automatically: the new version's control plane failed to start. v${rec.fromVersion} is running.`);
      await this.notify(
        rec,
        `↩️ The update to v${rec.toVersion} was rolled back automatically: the new version failed to start, so the previous version (v${rec.fromVersion}) was restored and is serving now. The update job ended as failed-loudly with a receipt.`,
      );
      return;
    }
    // Otherwise: a "promoting" record whose pointer and my version
    // disagree in a way neither branch claims (e.g. a third version
    // booted). Leave the record for the operator; log it loudly.
    this.logEvent({ kind: "update_reconcile_orphan", id: rec.id, myVersion, pointer });
  }
}
