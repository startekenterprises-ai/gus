/**
 * Canary replay (foundation spec §§1.1/1.5) — Phase 3.
 *
 * The post-update verification: a recorded set of the operator's own
 * representative jobs, replayed against a CANDIDATE runtime before an
 * update is allowed to promote. The candidate runs in the sandbox as a
 * second, short-lived runtime process, connected to a second comm
 * endpoint hosted here; the live runtime keeps serving throughout.
 *
 * What is real and what is scratch, deliberately:
 *   - REAL: the Job Runner (canary jobs are jobs — durable, receipted,
 *     kind "canary", in the same store as user jobs), the PolicyStore
 *     (the candidate is classified by the operator's live policy), and
 *     the egress proxy (the fetch scenario crosses the real allowlist).
 *   - SCRATCH: the Governor (canary spend is metered on its own ledger
 *     in a wiped scratch dir — a verification run must never eat the
 *     user's caps) and the Approval Engine (the park scenario's denial
 *     is issued by the runner itself against its own engine; a canary
 *     must never create, consume, or resolve a LIVE approval).
 *
 * The four recorded scenarios exercise the four paths an update can
 * silently break: the model round-trip (chat), the verified write path
 * (write + digest post-condition), the egress path (allowlisted
 * fetch), and the approval path (a destructive call must park, execute
 * nothing, and fail loudly on denial). A candidate that boots but
 * breaks any one of them — drill case (c) breaks the write path — is
 * caught here, before promotion, while the old version is still live.
 *
 * The scenario set is the operator's recorded one: <state>/canary.json
 * when present (same shape as CanaryScenarios), else the built-in
 * defaults below.
 */
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@gus/gate";
import { Governor } from "./governor.js";
import { JobRunner } from "./jobs.js";
import { CommServer, type FetchGate, type HostHooks } from "./comm-server.js";
import { ApprovalEngine } from "./approvals.js";
import type { PolicyStore } from "./policy.js";
import { screenText } from "./screen.js";

export interface CanaryScenarios {
  chatText: string;
  writePath: string;
  writeContent: string;
  fetchUrl: string;
  /** Deleted (well — deletion ATTEMPTED) by the park scenario; the
   *  write scenario creates it first. Defaults to writePath. */
  deletePath?: string;
}

export const DEFAULT_CANARY_SCENARIOS: CanaryScenarios = {
  chatText: "hello canary",
  writePath: "canary/probe.txt",
  writeContent: "canary probe — if this reads back exactly, the write path works",
  fetchUrl: "http://127.0.0.1:8901/public",
};

export interface ScenarioResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CanaryReport {
  pass: boolean;
  /** Health = the candidate connected and announced the expected
   *  version. A crashy release fails here, before any scenario. */
  healthOk: boolean;
  healthDetail: string;
  results: ScenarioResult[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CanaryRunner {
  private comm!: CommServer;
  private approvals!: ApprovalEngine;
  private lastModelHash = new Map<string, string>();
  private pendingWrite = new Map<string, { path: string; expectedDigest: string }>();

  constructor(
    private stateDir: string,
    private socketPath: string,
    private jobs: JobRunner,
    private policy: PolicyStore,
    private fetchGate?: FetchGate,
  ) {}

  scenarios(): CanaryScenarios {
    try {
      const p = join(this.stateDir, "canary.json");
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<CanaryScenarios>;
        return { ...DEFAULT_CANARY_SCENARIOS, ...raw };
      }
    } catch {
      /* malformed recorded set: fall back to the defaults */
    }
    return DEFAULT_CANARY_SCENARIOS;
  }

  private hooks(): HostHooks {
    return {
      onRuntimeHello: () => {},
      onModelIssued: (jobId, text) => {
        if (text !== undefined) this.lastModelHash.set(jobId, sha256Hex(text));
      },
      noteAuthorizedWrite: (jobId, path, content) => {
        this.pendingWrite.set(jobId, { path, expectedDigest: sha256Hex(content) });
      },
      onApprovalRequested: () => {},
      noteApprovedExecution: () => {},
      onDenied: () => {
        /* the comm server already settled the job failed-loudly */
      },
      onCapExceeded: () => {
        /* likewise settled by the comm server */
      },
      onJobUpdate: () => {},
      onJobFinal: async (jobId, text) => {
        const job = this.jobs.get(jobId);
        if (!job || job.state === "verified-done" || job.state === "failed-loudly") return;
        let verified = false;
        let note: string;
        const pending = this.pendingWrite.get(jobId);
        if (pending) {
          const v = await this.comm.verify(jobId, { tool: "workspace_read", args: { path: pending.path } });
          verified = v.ok && v.digest === pending.expectedDigest;
          note = verified
            ? "canary post-condition ok: file content hash matches the authorized write"
            : "canary post-condition FAILED: file hash mismatch or unreadable";
          this.pendingWrite.delete(jobId);
        } else {
          verified = this.lastModelHash.get(jobId) === sha256Hex(text);
          note = verified
            ? "canary post-condition ok: delivered output matches Governor-issued model output"
            : "canary post-condition FAILED: runtime output differs from Governor-issued model output";
        }
        // Settlement mirrors the ChannelHost's exactly — verified-done
        // is earned by the check, never by the runtime's say-so.
        this.jobs.transition(jobId, verified ? "verified-done" : "failed-loudly", note);
      },
      logRuntime: () => {},
    };
  }

  private async waitState(jobId: string, want: string[], timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const st = this.jobs.get(jobId)?.state;
      if (st && want.includes(st)) return st;
      await sleep(100);
    }
    return null;
  }

  private async runJobScenario(name: string, text: string, timeoutMs: number): Promise<ScenarioResult> {
    const job = this.jobs.create("canary", "canary", screenText(text).redacted);
    this.jobs.transition(job.id, "running");
    this.comm.pushUserMessage({ jobId: job.id, kind: "canary", text });
    const st = await this.waitState(job.id, ["verified-done", "failed-loudly"], timeoutMs);
    if (st === "verified-done") return { name, ok: true, detail: `job ${job.id} verified-done` };
    if (st === "failed-loudly") {
      return { name, ok: false, detail: `job ${job.id} failed-loudly: ${this.jobs.get(job.id)?.outcomeNote ?? "?"}` };
    }
    return { name, ok: false, detail: `job ${job.id} did not settle within ${timeoutMs}ms (state: ${this.jobs.get(job.id)?.state ?? "gone"})` };
  }

  private async runParkScenario(scen: CanaryScenarios, timeoutMs: number): Promise<ScenarioResult> {
    const name = "approval-park";
    const target = scen.deletePath ?? scen.writePath;
    const text = `delete files ${target}`;
    const job = this.jobs.create("canary", "canary", screenText(text).redacted);
    this.jobs.transition(job.id, "running");
    this.comm.pushUserMessage({ jobId: job.id, kind: "canary", text });
    const st = await this.waitState(job.id, ["needs-approval"], timeoutMs);
    if (st !== "needs-approval") {
      return { name, ok: false, detail: `destructive call did not park (state: ${st ?? this.jobs.get(job.id)?.state ?? "timeout"})` };
    }
    // Nothing may have executed: the file must still be there. The
    // check runs through the candidate's own fixed checker code.
    const before = await this.comm.verify(job.id, { tool: "workspace_absent", args: { paths: [target] } });
    if (before.ok) {
      return { name, ok: false, detail: "the parked delete EXECUTED — the file is gone without approval" };
    }
    const req = this.approvals.pendingForJob(job.id);
    if (!req) return { name, ok: false, detail: "job parked but no approval record exists in the (scratch) engine" };
    this.approvals.resolve(req.id, "denied", "canary-runner");
    this.jobs.transition(job.id, "failed-loudly", `canary: denial settles the parked job: ${req.summary}`);
    const after = await this.comm.verify(job.id, { tool: "workspace_absent", args: { paths: [target] } });
    if (after.ok) {
      return { name, ok: false, detail: "the file vanished after denial — execution leaked past the park" };
    }
    return { name, ok: true, detail: "destructive call parked, nothing executed, denial settled it failed-loudly" };
  }

  /**
   * Boot the endpoint, health-check the candidate, replay the
   * scenarios. The caller owns the candidate process (via the sandbox
   * launcher's canary directive); this runner owns the conversation.
   */
  async run(expectedVersion: string, opts?: { healthTimeoutMs?: number; scenarioTimeoutMs?: number }): Promise<CanaryReport> {
    const healthTimeoutMs = opts?.healthTimeoutMs ?? 25_000;
    const scenarioTimeoutMs = opts?.scenarioTimeoutMs ?? 20_000;
    const scratch = join(this.stateDir, "canary-run");
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    const governor = new Governor(scratch, {
      maxTokensPerJob: 1_000_000,
      maxTokensPerDay: 1_000_000,
    });
    this.approvals = new ApprovalEngine(scratch, () => 60_000);
    this.comm = new CommServer(this.socketPath, governor, this.jobs, this.hooks(), this.policy, this.approvals, this.fetchGate);
    const scen = this.scenarios();
    try {
      await this.comm.start();
      const healthy = await this.comm.waitRuntimeVersion(expectedVersion, healthTimeoutMs);
      if (!healthy) {
        return {
          pass: false,
          healthOk: false,
          healthDetail: `candidate runtime did not announce version ${expectedVersion} within ${healthTimeoutMs}ms (saw: ${this.comm.runtimeVersion ?? "no hello"})`,
          results: [],
        };
      }
      const results: ScenarioResult[] = [];
      results.push(await this.runJobScenario("chat", scen.chatText, scenarioTimeoutMs));
      results.push(
        await this.runJobScenario("write-verify", `write file ${scen.writePath} ${scen.writeContent}`, scenarioTimeoutMs),
      );
      results.push(await this.runJobScenario("fetch", `fetch ${scen.fetchUrl}`, scenarioTimeoutMs));
      results.push(await this.runParkScenario(scen, scenarioTimeoutMs));
      return {
        pass: results.every((r) => r.ok),
        healthOk: true,
        healthDetail: `candidate announced version ${expectedVersion}`,
        results,
      };
    } finally {
      await this.comm.close().catch(() => {});
      this.approvals.stop();
    }
  }
}
