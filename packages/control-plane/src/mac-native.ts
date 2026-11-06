/**
 * The native Mac host adapter (Phase 8) — the real hands behind the
 * Phase 7 MacHostAdapter seam.
 *
 * The desktop half (observe / probe / click / type / key / scroll /
 * openApp / focusWindow / pickerSelect) is delegated to the native
 * helper `GusMacHost` (Swift, hosts/mac-app), which runs on the
 * resident Mac as part of GUS.app so the Accessibility and Screen
 * Recording grants attach to the app. The wire protocol is
 * newline-delimited JSON over a unix socket
 * (~/.gus/comm/mac-host.sock, 0600):
 *
 *   request:  {"id": <n>, "method": "click", "params": {...}}\n
 *   response: {"id": <n>, "ok": true,  "result": <value>}\n
 *           | {"id": <n>, "ok": false, "error": "<message>"}\n
 *
 * For the mutating input methods `result` is the receipt string,
 * verbatim in the canonical macActionReceipt form — this adapter
 * passes it through untouched; MacService does the comparing.
 *
 * Files and shell stay HERE, in the Node control plane (same host,
 * same machine): readFile/writeFile via node:fs, shellRun via
 * /bin/zsh -lc with captured exit code and output. The jail is NOT
 * this file's job — MacService enforces workDirs before any call
 * reaches the adapter, exactly as with the fake adapter.
 *
 * Failure discipline matches the pack: no socket, a dead helper, a
 * helper error, or a call that outlives its timeout all THROW, and
 * MacService turns the throw into a failed-loudly outcome. Nothing
 * here retries silently or invents a result.
 */
import { connect, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  UnavailableMacHostAdapter,
  type MacClickArgs,
  type MacHostAdapter,
  type MacObservation,
  type MacProbe,
  type MacScrollDirection,
  type MacShellResult,
} from "./mac.js";

export const DEFAULT_MAC_HOST_SOCKET = join(homedir(), ".gus", "comm", "mac-host.sock");
export const DEFAULT_MAC_HOST_TIMEOUT_MS = 15_000;

/** Where the installed GUS.app keeps the helper binary; used only for
 *  the best-effort spawn when the socket is missing (see below). */
export const DEFAULT_MAC_HOST_BIN = join(homedir(), ".gus", "app", "GusMacHost");

export interface NativeMacHostOptions {
  /** Helper socket path. Default: env GUS_MAC_HOST_SOCKET, else
   *  ~/.gus/comm/mac-host.sock. */
  socketPath?: string;
  /** Per-call timeout in ms. Default 15_000. */
  timeoutMs?: number;
  /** Helper binary to spawn (once, detached) when the socket is
   *  absent. Default: env GUS_MAC_HOST_BIN, else ~/.gus/app/GusMacHost.
   *  Spawning is best-effort: if the binary is not there, the call
   *  fails with the socket error, honestly. */
  helperPath?: string;
  /** Shell for shellRun. Default "/bin/zsh" (the resident Mac's
   *  login shell); overridable for tests and odd hosts. */
  shellPath?: string;
}

interface HelperResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class NativeMacHostAdapter implements MacHostAdapter {
  readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly helperPath: string;
  private readonly shellPath: string;
  private nextId = 1;
  private spawnAttempted = false;

  constructor(opts: NativeMacHostOptions = {}) {
    this.socketPath =
      opts.socketPath ?? process.env.GUS_MAC_HOST_SOCKET ?? DEFAULT_MAC_HOST_SOCKET;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_MAC_HOST_TIMEOUT_MS;
    this.helperPath = opts.helperPath ?? process.env.GUS_MAC_HOST_BIN ?? DEFAULT_MAC_HOST_BIN;
    this.shellPath = opts.shellPath ?? "/bin/zsh";
  }

  // ---------------------------------------------------------- wire core

  /**
   * One request/response round trip. A fresh connection per call:
   * the helper is local, calls are operator-paced, and a fresh
   * socket can never desynchronize after a timeout the way a shared
   * one could.
   */
  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    try {
      return await this.roundTrip<T>(id, method, params);
    } catch (e) {
      // The one recovery this adapter attempts: the app installed the
      // helper but it is not running (socket file absent). Spawn it
      // once and retry the call once. Anything else propagates.
      if (!this.spawnAttempted && isSocketAbsent(e) && existsSync(this.helperPath)) {
        this.spawnAttempted = true;
        await this.spawnHelper();
        return await this.roundTrip<T>(id, method, params);
      }
      throw e;
    }
  }

  private spawnHelper(): Promise<void> {
    return new Promise((resolve) => {
      try {
        const child = spawn(this.helperPath, [], { detached: true, stdio: "ignore" });
        child.on("error", () => resolve());
        child.unref();
      } catch {
        resolve();
      }
      // Give the helper a beat to bind its socket; the retry's own
      // connect either finds it or fails honestly.
      setTimeout(resolve, 500);
    });
  }

  private roundTrip<T>(id: number, method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket: Socket = connect(this.socketPath);
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Error(
          `the Mac host helper did not answer "${method}" within ${this.timeoutMs}ms ` +
          `(socket ${this.socketPath}) — the call is treated as not applied`,
        ));
      }, this.timeoutMs);
      const finish = (err?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value as T);
      };
      socket.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
          finish(Object.assign(
            new Error(
              `the Mac host helper is not reachable at ${this.socketPath} (${e.code}) — ` +
              `is GUS.app running on this Mac?`,
            ),
            { code: e.code },
          ));
        } else {
          finish(new Error(`the Mac host helper connection failed (${method}): ${e.message}`));
        }
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: HelperResponse;
          try {
            msg = JSON.parse(line) as HelperResponse;
          } catch {
            finish(new Error(`the Mac host helper sent a malformed response to "${method}"`));
            return;
          }
          if (msg.id !== id) continue;
          if (msg.ok) finish(undefined, msg.result as T);
          else finish(new Error(`the Mac host helper refused "${method}": ${msg.error ?? "unknown error"}`));
          return;
        }
      });
      socket.on("close", () => {
        finish(new Error(`the Mac host helper closed the connection before answering "${method}"`));
      });
      socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  // ------------------------------------------------- delegated (helper)

  async observe(): Promise<MacObservation> {
    const r = await this.call<{
      app: string;
      windowTitle?: string;
      focusedElement?: string;
      text: string;
      screenshotPngBase64?: string;
    }>("observe", {});
    return {
      app: r.app,
      windowTitle: r.windowTitle,
      focusedElement: r.focusedElement,
      text: r.text,
      // v0.6: the helper includes the frame only when Screen
      // Recording is granted; pass it through for the panel's
      // Watch view (MacService never forwards it to the model).
      ...(typeof r.screenshotPngBase64 === "string" && r.screenshotPngBase64
        ? { screenshotPngBase64: r.screenshotPngBase64 }
        : {}),
    };
  }

  async probe(): Promise<MacProbe> {
    const r = await this.call<{
      frontApp: string;
      windowTitle?: string;
      focusedElement?: string;
      pickerSelection?: string;
    }>("probe", {});
    return {
      frontApp: r.frontApp,
      windowTitle: r.windowTitle,
      focusedElement: r.focusedElement,
      pickerSelection: r.pickerSelection,
    };
  }

  async click(args: MacClickArgs): Promise<string> {
    return this.call<string>("click", {
      ...(args.element !== undefined ? { element: args.element } : {}),
      ...(args.x !== undefined ? { x: args.x } : {}),
      ...(args.y !== undefined ? { y: args.y } : {}),
    });
  }

  async typeText(text: string): Promise<string> {
    return this.call<string>("type", { text });
  }

  async key(combo: string): Promise<string> {
    return this.call<string>("key", { combo });
  }

  async scroll(direction: MacScrollDirection, amount: number): Promise<string> {
    return this.call<string>("scroll", { direction, amount });
  }

  async openApp(app: string): Promise<string> {
    return this.call<string>("openApp", { app });
  }

  async focusWindow(args: { app?: string; title?: string }): Promise<string> {
    return this.call<string>("focusWindow", {
      ...(args.app !== undefined ? { app: args.app } : {}),
      ...(args.title !== undefined ? { title: args.title } : {}),
    });
  }

  async pickerSelect(absPath: string): Promise<string> {
    return this.call<string>("pickerSelect", { path: absPath });
  }

  // ------------------------------------------------------- local (host)

  async readFile(absPath: string): Promise<string> {
    return readFile(absPath, "utf8");
  }

  async writeFile(absPath: string, content: string): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf8");
  }

  /**
   * Run the exact command string the classifier approved, verbatim,
   * via the login shell in the given (already jail-checked) working
   * directory. A non-zero exit is a RESULT, not a throw — MacService
   * verifies by exit code. A shell that cannot even start is exit
   * 127 with the reason on stderr, same convention.
   */
  async shellRun(command: string, cwd: string): Promise<MacShellResult> {
    return new Promise<MacShellResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.shellPath, ["-lc", command], { cwd });
      } catch (e) {
        resolve({ exitCode: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
        return;
      }
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => { stdout += d.toString("utf8"); });
      child.stderr?.on("data", (d) => { stderr += d.toString("utf8"); });
      child.on("error", (e) => {
        resolve({ exitCode: 127, stdout, stderr: stderr || e.message });
      });
      child.on("close", (code, signal) => {
        resolve({
          exitCode: code ?? (signal ? 128 : 1),
          stdout,
          stderr: stderr || (signal ? `terminated by signal ${signal}` : ""),
        });
      });
    });
  }
}

function isSocketAbsent(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

/**
 * The main.ts wiring rule: a LAZY adapter that decides per call, not
 * once at boot. The native adapter is picked up the first time the
 * helper is plausibly present (GUS_MAC_HOST=1 forces it, or the
 * helper socket file exists) and kept from then on; until then every
 * call refuses plainly via the unavailable adapter, so a non-Mac host
 * (or a Mac before the install sitting) keeps failing mac_* calls
 * loudly and honestly instead of timing out against a socket that
 * will never exist.
 *
 * Why per call (field fix, 2026-11-05): the Phase 8 rule decided once
 * at control-plane boot. When GUS.app and the control plane started
 * in the same second, the check ran before the helper had bound its
 * socket and the process wired "unavailable" for its whole lifetime
 * — every mac_* call refused with "not installed" while the helper
 * sat healthy. Resolving lazily makes the wiring follow the helper
 * whenever it appears.
 * `exists` and the native factory are injectable for the unit suite.
 */
export class LazyMacHostAdapter implements MacHostAdapter {
  readonly socketPath: string;
  private native?: MacHostAdapter;
  private readonly unavailable = new UnavailableMacHostAdapter();

  constructor(
    socketPath: string,
    private readonly forced: boolean,
    private readonly exists: (path: string) => boolean,
    private readonly makeNative: (socketPath: string) => MacHostAdapter,
  ) {
    this.socketPath = socketPath;
  }

  private inner(): MacHostAdapter {
    if (this.native) return this.native;
    if (this.forced || this.exists(this.socketPath)) {
      this.native = this.makeNative(this.socketPath);
      return this.native;
    }
    return this.unavailable;
  }

  async observe(): Promise<MacObservation> {
    return this.inner().observe();
  }
  async probe(): Promise<MacProbe> {
    return this.inner().probe();
  }
  async click(args: MacClickArgs): Promise<string> {
    return this.inner().click(args);
  }
  async typeText(text: string): Promise<string> {
    return this.inner().typeText(text);
  }
  async key(combo: string): Promise<string> {
    return this.inner().key(combo);
  }
  async scroll(direction: MacScrollDirection, amount: number): Promise<string> {
    return this.inner().scroll(direction, amount);
  }
  async openApp(app: string): Promise<string> {
    return this.inner().openApp(app);
  }
  async focusWindow(args: { app?: string; title?: string }): Promise<string> {
    return this.inner().focusWindow(args);
  }
  async readFile(absPath: string): Promise<string> {
    return this.inner().readFile(absPath);
  }
  async writeFile(absPath: string, content: string): Promise<void> {
    return this.inner().writeFile(absPath, content);
  }
  async shellRun(command: string, cwd: string): Promise<MacShellResult> {
    return this.inner().shellRun(command, cwd);
  }
  async pickerSelect(absPath: string): Promise<string> {
    return this.inner().pickerSelect(absPath);
  }
}

export function createMacHostAdapter(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  makeNative: (socketPath: string) => MacHostAdapter = (socketPath) =>
    new NativeMacHostAdapter({ socketPath }),
): MacHostAdapter {
  const socketPath = env.GUS_MAC_HOST_SOCKET ?? DEFAULT_MAC_HOST_SOCKET;
  return new LazyMacHostAdapter(socketPath, env.GUS_MAC_HOST === "1", exists, makeNative);
}
