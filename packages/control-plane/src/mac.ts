/**
 * The Mac-control pack (Phase 7) — GUS resident on the operator's Mac.
 *
 * The scope (docs/mac-resident.md): the iMac is a dedicated agent box —
 * "the box is the sandbox" — and this pack is how the control plane
 * drives it. Like the Gmail pack, mac_* tools execute HERE, in the
 * control plane, never in the sandbox: the runtime proposes, the
 * classifier (policy.ts) decides, and this service performs the action
 * through a MacHostAdapter, verifies the post-condition against the
 * host's actual state, and returns a verified outcome. Nothing reports
 * success on the adapter's say-so alone, and nothing fails silently.
 *
 * The host adapter is the seam the residency install fills: THIS repo
 * ships the contract, a FakeMacHostAdapter (in-memory desktop for the
 * unit tests and drills — same interface, same service code path), and
 * an UnavailableMacHostAdapter that refuses plainly until the native
 * bridge lands with the install sitting. The adapter's mutating input
 * actions return a receipt string in the pack's canonical form
 * (macActionReceipt) — the service compares it to the exact action it
 * requested, so a misdirected click or a half-typed string is a
 * failed-loudly outcome, not a quiet wrong one.
 *
 * Jail discipline (execution side, in code): fs paths and shell
 * working directories must resolve inside the operator's approved
 * work directories (policy.json's `mac.workDirs`) — an approval
 * authorizes an ACTION; it never widens the jail, exactly like the
 * workspace jail in the runtime. Shell commands run only in those
 * directories. Content that crosses back toward the model (desktop
 * observations, file contents, shell output) passes the Phase 4
 * Shield gate's tool-result surface first; text typed INTO the host
 * passes the outbound secret-guard (S1 patterns + vault values),
 * because typing is a send to wherever the focus happens to be.
 */
import { resolve as resolvePath, sep } from "node:path";
import { screenText, type ToolClass } from "@gus/shared";
import { sha256Hex, DEFAULT_SHIELD_POLICY } from "@gus/gate";
import type { VaultBroker } from "@gus/vault";
import type { PolicyData } from "./policy.js";
import type { GmailShieldScanner } from "./gmail.js";

// ------------------------------------------------------------- tool shape

export const MAC_TOOL_CLASSES: Record<string, ToolClass> = {
  "mac.observe": "read",
  "mac.fs.read": "read",
  "mac.open_app": "write",
  "mac.focus_window": "write",
  "mac.click": "write",
  "mac.type": "write",
  "mac.key": "write",
  "mac.scroll": "write",
  "mac.fs.write": "write",
  "mac.shell.run": "write",
  "mac.picker.select": "write",
};

/** Any mac.* name routes to the pack: known tools are in
 *  MAC_TOOL_CLASSES; an UNRECOGNIZED mac.* name still lands here so
 *  the classifier can park it by default and the service can refuse
 *  it plainly, instead of it slipping through the generic defaults. */
export function isMacTool(tool: string): boolean {
  return tool.startsWith("mac.");
}

/** The permission-model action class a mac tool belongs to. */
export function macActionClass(tool: string): string {
  return tool.replace(/^mac\./, "mac-").replace(/\./g, "-");
}

// ------------------------------------------------------------------- jail

/** Normalize an operator work directory for jail comparisons. */
function jailRoot(dir: string): string {
  return resolvePath(dir);
}

/**
 * Resolve a mac.fs path against the jail: absolute paths stand as
 * they are; relative paths resolve against the FIRST approved work
 * directory (the pack's home base). Returns the resolved absolute
 * path when it sits inside some approved work directory, else null.
 * `..` escapes collapse under resolve() and fall outside the prefix
 * check — the same rule the runtime workspace jail enforces.
 */
export function macResolveJailed(rawPath: string, workDirs: string[]): string | null {
  if (typeof rawPath !== "string" || rawPath.trim() === "") return null;
  const candidate = rawPath.startsWith("/")
    ? resolvePath(rawPath)
    : workDirs.length > 0
      ? resolvePath(workDirs[0], rawPath)
      : null;
  if (candidate === null) return null;
  return macJailContains(candidate, workDirs) ? candidate : null;
}

/** True when an already-resolved absolute path is a work directory
 *  itself or lives under one. */
export function macJailContains(absPath: string, workDirs: string[]): boolean {
  const candidate = resolvePath(absPath);
  for (const dir of workDirs) {
    const root = jailRoot(dir);
    if (candidate === root || candidate.startsWith(root + sep)) return true;
  }
  return false;
}

// -------------------------------------------------------- shell classification

export type MacScrollDirection = "up" | "down" | "left" | "right";

export interface ShellClassification {
  action: "allow" | "needs-approval";
  /** The severity a parked command carries (deletes and destructive
   *  patterns park as "destructive"; everything else as "write"). */
  severity: "write" | "destructive";
  reason: string;
}

/** Split a command line into segments on &&, ||, ; and | — the
 *  classifier judges EVERY segment; a chain is only as approved as
 *  its worst link. Classification-only tokenization (simple quote
 *  handling); execution runs the operator-approved string verbatim
 *  on the host, never a reassembly. */
export function shellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function shellTokens(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function programOf(tokens: string[]): string {
  const raw = tokens[0] ?? "";
  return raw.split("/").pop() ?? raw;
}

function firstNonFlagArg(tokens: string[]): string | undefined {
  return tokens.slice(1).find((t) => !t.startsWith("-"));
}

/** Park rules that beat the allowlist, with the operator-facing
 *  reason. Deletes park under the Yue rule; the rest park because
 *  the scope's Once list names them (installs, credential-adjacent,
 *  external publishing) or because they can reach outside the jail's
 *  accounting (moves/copies, network shells, privilege). */
function shellParkRule(program: string, tokens: string[]): { severity: "write" | "destructive"; reason: string } | null {
  const sub = firstNonFlagArg(tokens);
  switch (program) {
    case "rm":
      return {
        severity: "destructive",
        reason: "the command deletes files (rm) — deletes always need a one-time approval; standing approvals and the shell allowlist never cover deletes (the Yue rule)",
      };
    case "sudo":
      return { severity: "destructive", reason: "the command elevates privilege (sudo) — privilege changes always need a one-time approval" };
    case "dd":
    case "mkfs":
    case "diskutil":
    case "shutdown":
    case "reboot":
    case "halt":
    case "poweroff":
      return { severity: "destructive", reason: `the command is a destructive system operation (${program}) — always needs a one-time approval` };
    case "kill":
    case "killall":
    case "pkill":
      return { severity: "destructive", reason: `the command controls other processes (${program}) — always needs a one-time approval` };
    case "mv":
    case "cp":
      return {
        severity: "destructive",
        reason: `the command ${program === "mv" ? "moves" : "copies"} files — it can overwrite or relocate files outside the fs jail's accounting, so it always needs a one-time approval`,
      };
    case "git":
      if (sub === "push") {
        return { severity: "write", reason: "the command publishes externally (git push) — external sends/posts always need a one-time approval" };
      }
      return null;
    case "ssh":
    case "scp":
    case "sftp":
    case "rsync":
      return { severity: "write", reason: `the command opens a network shell (${program}) outside the egress proxy — always needs a one-time approval` };
    case "curl":
    case "wget":
      return { severity: "write", reason: `the command fetches over the network (${program}) outside the egress proxy — always needs a one-time approval` };
    case "security":
      return { severity: "write", reason: "the command is credential-adjacent (the macOS keychain CLI) — always needs a one-time approval" };
    case "brew":
    case "pip":
    case "pip3":
    case "gem":
    case "apt":
    case "apt-get":
      return { severity: "write", reason: `the command installs software (${program}) — installs always need a one-time approval` };
    case "npm":
    case "yarn":
    case "pnpm":
      if (sub === "install" || sub === "add" || sub === "i") {
        return { severity: "write", reason: `the command installs packages (${program} ${sub}) — installs always need a one-time approval` };
      }
      return null;
    case "cargo":
      if (sub === "install") {
        return { severity: "write", reason: "the command installs software (cargo install) — installs always need a one-time approval" };
      }
      return null;
    case "chmod":
    case "chown":
      if (tokens.some((t) => t === "-R" || t === "--recursive")) {
        return { severity: "destructive", reason: `the command recursively changes file permissions (${program} -R) — always needs a one-time approval` };
      }
      return null;
    default:
      return null;
  }
}

/** Allowlist entries match as a token PREFIX of the segment:
 *  "npm run build" covers `npm run build` and `npm run build --watch`;
 *  "git status" covers `git status -s`; a bare program name ("ls")
 *  covers that program with any arguments. */
function allowlistMatch(segmentTokens: string[], allowlist: string[]): string | null {
  for (const entry of allowlist) {
    const parts = entry.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts.length > segmentTokens.length) continue;
    if (parts.every((p, i) => p === segmentTokens[i])) return entry;
  }
  return null;
}

/**
 * Classify a mac.shell.run command against the operator's allowlist.
 * Every segment must be allowlisted and no segment may trip a park
 * rule; anything else parks as a Once. Compound syntax that hides
 * work from the classifier (redirection, substitution) parks too —
 * an allowlisted build does not need it.
 */
export function classifyShellCommand(command: string, allowlist: string[]): ShellClassification {
  const park = (severity: "write" | "destructive", reason: string): ShellClassification => ({
    action: "needs-approval",
    severity,
    reason,
  });
  if (typeof command !== "string" || command.trim() === "") {
    return park("write", "mac.shell.run names no command — a shell approval must name exactly what runs");
  }
  if (/[`>]|\$\(/.test(command)) {
    return park(
      "write",
      "the command uses redirection or substitution, which hides work from the classifier — shell commands like that always need a one-time approval",
    );
  }
  const segments = shellSegments(command);
  if (segments.length === 0) {
    return park("write", "mac.shell.run names no command — a shell approval must name exactly what runs");
  }
  const matched: string[] = [];
  for (const segment of segments) {
    const tokens = shellTokens(segment);
    if (tokens.length === 0) continue;
    const rule = shellParkRule(programOf(tokens), tokens);
    if (rule) return park(rule.severity, rule.reason);
    const hit = allowlistMatch(tokens, allowlist);
    if (!hit) {
      return park(
        "write",
        `shell command "${segment}" is not on the operator's allowlist — non-allowlisted shell always needs a one-time approval`,
      );
    }
    matched.push(hit);
  }
  return {
    action: "allow",
    severity: "write",
    reason: `shell command on the operator's allowlist (${matched.join("; ")}) in an approved work directory`,
  };
}

// ------------------------------------------------------------ host adapter

export interface MacObservation {
  /** Frontmost application, as the host reports it. */
  app: string;
  windowTitle?: string;
  focusedElement?: string;
  /** The accessibility tree (or its digest form) as plain text. */
  text: string;
}

export interface MacProbe {
  frontApp: string;
  windowTitle?: string;
  focusedElement?: string;
  pickerSelection?: string;
}

export interface MacClickArgs {
  element?: string;
  x?: number;
  y?: number;
}

export interface MacShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The host seam. A real adapter (native bridge on the resident Mac)
 * implements exactly this; the pack's service code path is identical
 * either way. Mutating input actions return a receipt string in the
 * canonical form macActionReceipt produces — the service compares it
 * against the action it requested, so the adapter must report what it
 * actually applied, verbatim.
 */
export interface MacHostAdapter {
  observe(): Promise<MacObservation>;
  probe(): Promise<MacProbe>;
  click(args: MacClickArgs): Promise<string>;
  typeText(text: string): Promise<string>;
  key(combo: string): Promise<string>;
  scroll(direction: MacScrollDirection, amount: number): Promise<string>;
  openApp(app: string): Promise<string>;
  focusWindow(args: { app?: string; title?: string }): Promise<string>;
  readFile(absPath: string): Promise<string>;
  writeFile(absPath: string, content: string): Promise<void>;
  shellRun(command: string, cwd: string): Promise<MacShellResult>;
  pickerSelect(absPath: string): Promise<string>;
}

/** The canonical receipt an adapter returns for an input action —
 *  the exact string the service expects back for the exact call it
 *  made. Shared so the future native bridge implements one form. */
export function macActionReceipt(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "mac.click": {
      const target =
        typeof args.element === "string" && args.element
          ? `element "${args.element}"`
          : `point (${String(args.x ?? "?")}, ${String(args.y ?? "?")})`;
      return `clicked ${target}`;
    }
    case "mac.type":
      return `typed ${String(args.text ?? "").length} chars`;
    case "mac.key":
      return `pressed ${String(args.combo ?? args.key ?? "")}`;
    case "mac.scroll":
      return `scrolled ${String(args.direction ?? "")} by ${String(args.amount ?? "")}`;
    case "mac.open_app":
      return `opened "${String(args.app ?? "")}"`;
    case "mac.focus_window":
      return `focused ${typeof args.title === "string" && args.title ? `window "${args.title}"` : `app "${String(args.app ?? "")}"`}`;
    case "mac.picker.select":
      return `selected "${String(args.path ?? "")}"`;
    default:
      return `applied ${tool}`;
  }
}

/**
 * In-memory desktop for tests and drills. Faithful to the interface's
 * semantics: writes land in a file map the service reads back through
 * the same adapter, the probe reports the state the actions actually
 * produced, shell results are scripted per exact command (with an
 * `echo` behavior and exit-0 default), and every call is logged so
 * tests can prove what did NOT happen (a refused type leaves `calls`
 * without a "type" entry). `failActions` injects adapter failures —
 * the service must turn each into a failed-loudly outcome.
 */
export class FakeMacHostAdapter implements MacHostAdapter {
  readonly calls: string[] = [];
  readonly files = new Map<string, string>();
  readonly shellResults = new Map<string, MacShellResult>();
  readonly failActions = new Set<string>();
  state = {
    frontApp: "Finder",
    windowTitle: "Desktop",
    focusedElement: undefined as string | undefined,
    pickerSelection: undefined as string | undefined,
  };

  constructor(seedFiles: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(seedFiles)) this.files.set(p, c);
  }

  private guard(action: string): void {
    this.calls.push(action);
    if (this.failActions.has(action)) {
      throw new Error(`fake mac host: ${action} failed (injected failure)`);
    }
  }

  async observe(): Promise<MacObservation> {
    this.guard("observe");
    return {
      app: this.state.frontApp,
      windowTitle: this.state.windowTitle,
      focusedElement: this.state.focusedElement,
      text:
        `front app: ${this.state.frontApp}; window: ${this.state.windowTitle}` +
        (this.state.focusedElement ? `; focused: ${this.state.focusedElement}` : ""),
    };
  }

  async probe(): Promise<MacProbe> {
    return {
      frontApp: this.state.frontApp,
      windowTitle: this.state.windowTitle,
      focusedElement: this.state.focusedElement,
      pickerSelection: this.state.pickerSelection,
    };
  }

  async click(args: MacClickArgs): Promise<string> {
    this.guard("click");
    this.state.focusedElement = args.element ?? `point (${args.x ?? "?"}, ${args.y ?? "?"})`;
    return macActionReceipt("mac.click", args as Record<string, unknown>);
  }

  async typeText(text: string): Promise<string> {
    this.guard("type");
    return macActionReceipt("mac.type", { text });
  }

  async key(combo: string): Promise<string> {
    this.guard("key");
    return macActionReceipt("mac.key", { combo });
  }

  async scroll(direction: MacScrollDirection, amount: number): Promise<string> {
    this.guard("scroll");
    return macActionReceipt("mac.scroll", { direction, amount });
  }

  async openApp(app: string): Promise<string> {
    this.guard("open_app");
    this.state.frontApp = app;
    this.state.windowTitle = app;
    return macActionReceipt("mac.open_app", { app });
  }

  async focusWindow(args: { app?: string; title?: string }): Promise<string> {
    this.guard("focus_window");
    if (args.app) this.state.frontApp = args.app;
    if (args.title) this.state.windowTitle = args.title;
    return macActionReceipt("mac.focus_window", args as Record<string, unknown>);
  }

  async readFile(absPath: string): Promise<string> {
    this.guard("fs.read");
    const content = this.files.get(absPath);
    if (content === undefined) throw new Error(`no such file: ${absPath}`);
    return content;
  }

  async writeFile(absPath: string, content: string): Promise<void> {
    this.guard("fs.write");
    this.files.set(absPath, content);
  }

  async shellRun(command: string, _cwd: string): Promise<MacShellResult> {
    this.guard("shell");
    const scripted = this.shellResults.get(command);
    if (scripted) return scripted;
    if (command.startsWith("echo ")) return { exitCode: 0, stdout: command.slice(5) + "\n", stderr: "" };
    if (command === "false") return { exitCode: 1, stdout: "", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async pickerSelect(absPath: string): Promise<string> {
    this.guard("picker");
    this.state.pickerSelection = absPath;
    return macActionReceipt("mac.picker.select", { path: absPath });
  }
}

/**
 * The adapter the control plane wires until the residency install
 * lands the native bridge: every call refuses plainly, so a mac_*
 * tool on any other host fails loudly with the pointer instead of
 * pretending a desktop exists. Same discipline as the Gmail pack
 * before its OAuth secret is stored.
 */
export class UnavailableMacHostAdapter implements MacHostAdapter {
  private refuse(): never {
    throw new Error(
      "the Mac host adapter is not installed on this host — the Phase 7 residency install (docs/mac-resident.md) lands the native bridge; until then mac_* tools cannot execute here",
    );
  }
  async observe(): Promise<MacObservation> { return this.refuse(); }
  async probe(): Promise<MacProbe> { return this.refuse(); }
  async click(_args: MacClickArgs): Promise<string> { return this.refuse(); }
  async typeText(_text: string): Promise<string> { return this.refuse(); }
  async key(_combo: string): Promise<string> { return this.refuse(); }
  async scroll(_direction: MacScrollDirection, _amount: number): Promise<string> { return this.refuse(); }
  async openApp(_app: string): Promise<string> { return this.refuse(); }
  async focusWindow(_args: { app?: string; title?: string }): Promise<string> { return this.refuse(); }
  async readFile(_absPath: string): Promise<string> { return this.refuse(); }
  async writeFile(_absPath: string, _content: string): Promise<void> { return this.refuse(); }
  async shellRun(_command: string, _cwd: string): Promise<MacShellResult> { return this.refuse(); }
  async pickerSelect(_absPath: string): Promise<string> { return this.refuse(); }
}

// ------------------------------------------------------------------ service

export interface MacOutcome {
  ok: boolean;
  summary: string;
  /**
   * True for hard refusals and execution failures (jail escape at
   * execution, secret-guard hit, adapter error, unverifiable
   * post-condition): the CommServer settles the job failed-loudly,
   * like an egress refusal. Absent/false for outcomes the model may
   * simply hear — above all a Shield-withheld observation or read,
   * which mirrors a blocked fetch result: the job continues, the
   * content never crossed.
   */
  refused?: boolean;
}

const MAX_CONTENT_CHARS = 12_000;
const MAX_SHELL_OUTPUT_CHARS = 2_000;

/**
 * Executes mac_* tools in the control plane. Called by the CommServer
 * only AFTER the classifier allowed the call (or consumed a one-time
 * approval bound to these exact arguments) — the service itself never
 * decides permissions; it enforces the jail and the content rules and
 * verifies every outcome against the host.
 */
export class MacService {
  constructor(
    private adapter: MacHostAdapter,
    private opts: {
      /** The operator's approved work directories, re-read per call
       *  (policy edits are live, like every policy read in GUS). */
      workDirs: () => string[];
      shield?: GmailShieldScanner;
      vault?: VaultBroker;
    },
  ) {}

  async execute(jobId: string, tool: string, args: Record<string, unknown>): Promise<MacOutcome> {
    try {
      switch (tool) {
        case "mac.observe":
          return await this.observe(jobId);
        case "mac.fs.read":
          return await this.fsRead(jobId, args);
        case "mac.fs.write":
          return await this.fsWrite(args);
        case "mac.shell.run":
          return await this.shellRun(jobId, args);
        case "mac.open_app":
          return await this.openApp(args);
        case "mac.focus_window":
          return await this.focusWindow(args);
        case "mac.click":
          return await this.inputAction("mac.click", args, () =>
            this.adapter.click({
              element: typeof args.element === "string" ? args.element : undefined,
              x: typeof args.x === "number" ? args.x : undefined,
              y: typeof args.y === "number" ? args.y : undefined,
            }),
          );
        case "mac.type":
          return await this.typeText(args);
        case "mac.key":
          return await this.inputAction("mac.key", args, () =>
            this.adapter.key(String(args.combo ?? args.key ?? "")),
          );
        case "mac.scroll":
          return await this.inputAction("mac.scroll", args, () =>
            this.adapter.scroll(
              (String(args.direction ?? "down") as MacScrollDirection),
              Number(args.amount ?? 3) || 3,
            ),
          );
        case "mac.picker.select":
          return await this.pickerSelect(args);
        default:
          return { ok: false, refused: true, summary: `unknown mac tool "${tool}" — nothing executed` };
      }
    } catch (e) {
      const detail = screenText(e instanceof Error ? e.message : String(e)).redacted;
      return { ok: false, refused: true, summary: `${tool} failed loudly: ${detail}` };
    }
  }

  // ------------------------------------------------------------- helpers

  /** Scan content that is about to cross toward the model. Returns
   *  the text the model may see, or null when the gate blocks it
   *  (withheld). Flagged or unscanned content is annotated, never
   *  silently trusted — the Gmail pack's inbound rule, verbatim. */
  private async scanTowardModel(
    jobId: string,
    content: string,
  ): Promise<{ text: string; note?: string } | null> {
    if (!this.opts.shield) {
      return { text: content, note: "the Shield gate is not wired into the Mac pack — content unscanned" };
    }
    const d = await this.opts.shield.scanSurface("tool-result", jobId, content);
    if (d.action === "block") return null;
    if (d.action === "flag") return { text: content, note: `shield note: ${d.detail}` };
    if (!d.scanned) return { text: content, note: d.detail };
    return { text: content };
  }

  private jailedPath(tool: string, args: Record<string, unknown>): string | MacOutcome {
    const raw = typeof args.path === "string" ? args.path : "";
    if (!raw) {
      return { ok: false, refused: true, summary: `${tool} failed loudly: no path named (arg \`path\`)` };
    }
    const resolved = macResolveJailed(raw, this.opts.workDirs());
    if (resolved === null) {
      return {
        ok: false,
        refused: true,
        summary:
          `${tool} failed loudly: path "${raw}" is outside the approved work directories — ` +
          `the fs jail applies at execution even to approved actions; nothing was touched`,
      };
    }
    return resolved;
  }

  /** Verify an input action by its canonical adapter receipt. */
  private async inputAction(
    tool: string,
    args: Record<string, unknown>,
    run: () => Promise<string>,
  ): Promise<MacOutcome> {
    const expected = macActionReceipt(tool, args);
    const applied = await run();
    if (applied !== expected) {
      return {
        ok: false,
        refused: true,
        summary: `${tool} failed loudly: the host reported "${applied}" — not the requested "${expected}"; the post-condition does not hold`,
      };
    }
    return { ok: true, summary: `${tool} verified: ${applied}` };
  }

  // --------------------------------------------------------------- tools

  private async observe(jobId: string): Promise<MacOutcome> {
    const obs = await this.adapter.observe();
    const scanned = await this.scanTowardModel(jobId, obs.text);
    if (!scanned) {
      return {
        ok: false,
        summary:
          `the desktop observation (front app ${obs.app}) was withheld by the Agent-Shield gate — ` +
          `nothing from it was shown to the agent`,
      };
    }
    return {
      ok: true,
      summary:
        `mac.observe: front app=${obs.app}` +
        (obs.windowTitle ? ` window=${JSON.stringify(obs.windowTitle)}` : "") +
        (obs.focusedElement ? ` focused=${JSON.stringify(obs.focusedElement)}` : "") +
        (scanned.note ? ` (${scanned.note})` : "") +
        `\n${scanned.text.slice(0, MAX_CONTENT_CHARS)}`,
    };
  }

  private async fsRead(jobId: string, args: Record<string, unknown>): Promise<MacOutcome> {
    const path = this.jailedPath("mac.fs.read", args);
    if (typeof path !== "string") return path;
    const content = await this.adapter.readFile(path);
    const scanned = await this.scanTowardModel(jobId, content);
    if (!scanned) {
      return {
        ok: false,
        summary: `the content of ${path} was withheld by the Agent-Shield gate — nothing from it was shown to the agent`,
      };
    }
    const body =
      scanned.text.length > MAX_CONTENT_CHARS
        ? scanned.text.slice(0, MAX_CONTENT_CHARS) + `\n[content truncated at ${MAX_CONTENT_CHARS} chars]`
        : scanned.text;
    return {
      ok: true,
      summary: `mac.fs.read ${path} (${content.length} chars, sha256 ${sha256Hex(content).slice(0, 12)}…)` + (scanned.note ? ` (${scanned.note})` : "") + `\n${body}`,
    };
  }

  private async fsWrite(args: Record<string, unknown>): Promise<MacOutcome> {
    const path = this.jailedPath("mac.fs.write", args);
    if (typeof path !== "string") return path;
    const content = String(args.content ?? "");
    await this.adapter.writeFile(path, content);
    // Post-condition: read the file back through the host and compare
    // digests — the write is verified-done only if the bytes are there.
    const back = await this.adapter.readFile(path);
    if (sha256Hex(back) !== sha256Hex(content)) {
      return {
        ok: false,
        refused: true,
        summary: `mac.fs.write failed loudly: the read-back of ${path} does not match what was written (sha256 mismatch)`,
      };
    }
    return {
      ok: true,
      summary: `mac.fs.write verified: ${path} (${content.length} chars, sha256 ${sha256Hex(content).slice(0, 12)}…)`,
    };
  }

  private async shellRun(jobId: string, args: Record<string, unknown>): Promise<MacOutcome> {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) {
      return { ok: false, refused: true, summary: "mac.shell.run failed loudly: no command named (arg `command`)" };
    }
    const workDirs = this.opts.workDirs();
    const cwdRaw = typeof args.cwd === "string" && args.cwd ? args.cwd : (workDirs[0] ?? "");
    const cwd = cwdRaw.startsWith("/") ? resolvePath(cwdRaw) : workDirs[0] ? resolvePath(workDirs[0], cwdRaw) : "";
    if (!cwd || !macJailContains(cwd, workDirs)) {
      return {
        ok: false,
        refused: true,
        summary:
          `mac.shell.run failed loudly: working directory "${cwdRaw}" is outside the approved work directories — ` +
          `shell runs only inside the jail, even when approved; nothing ran`,
      };
    }
    const r = await this.adapter.shellRun(command, cwd);
    if (r.exitCode !== 0) {
      const tail = (r.stderr || r.stdout).trim().slice(0, MAX_SHELL_OUTPUT_CHARS);
      return {
        ok: false,
        refused: true,
        summary: `mac.shell.run failed loudly: exit ${r.exitCode} in ${cwd}: ${JSON.stringify(command)}${tail ? ` — ${tail}` : ""}`,
      };
    }
    let outNote = "";
    if (r.stdout.trim()) {
      const scanned = await this.scanTowardModel(jobId, r.stdout);
      if (!scanned) {
        return {
          ok: false,
          summary: `mac.shell.run ran (exit 0) in ${cwd}: ${JSON.stringify(command)} — but its output was withheld by the Agent-Shield gate and not shown`,
        };
      }
      outNote = `; output: ${scanned.text.trim().slice(0, MAX_SHELL_OUTPUT_CHARS)}` + (scanned.note ? ` (${scanned.note})` : "");
    }
    return { ok: true, summary: `mac.shell.run verified (exit 0) in ${cwd}: ${JSON.stringify(command)}${outNote}` };
  }

  private async openApp(args: Record<string, unknown>): Promise<MacOutcome> {
    const app = typeof args.app === "string" ? args.app : "";
    if (!app) return { ok: false, refused: true, summary: "mac.open_app failed loudly: no app named (arg `app`)" };
    await this.adapter.openApp(app);
    const probe = await this.adapter.probe();
    if (probe.frontApp !== app) {
      return {
        ok: false,
        refused: true,
        summary: `mac.open_app failed loudly: the host's front app is "${probe.frontApp}", not "${app}" — the open did not take`,
      };
    }
    return { ok: true, summary: `mac.open_app verified: "${app}" is the front app` };
  }

  private async focusWindow(args: Record<string, unknown>): Promise<MacOutcome> {
    const app = typeof args.app === "string" ? args.app : undefined;
    const title = typeof args.title === "string" ? args.title : undefined;
    if (!app && !title) {
      return { ok: false, refused: true, summary: "mac.focus_window failed loudly: neither app nor title named" };
    }
    await this.adapter.focusWindow({ app, title });
    const probe = await this.adapter.probe();
    if (app && probe.frontApp !== app) {
      return { ok: false, refused: true, summary: `mac.focus_window failed loudly: the host's front app is "${probe.frontApp}", not "${app}"` };
    }
    if (title && probe.windowTitle !== title) {
      return { ok: false, refused: true, summary: `mac.focus_window failed loudly: the focused window is "${probe.windowTitle ?? "?"}", not "${title}"` };
    }
    return { ok: true, summary: `mac.focus_window verified: front app=${probe.frontApp} window=${JSON.stringify(probe.windowTitle ?? "")}` };
  }

  private async typeText(args: Record<string, unknown>): Promise<MacOutcome> {
    const text = String(args.text ?? "");
    // Typing is an outbound send to wherever the focus is: the
    // secret-guard runs first (classes and secret NAMES only in the
    // refusal — never a value), exactly like outbound mail.
    const screened = screenText(text);
    if (!screened.clean) {
      const classes = [...new Set(screened.findings.map((f) => f.patternClass))].join(", ");
      return {
        ok: false,
        refused: true,
        summary: `mac.type refused by the secret-guard: the text matches secret pattern(s) [${classes}] — nothing was typed`,
      };
    }
    if (this.opts.vault) {
      const names = this.opts.vault.findValuesIn(text);
      if (names.length > 0) {
        return {
          ok: false,
          refused: true,
          summary: `mac.type refused by the secret-guard: the text contains the stored vault secret(s) named [${names.join(", ")}] — nothing was typed`,
        };
      }
    }
    return this.inputAction("mac.type", args, () => this.adapter.typeText(text));
  }

  private async pickerSelect(args: Record<string, unknown>): Promise<MacOutcome> {
    // NOT fs-jailed, deliberately: the picker's whole job is choosing
    // a file the operator is looking at (an upload in ~/Downloads,
    // say), and the classifier parks every picker.select as a Once
    // whose approval names this exact path — the operator's tap is
    // the control. The jail governs mac.fs.* and shell cwd, whose
    // calls can proceed without a per-action approval.
    const raw = typeof args.path === "string" ? args.path : "";
    if (!raw) {
      return { ok: false, refused: true, summary: "mac.picker.select failed loudly: no path named (arg `path`)" };
    }
    const outcome = await this.inputAction("mac.picker.select", args, () =>
      this.adapter.pickerSelect(raw),
    );
    if (!outcome.ok) return outcome;
    const probe = await this.adapter.probe();
    if (probe.pickerSelection !== undefined && probe.pickerSelection !== raw) {
      return {
        ok: false,
        refused: true,
        summary: `mac.picker.select failed loudly: the picker's selection is "${probe.pickerSelection}", not "${raw}"`,
      };
    }
    return { ok: true, summary: `mac.picker.select verified: "${raw}" selected` };
  }
}

// ------------------------------------------------------- Nova policy template

/**
 * The shipped Nova policy template (the scope's recommended defaults,
 * piece 4) — written to <state>/policy.json by the residency install
 * (hosts/mac-resident) and mirrored verbatim in
 * docs/mac-policy-template.json (the unit suite asserts the two
 * agree). What "Always" means here, mechanically:
 *   - mac.observe / mac.open_app / mac.focus_window proceed;
 *   - mac.fs.read / mac.fs.write proceed INSIDE the work dirs below
 *     (the jail holds at execution even for approved actions);
 *   - mac.shell.run proceeds for the allowlisted build/test commands
 *     in those dirs; everything else — input injection, deletes,
 *     installs, sends, credential-adjacent shell — parks as a Once
 *     for a phone approval, and Never rules still win over all of it.
 * The operator edits workDirs to the real paths on their Mac; the
 * placeholder below approves nothing until they do (it names a home
 * that does not exist, and paths under it simply fail the jail).
 */
export const NOVA_MAC_POLICY_TEMPLATE: PolicyData = {
  version: 1,
  bulkThreshold: 5,
  approvalTimeoutMs: 10 * 60 * 1000,
  rules: [],
  shield: { ...DEFAULT_SHIELD_POLICY },
  standingApprovals: [],
  groups: {},
  mac: {
    workDirs: ["/Users/you/Projects"],
    shellAllowlist: [
      "npm test",
      "npm run build",
      "npm run test",
      "node --test",
      "git status",
      "git diff",
      "git log",
      "ls",
      "pwd",
      "make test",
      "make build",
      "cargo test",
      "cargo build",
      "go test",
      "go build",
      "pytest",
    ],
  },
};
