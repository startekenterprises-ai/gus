/**
 * The bundled Kokoro supervisor (v0.17.2) — the control plane's
 * handle on the bundled speech server.
 *
 * The server runs as a CHILD PROCESS of the control plane, never
 * in-process: the model is ~330 MB of native runtime that must
 * not share fate with the agent's brain, and a child can be
 * stopped, restarted, and left behind cleanly. The manager:
 *
 *   - spawns the server on first need (engine selected, or a
 *     call resolving the bundled mouth) — never at app startup;
 *   - health-checks it with backoff and reports one status
 *     shape everywhere (Settings' status line, the call's
 *     mode resolution);
 *   - restarts it on unexpected exit, with growing backoff;
 *   - stops it on engine switch-away and on app shutdown;
 *   - adopts a server that is already answering on the port
 *     (a previous control-plane instance's child self-terminates
 *     when its parent dies, but a fast restart can race it) —
 *     and refuses to confuse some OTHER program on the port
 *     (e.g. an operator-run Kokoro-FastAPI) with ours: adoption
 *     requires the health marker only this server sends.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { KOKORO_SERVICE_MARKER, kokoroBaseUrl, kokoroPort } from "./server.js";
import type { KokoroDtype } from "./backend.js";

export type KokoroManagerState = "stopped" | "starting" | "downloading" | "ready" | "unavailable";

export interface KokoroManagerStatus {
  state: KokoroManagerState;
  /** The status in one plain sentence — the Settings status
   *  line and the call notice both speak this text. */
  detail: string;
  /** Download progress 0..1 while state is "downloading" and
   *  the downloader reports totals; otherwise null. */
  progress: number | null;
  port: number;
  baseUrl: string;
}

interface HealthBody {
  ok?: unknown;
  service?: unknown;
  modelReady?: unknown;
  downloading?: unknown;
  loading?: unknown;
  progress?: unknown;
  error?: unknown;
}

export interface KokoroManagerOptions {
  /** Passed to the server as GUS_KOKORO_MODEL_DIR (~/.gus/models
   *  in the control plane's wiring). */
  modelDir: string;
  port?: number;
  dtype?: KokoroDtype;
  /** The server's entry point (dist/server-main.js). Defaults to
   *  the file beside this module — true in the repo layout and
   *  in the DMG payload alike. */
  serverEntry?: string;
  /** Test seams. */
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  /** How long ensureRunning waits for the server to answer. */
  startTimeoutMs?: number;
}

const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

export class KokoroServerManager {
  readonly port: number;
  readonly baseUrl: string;
  private readonly modelDir: string;
  private readonly dtype?: KokoroDtype;
  private readonly serverEntry: string;
  private readonly spawnFn: typeof spawn;
  private readonly fetchFn: typeof fetch;
  private readonly startTimeoutMs: number;

  private child?: ChildProcess;
  private adopted = false;
  private wantRunning = false;
  private stopping = false;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private restartStep = 0;
  private lastExit?: string;
  private cached: KokoroManagerStatus;

  constructor(opts: KokoroManagerOptions) {
    this.modelDir = opts.modelDir;
    this.port = opts.port ?? kokoroPort(process.env.GUS_KOKORO_PORT);
    this.baseUrl = kokoroBaseUrl(this.port);
    this.dtype = opts.dtype;
    this.serverEntry = opts.serverEntry ?? fileURLToPath(new URL("./server-main.js", import.meta.url));
    this.spawnFn = opts.spawnFn ?? spawn;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.startTimeoutMs = opts.startTimeoutMs ?? 30_000;
    this.cached = {
      state: "stopped",
      detail: "Built-in Kokoro is off — it starts when you select it as the speech engine.",
      progress: null,
      port: this.port,
      baseUrl: this.baseUrl,
    };
  }

  /** The last known status, synchronously — the Settings read
   *  is a sync surface; freshness comes from ensureRunning /
   *  status polls keeping the cache warm while the engine is in
   *  use, and from child-exit events the moment they happen. */
  statusSync(): KokoroManagerStatus {
    return { ...this.cached };
  }

  /** Poll the server once and refresh the cache. Never throws:
   *  an unreachable server is a status, not an exception. */
  async status(): Promise<KokoroManagerStatus> {
    const health = await this.pollHealth(1_000);
    if (health) {
      this.cached = this.mapHealth(health);
    } else if (this.wantRunning || this.child) {
      this.cached = {
        state: "unavailable",
        detail: this.lastExit
          ? `Unavailable — the built-in Kokoro server stopped (${this.lastExit}).`
          : "Unavailable — the built-in Kokoro server isn't answering.",
        progress: null,
        port: this.port,
        baseUrl: this.baseUrl,
      };
    }
    return this.statusSync();
  }

  /** Make sure the server is up (spawning it if needed) and
   *  return its status. The MODEL may still be downloading —
   *  that's in the status, not a failure of this call: the
   *  server answering is what "running" means. */
  async ensureRunning(): Promise<KokoroManagerStatus> {
    this.wantRunning = true;
    const existing = await this.pollHealth(800);
    if (existing) {
      this.adopted = true;
      this.restartStep = 0;
      this.cached = this.mapHealth(existing);
      return this.statusSync();
    }
    if (!this.child) this.spawnChild();
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      const health = await this.pollHealth(800);
      if (health) {
        this.restartStep = 0;
        this.cached = this.mapHealth(health);
        return this.statusSync();
      }
      if (this.foreignServer) {
        this.cached = {
          state: "unavailable",
          detail: `Unavailable — port ${this.port} is in use by another program, so the built-in Kokoro server can't start.`,
          progress: null,
          port: this.port,
          baseUrl: this.baseUrl,
        };
        return this.statusSync();
      }
      if (!this.child && this.lastExit) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    this.cached = {
      state: "unavailable",
      detail: this.lastExit
        ? `Unavailable — the built-in Kokoro server failed to start (${this.lastExit}).`
        : "Unavailable — the built-in Kokoro server didn't answer in time.",
      progress: null,
      port: this.port,
      baseUrl: this.baseUrl,
    };
    return this.statusSync();
  }

  /** Stop the server (engine switched away, app shutting down).
   *  An adopted server is left alone — it isn't ours to kill;
   *  it self-terminates when its own parent dies. */
  stop(): void {
    this.wantRunning = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.child && !this.adopted) {
      this.stopping = true;
      try {
        this.child.kill("SIGTERM");
      } catch { /* already gone */ }
    }
    this.child = undefined;
    this.adopted = false;
    this.cached = {
      state: "stopped",
      detail: "Built-in Kokoro is off — it starts when you select it as the speech engine.",
      progress: null,
      port: this.port,
      baseUrl: this.baseUrl,
    };
  }

  private foreignServer = false;

  private spawnChild(): void {
    this.lastExit = undefined;
    this.foreignServer = false;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GUS_KOKORO_PORT: String(this.port),
      GUS_KOKORO_MODEL_DIR: this.modelDir,
    };
    if (this.dtype) env.GUS_KOKORO_DTYPE = this.dtype;
    const child = this.spawnFn(process.execPath, [this.serverEntry], {
      env,
      stdio: "ignore",
    });
    this.child = child;
    this.cached = {
      state: "starting",
      detail: "Starting the built-in Kokoro server…",
      progress: null,
      port: this.port,
      baseUrl: this.baseUrl,
    };
    child.on("error", (e: Error) => {
      this.lastExit = e.message;
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child === child) this.child = undefined;
      this.lastExit = signal ? `signal ${signal}` : `exit code ${code ?? "?"}`;
      const wasStopping = this.stopping;
      this.stopping = false;
      if (!this.wantRunning || wasStopping) return;
      this.cached = {
        state: "unavailable",
        detail: `Unavailable — the built-in Kokoro server stopped unexpectedly (${this.lastExit}); restarting.`,
        progress: null,
        port: this.port,
        baseUrl: this.baseUrl,
      };
      const delay = RESTART_BACKOFF_MS[Math.min(this.restartStep, RESTART_BACKOFF_MS.length - 1)]!;
      this.restartStep++;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (this.wantRunning) void this.ensureRunning().catch(() => undefined);
      }, delay);
      this.restartTimer.unref?.();
    });
    child.unref?.();
  }

  /** One health poll. Returns the health body when the answering
   *  server is OURS (marker-checked); sets foreignServer when
   *  something answers without the marker; null when nothing
   *  answers. */
  private async pollHealth(timeoutMs: number): Promise<HealthBody | null> {
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${this.port}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as HealthBody;
      if (body?.service !== KOKORO_SERVICE_MARKER) {
        this.foreignServer = true;
        return null;
      }
      return body;
    } catch {
      return null;
    }
  }

  private mapHealth(health: HealthBody): KokoroManagerStatus {
    const base = { port: this.port, baseUrl: this.baseUrl };
    if (typeof health.error === "string" && health.error) {
      return {
        ...base,
        state: "unavailable",
        detail: `Unavailable — the voice model failed to load (${health.error}).`,
        progress: null,
      };
    }
    if (health.modelReady === true) {
      return { ...base, state: "ready", detail: "Ready — Kokoro runs on this Mac.", progress: 1 };
    }
    const progress = typeof health.progress === "number" ? health.progress : null;
    if (health.downloading === true) {
      return {
        ...base,
        state: "downloading",
        detail:
          progress !== null
            ? `Downloading the voice model — ${Math.floor(progress * 100)}%.`
            : "Downloading the voice model…",
        progress,
      };
    }
    return { ...base, state: "starting", detail: "Loading the voice model…", progress };
  }
}
