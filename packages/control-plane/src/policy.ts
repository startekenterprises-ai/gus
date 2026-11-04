/**
 * Policy store + action classifier (foundation spec §1.4) — Phase 2.
 *
 * The policy lives in a versioned, operator-owned file in control-plane
 * state (<state>/policy.json). It is NOT in the agent's context, NOT in
 * its memory files, and NOT writable from the sandbox — the sandbox has
 * no path to this file at all. Compaction can forget the conversation;
 * it cannot touch this file. That is the physical answer to the Yue
 * failure: "confirm before acting" was a sentence in a context window;
 * this is a check in the execution path.
 *
 * Classification is computed HERE, from the tool name + arguments —
 * never from the model's declared intent. The runtime supplies a
 * declaredClass with every call; the classifier treats it only as a
 * FLOOR (a call the tool itself declares destructive can never be
 * classified below needs-approval), never as permission to downgrade.
 *
 * Precedence (first match wins):
 *   1. Hard deny, in code, not policy-overridable: tools that must never
 *      run for the agent (vault_read — the vault has no read API).
 *   2. Policy rules with action "deny" (the "Never" of Phase 6).
 *   2b. Phase 6: gmail_* tools are classified by classifyGmail — the
 *      pack's own permission model (Once / Always / Never + the Yue
 *      hard lines in code). It runs here, after Never and before the
 *      generic class floor, because Always must be able to cover
 *      in-scope thread replies while the hard lines still park every
 *      delete, bulk action, and first-time send.
 *   2c. Phase 7: mac_* tools are classified by classifyMac — the Mac
 *      pack's permission model (the shipped Nova template's Always set
 *      in code + policy data: observation, app/window focus, fs inside
 *      the approved work dirs, allowlisted shell in those dirs;
 *      everything else is a Once). It runs in the same slot for the
 *      same reason, and it applies the declared-class floor itself.
 *   3. Built-in approval triggers: destructive / external-send / pay
 *      class floor; credential use (fetch naming a vault secret);
 *      writes whose path escapes the workspace jail; bulk operations
 *      (count or path list above the policy's bulk threshold).
 *   4. Policy rules (allow / needs-approval) for everything else.
 *   5. Default by class: read/write proceed; anything unrecognized
 *      parks (fail closed toward the operator, never toward the agent).
 *
 * A missing or malformed policy file yields the strict defaults below —
 * the built-in triggers in step 3 are code, so they hold even with no
 * file at all. The file is re-read on every classification: operator
 * edits are live on the next call.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import type { ToolClass } from "@gus/shared";
import { DEFAULT_SHIELD_POLICY, type ShieldPolicyView } from "@gus/gate";
import {
  gmailActionClass,
  gmailMessageIds,
  gmailRecipients,
  isGmailTool,
  normalizeAddress,
} from "./gmail.js";
import {
  classifyShellCommand,
  isMacTool,
  macJailContains,
  macResolveJailed,
} from "./mac.js";

export type PolicyAction = "allow" | "deny" | "needs-approval";

export interface PolicyRule {
  /** Exact tool name this rule applies to. */
  tool: string;
  /** Only matches calls that name a vault secret (credential use). */
  usesSecret?: boolean;
  /** Only matches calls whose numeric `count` arg (or path-list length)
   *  is at least this. */
  minCount?: number;
  /** Only matches workspace_write calls escaping the workspace jail. */
  outsideWorkspace?: boolean;
  action: PolicyAction;
  reason?: string;
}

/**
 * A standing approval — the "Always" of the Phase 6 permission model.
 *
 * The model has three settings, and they map onto three different
 * mechanisms on purpose:
 *   - Once  = the ApprovalEngine (approvals.ts): one exact action,
 *             hash-bound to its arguments, single use. The default.
 *   - Always = one of these records, in the operator's policy file:
 *             a standing approval scoped to an action class and,
 *             for sends, to a person, a domain, or an operator-named
 *             group. Consulted ONLY where the hard lines below allow
 *             standing approvals at all.
 *   - Never = a PolicyRule with action "deny". Deny rules are matched
 *             before everything else, so Never beats Always, always.
 *
 * The hard lines are CODE, not records — no policy file can soften
 * them (they are the Yue rules, named for the incident they answer):
 *   - Deletes are NEVER always-eligible: every gmail_delete needs a
 *     one-time approval enumerating the exact message IDs.
 *   - Bulk actions are NEVER always-eligible: any gmail action naming
 *     more than one message needs a one-time approval enumerating
 *     the exact message IDs.
 *   - First-time external recipients ALWAYS prompt: a send/reply to
 *     an address the mailbox has never corresponded with (the Gmail
 *     directory, gmail.ts) needs a one-time approval, standing
 *     approvals notwithstanding.
 */
export interface StandingApproval {
  /** Permission action class: "gmail-send" | "gmail-reply" | "gmail-modify". */
  actionClass: string;
  /** Recipient scope for send classes. Absent = every (known) recipient. */
  scopeType?: "person" | "domain" | "group";
  /** The person (address), domain, or group name, per scopeType. */
  scopeValue?: string;
  reason?: string;
}

export interface PolicyData {
  version: number;
  /** Bulk threshold: count/path-list at or above this needs approval. */
  bulkThreshold: number;
  /** Approval lifetime; an unanswered approval is a denial. */
  approvalTimeoutMs: number;
  rules: PolicyRule[];
  /** Phase 4: the Shield gate's operator policy (spec §1.7). */
  shield: ShieldPolicyView;
  /** Phase 6: standing approvals ("Always") — see StandingApproval. */
  standingApprovals: StandingApproval[];
  /** Phase 6: operator-named recipient groups for standing-approval
   *  scopes: group name → addresses and/or domains ("@example.com"
   *  or "example.com" entries match by domain). */
  groups: Record<string, string[]>;
  /** Phase 7: the Mac pack's operator data — the approved work
   *  directories (the fs/shell jail) and the shell allowlist. Empty
   *  defaults are strict: no work dirs = every mac fs path and shell
   *  cwd is outside the jail, so those calls park. */
  mac: MacPolicyData;
}

/** Phase 7 policy data for the Mac-control pack (mac.ts). */
export interface MacPolicyData {
  workDirs: string[];
  shellAllowlist: string[];
}

export const DEFAULT_POLICY: PolicyData = {
  version: 1,
  bulkThreshold: 5,
  approvalTimeoutMs: 10 * 60 * 1000,
  rules: [],
  shield: { ...DEFAULT_SHIELD_POLICY },
  standingApprovals: [],
  groups: {},
  mac: { workDirs: [], shellAllowlist: [] },
};

export interface ToolCallShape {
  tool: string;
  declaredClass: ToolClass;
  args: Record<string, unknown>;
}

export interface Classification {
  action: PolicyAction;
  /** The effective class after control-plane classification. */
  effectiveClass: ToolClass;
  /** Why — recorded on the job/approval, shown to the operator. */
  reason: string;
}

/** Tools the agent may never run, whatever any policy file says. */
const HARD_DENY: Record<string, string> = {
  vault_read: "the Vault Broker has no read API — secrets are used via egress injection, never read",
};

/** Does a workspace_write path escape the workspace jail? Mirrors the
 *  runtime jail's own rule (resolve inside root; `..`/absolute escapes
 *  refused) so classification and execution agree. */
export function pathEscapesWorkspace(path: string): boolean {
  const parts = path.replace(/^\/+/, "").split("/");
  let depth = 0;
  for (const part of parts) {
    if (part === "..") {
      depth--;
      if (depth < 0) return true;
    } else if (part !== "." && part !== "") {
      depth++;
    }
  }
  return false;
}

/** The bulk size of a call: explicit `count`, else the length of a
 *  `paths` list, else 1. */
export function bulkCount(args: Record<string, unknown>): number {
  if (typeof args.count === "number" && Number.isFinite(args.count)) return args.count;
  if (Array.isArray(args.paths)) return args.paths.length;
  return 1;
}

export function usesSecret(args: Record<string, unknown>): boolean {
  return typeof args.secretName === "string" && args.secretName.length > 0;
}

function ruleMatches(rule: PolicyRule, call: ToolCallShape): boolean {
  if (rule.tool !== call.tool) return false;
  if (rule.usesSecret !== undefined && rule.usesSecret !== usesSecret(call.args)) return false;
  if (rule.minCount !== undefined && bulkCount(call.args) < rule.minCount) return false;
  if (rule.outsideWorkspace !== undefined) {
    const outside =
      call.tool === "workspace_write" &&
      typeof call.args.path === "string" &&
      pathEscapesWorkspace(call.args.path);
    if (rule.outsideWorkspace !== outside) return false;
  }
  return true;
}

/** Parse the file's shield section defensively (a hand-edited file
 *  must never weaken the defaults by accident). */
function parseShield(raw: unknown): ShieldPolicyView {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SHIELD_POLICY };
  const s = raw as Partial<ShieldPolicyView>;
  return {
    required: s.required === true,
    onUnavailable: s.onUnavailable === "open" ? "open" : "closed",
  };
}

/** Parse standing approvals defensively: a malformed entry is dropped,
 *  never interpreted loosely — a typo must fail toward prompting. */
function parseStandingApprovals(raw: unknown): StandingApproval[] {
  if (!Array.isArray(raw)) return [];
  const out: StandingApproval[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Partial<StandingApproval>;
    if (typeof e.actionClass !== "string" || !e.actionClass) continue;
    const scopeType =
      e.scopeType === "person" || e.scopeType === "domain" || e.scopeType === "group"
        ? e.scopeType
        : undefined;
    if (scopeType && (typeof e.scopeValue !== "string" || !e.scopeValue)) continue;
    out.push({
      actionClass: e.actionClass,
      scopeType,
      scopeValue: typeof e.scopeValue === "string" ? e.scopeValue : undefined,
      reason: typeof e.reason === "string" ? e.reason : undefined,
    });
  }
  return out;
}

function parseGroups(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [name, members] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(members)) out[name] = members.map(String);
  }
  return out;
}

/** Parse the Phase 7 mac section defensively: non-string entries are
 *  dropped, and a missing section is the strict empty default — a
 *  typo in the operator's file must fail toward prompting, never
 *  toward a wider jail or a longer allowlist. */
function parseMac(raw: unknown): MacPolicyData {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { workDirs: [], shellAllowlist: [] };
  }
  const m = raw as Partial<MacPolicyData>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  return { workDirs: strings(m.workDirs), shellAllowlist: strings(m.shellAllowlist) };
}

export class PolicyStore {
  constructor(
    private policyPath: string,
    private opts: { gmailDirectoryPath?: string } = {},
  ) {}

  /** Current policy. Missing/malformed file = strict defaults (the
   *  built-in classifier triggers hold regardless of file contents). */
  load(): PolicyData {
    try {
      if (existsSync(this.policyPath)) {
        const raw = JSON.parse(readFileSync(this.policyPath, "utf8")) as Partial<PolicyData>;
        return {
          version: typeof raw.version === "number" ? raw.version : DEFAULT_POLICY.version,
          bulkThreshold:
            typeof raw.bulkThreshold === "number" ? raw.bulkThreshold : DEFAULT_POLICY.bulkThreshold,
          approvalTimeoutMs:
            typeof raw.approvalTimeoutMs === "number"
              ? raw.approvalTimeoutMs
              : DEFAULT_POLICY.approvalTimeoutMs,
          rules: Array.isArray(raw.rules) ? (raw.rules as PolicyRule[]) : [],
          shield: parseShield(raw.shield),
          standingApprovals: parseStandingApprovals(raw.standingApprovals),
          groups: parseGroups(raw.groups),
          mac: parseMac(raw.mac),
        };
      }
    } catch {
      /* malformed operator policy: strict defaults, built-ins still hold */
    }
    return DEFAULT_POLICY;
  }

  /** The Shield gate's resolved policy (Phase 4). */
  shieldPolicy(): ShieldPolicyView {
    return this.load().shield;
  }

  /** Phase 6: the Gmail directory's known-correspondent set, read
   *  from the pack's state file on every classification (the service
   *  updates it as mail flows, and the classifier must see that
   *  immediately — exactly like the policy file itself). No file
   *  configured or readable = nobody is known = every send prompts. */
  private knownRecipients(): Set<string> {
    const out = new Set<string>();
    if (!this.opts.gmailDirectoryPath) return out;
    try {
      if (existsSync(this.opts.gmailDirectoryPath)) {
        const raw = JSON.parse(readFileSync(this.opts.gmailDirectoryPath, "utf8")) as {
          known?: unknown;
        };
        if (Array.isArray(raw.known)) {
          for (const a of raw.known) out.add(normalizeAddress(String(a)));
        }
      }
    } catch {
      /* unreadable directory: fail toward prompting */
    }
    return out;
  }

  /** Does a standing approval cover this action class for ALL of
   *  these recipients? (Empty recipient list — e.g. gmail-modify —
   *  matches only unscoped records: a person/domain/group scope is
   *  about recipients and says nothing about mailbox operations.) */
  private standingMatch(
    policy: PolicyData,
    actionClass: string,
    recipients: string[],
  ): StandingApproval | undefined {
    for (const s of policy.standingApprovals) {
      if (s.actionClass !== actionClass) continue;
      if (!s.scopeType) return s;
      if (recipients.length === 0) continue;
      const scope = (s.scopeValue ?? "").toLowerCase();
      const covered = (addr: string): boolean => {
        if (s.scopeType === "person") return addr === normalizeAddress(scope);
        if (s.scopeType === "domain") return addr.split("@")[1] === scope.replace(/^@/, "");
        // group: members are addresses or domains ("@x.com"/"x.com")
        const members = (policy.groups[s.scopeValue ?? ""] ?? []).map((m) => m.toLowerCase());
        return members.some(
          (m) => addr === normalizeAddress(m) || addr.split("@")[1] === m.replace(/^@/, ""),
        );
      };
      if (recipients.every(covered)) return s;
    }
    return undefined;
  }

  /**
   * Phase 6 classification for gmail_* tools. The hard lines are
   * checked BEFORE any standing approval is consulted, in code, so no
   * policy file can soften them (see StandingApproval):
   *   deletes → always Once; bulk → always Once; first-time external
   *   recipients → always Once. Standing approvals cover the natural
   *   classes that remain: replies in an existing thread to known
   *   recipients, sends to known recipients, single-message modifies.
   */
  private classifyGmail(call: ToolCallShape, policy: PolicyData): Classification {
    const { tool, declaredClass, args } = call;
    const actionClass = gmailActionClass(tool);
    const park = (reason: string, effectiveClass: ToolClass = declaredClass): Classification => ({
      action: "needs-approval",
      effectiveClass,
      reason,
    });

    switch (tool) {
      case "gmail_search":
      case "gmail_read":
      case "gmail_summarize":
        return {
          action: "allow",
          effectiveClass: "read",
          reason: "gmail read: inbound content is Shield-scanned in the control plane before it can reach the model",
        };
      case "gmail_draft":
        return {
          action: "allow",
          effectiveClass: "write",
          reason: "gmail draft only — nothing is sent; the outbound secret-guard still runs at execution",
        };
      case "gmail_block_sender":
        return {
          action: "allow",
          effectiveClass: "write",
          reason: "gmail spam control: blocking one sender (a filter change, recorded in the pack directory)",
        };
      case "gmail_label":
      case "gmail_archive":
      case "gmail_spam": {
        const ids = gmailMessageIds(args);
        if (ids.length === 0) {
          return park("gmail action names no message IDs — mail actions must enumerate the exact messages they touch");
        }
        if (ids.length > 1) {
          return park(
            `bulk mail action over ${ids.length} messages [${ids.join(", ")}] — bulk actions always need a one-time approval enumerating the exact message IDs, and standing approvals never cover bulk (the Yue rule)`,
            "destructive",
          );
        }
        const standing = this.standingMatch(policy, actionClass, []);
        if (standing) {
          return {
            action: "allow",
            effectiveClass: declaredClass,
            reason: `standing approval (always) covers ${actionClass}${standing.reason ? `: ${standing.reason}` : ""}`,
          };
        }
        return {
          action: "allow",
          effectiveClass: "write",
          reason: "single-message mail change (write class)",
        };
      }
      case "gmail_delete": {
        const ids = gmailMessageIds(args);
        if (ids.length === 0) {
          return park("gmail_delete names no message IDs — a delete approval must enumerate the exact messages", "destructive");
        }
        return park(
          `delete of ${ids.length} message(s) [${ids.join(", ")}] — deletes always need a one-time approval; standing approvals never cover deletes (the Yue rule)`,
          "destructive",
        );
      }
      case "gmail_send":
      case "gmail_reply": {
        const recipients = gmailRecipients(args);
        if (tool === "gmail_send" && recipients.length === 0) {
          return park("gmail_send names no recipients — a send approval must name exactly who receives it", "external-send");
        }
        if (recipients.length > 0) {
          // Hard line: first-time external recipients always prompt.
          const known = this.knownRecipients();
          const firstTime = recipients.filter((r) => !known.has(r));
          if (firstTime.length > 0) {
            return park(
              `first-time external recipient(s): ${firstTime.join(", ")} — the first send to a new correspondent always needs a one-time approval; standing approvals do not apply`,
              "external-send",
            );
          }
          const standing = this.standingMatch(policy, actionClass, recipients);
          if (standing) {
            return {
              action: "allow",
              effectiveClass: declaredClass,
              reason: `standing approval (always) covers ${actionClass} to ${recipients.join(", ")}${standing.reason ? `: ${standing.reason}` : ""}`,
            };
          }
        } else {
          // A reply that names no recipients goes to the thread's
          // original sender, whom the service resolves at execution.
          // Only an UNSCOPED gmail-reply standing approval can cover
          // it — a scoped one cannot be checked against a recipient
          // the call does not name, so scoped replies must name `to`.
          const standing = policy.standingApprovals.find(
            (s) => s.actionClass === actionClass && !s.scopeType,
          );
          if (standing) {
            return {
              action: "allow",
              effectiveClass: declaredClass,
              reason: "standing approval (always) covers replies in existing threads (recipients resolved from the thread at execution)",
            };
          }
        }
        return park(
          `${tool === "gmail_reply" ? "reply" : "send"} to ${recipients.length ? recipients.join(", ") : "the thread's sender"} — external sends need a one-time approval unless a standing approval covers them`,
          "external-send",
        );
      }
      default:
        return park(`unrecognized gmail tool "${tool}" — parked by default`, declaredClass);
    }
  }

  /**
   * Phase 7 classification for mac_* tools — the Mac pack's
   * permission model, mirroring the scope's Nova policy defaults:
   *
   *   Always (proceed): mac.observe; mac.open_app / mac.focus_window;
   *   mac.fs.read / mac.fs.write whose path resolves inside the
   *   operator's approved work dirs; mac.shell.run commands that are
   *   allowlisted end-to-end AND run in a work dir.
   *   Once (park): all input injection (click / type / key / scroll /
   *   picker) — driving another app's UI is approved per exact
   *   action until the receipt history earns more; fs paths outside
   *   the jail (the jail still applies at execution); shell that is
   *   non-allowlisted, chained past the allowlist, destructive,
   *   deleting, installing, publishing, or credential-adjacent
   *   (classifyShellCommand, mac.ts — deletes park under the Yue
   *   rule and are never allowlist-coverable).
   *
   * The declared-class floor is applied first, here, because this
   * branch replaces the generic step-3 triggers for mac tools: a
   * call the runtime declares destructive / external-send / pay
   * parks whatever the tool is. Never (deny rules) already won in
   * classify() before this branch is reached.
   */
  private classifyMac(call: ToolCallShape, policy: PolicyData): Classification {
    const { tool, declaredClass, args } = call;
    const park = (reason: string, effectiveClass: ToolClass = declaredClass): Classification => ({
      action: "needs-approval",
      effectiveClass,
      reason,
    });

    if (declaredClass === "destructive" || declaredClass === "external-send" || declaredClass === "pay") {
      return park(
        `${declaredClass} actions always need operator approval (policy v${policy.version}) — the declared class is a floor the Mac pack cannot classify below`,
      );
    }

    switch (tool) {
      case "mac.observe":
        return {
          action: "allow",
          effectiveClass: "read",
          reason: "mac observation (read class): the desktop view is Shield-scanned in the control plane before it can reach the model",
        };
      case "mac.open_app":
      case "mac.focus_window":
        return {
          action: "allow",
          effectiveClass: "write",
          reason: `${tool === "mac.open_app" ? "opening an app" : "focusing a window"} on the resident Mac (the Nova policy's always set); the service verifies the front app afterwards`,
        };
      case "mac.fs.read":
      case "mac.fs.write": {
        const raw = typeof args.path === "string" ? args.path : "";
        if (!raw) {
          return park(`${tool} names no path — a file approval must name the exact file it touches`);
        }
        const resolved = macResolveJailed(raw, policy.mac.workDirs);
        if (resolved !== null) {
          return {
            action: "allow",
            effectiveClass: tool === "mac.fs.read" ? "read" : "write",
            reason: `${tool} inside an approved work directory (${resolved}) — the pack jail holds at execution`,
          };
        }
        if (policy.mac.workDirs.length === 0) {
          return park(
            `${tool} path "${raw}" cannot be jailed: the policy names no approved Mac work directories — file access parks until the operator sets mac.workDirs`,
            "destructive",
          );
        }
        return park(
          `${tool} path "${raw}" is outside the approved Mac work directories — approval required (the pack jail still applies at execution)`,
          "destructive",
        );
      }
      case "mac.shell.run": {
        const command = typeof args.command === "string" ? args.command : "";
        if (!command.trim()) {
          return park("mac.shell.run names no command — a shell approval must name exactly what runs", "destructive");
        }
        const workDirs = policy.mac.workDirs;
        const cwdRaw = typeof args.cwd === "string" && args.cwd ? args.cwd : (workDirs[0] ?? "");
        const cwdOk =
          cwdRaw !== "" &&
          macJailContains(cwdRaw.startsWith("/") ? cwdRaw : `${workDirs[0] ?? ""}/${cwdRaw}`, workDirs);
        if (!cwdOk) {
          return park(
            `mac.shell.run working directory "${cwdRaw || "(none)"}" is outside the approved Mac work directories — shell runs only inside the jail`,
            "destructive",
          );
        }
        const verdict = classifyShellCommand(command, policy.mac.shellAllowlist);
        if (verdict.action === "allow") {
          return { action: "allow", effectiveClass: "write", reason: verdict.reason };
        }
        return park(verdict.reason, verdict.severity);
      }
      case "mac.click":
      case "mac.type":
      case "mac.key":
      case "mac.scroll":
      case "mac.picker.select":
        return park(
          `${tool} injects input into the live desktop — input injection always needs a one-time approval bound to the exact target/text (Phase 7: driving other apps' UIs is Once until the receipt history earns more)`,
          "write",
        );
      default:
        return park(`unrecognized mac tool "${tool}" — parked by default`, declaredClass);
    }
  }

  /**
   * Operator-surface write of the Shield section (onboarding records
   * the provisioning + the operator's fail-mode choice here). Merges
   * into the existing file so hand-authored rules survive; creates the
   * file from defaults when absent. This is an operator action — the
   * sandbox has no path to it, like every policy write.
   */
  writeShield(shield: ShieldPolicyView): void {
    let raw: Record<string, unknown> = {};
    try {
      if (existsSync(this.policyPath)) {
        raw = JSON.parse(readFileSync(this.policyPath, "utf8")) as Record<string, unknown>;
      }
    } catch {
      raw = {};
    }
    raw.shield = { required: shield.required, onUnavailable: shield.onUnavailable };
    if (typeof raw.version !== "number") raw.version = DEFAULT_POLICY.version;
    if (typeof raw.bulkThreshold !== "number") raw.bulkThreshold = DEFAULT_POLICY.bulkThreshold;
    if (typeof raw.approvalTimeoutMs !== "number") raw.approvalTimeoutMs = DEFAULT_POLICY.approvalTimeoutMs;
    if (!Array.isArray(raw.rules)) raw.rules = [];
    writeFileSync(this.policyPath, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    chmodSync(this.policyPath, 0o600);
  }

  classify(call: ToolCallShape, policy: PolicyData = this.load()): Classification {
    const { tool, declaredClass, args } = call;

    // 1. Hard deny — in code, no file can override it.
    if (tool in HARD_DENY) {
      return { action: "deny", effectiveClass: declaredClass, reason: HARD_DENY[tool] };
    }

    // 2. Policy deny rules.
    for (const rule of policy.rules) {
      if (rule.action === "deny" && ruleMatches(rule, call)) {
        return {
          action: "deny",
          effectiveClass: declaredClass,
          reason: rule.reason ?? `policy v${policy.version} denies ${tool}`,
        };
      }
    }

    // 2b. Phase 6: the Gmail pack's permission model (Once / Always /
    // Never + the Yue hard lines). Never already won above; the pack's
    // own classifier decides the rest for gmail_* tools.
    if (isGmailTool(tool)) {
      return this.classifyGmail(call, policy);
    }

    // 2c. Phase 7: the Mac pack's permission model (the Nova Always
    // set vs Once-parks, with the declared-class floor applied inside
    // classifyMac). Never already won above.
    if (isMacTool(tool)) {
      return this.classifyMac(call, policy);
    }

    // 3. Built-in approval triggers.
    if (declaredClass === "destructive" || declaredClass === "external-send" || declaredClass === "pay") {
      return {
        action: "needs-approval",
        effectiveClass: declaredClass,
        reason: `${declaredClass} actions always need operator approval (policy v${policy.version})`,
      };
    }
    if (tool === "fetch" && usesSecret(args)) {
      return {
        action: "needs-approval",
        effectiveClass: declaredClass,
        reason: `credential use: this fetch injects the vault secret "${String(args.secretName)}" — approval required`,
      };
    }
    if (tool === "workspace_write" && typeof args.path === "string" && pathEscapesWorkspace(args.path)) {
      return {
        action: "needs-approval",
        effectiveClass: "destructive",
        reason: `write path "${args.path}" escapes the workspace — approval required (the jail still applies)`,
      };
    }
    if (bulkCount(args) >= policy.bulkThreshold && (tool.includes("delete") || tool.includes("move") || tool.includes("bulk"))) {
      return {
        action: "needs-approval",
        effectiveClass: "destructive",
        reason: `bulk operation (${bulkCount(args)} items ≥ threshold ${policy.bulkThreshold})`,
      };
    }

    // 4. Policy rules for the rest.
    for (const rule of policy.rules) {
      if (ruleMatches(rule, call)) {
        return {
          action: rule.action,
          effectiveClass: declaredClass,
          reason: rule.reason ?? `policy v${policy.version} rule for ${tool}`,
        };
      }
    }

    // 5. Defaults: read/write proceed; unknown classes park (fail closed).
    if (declaredClass === "read" || declaredClass === "write") {
      return { action: "allow", effectiveClass: declaredClass, reason: `${declaredClass} action, no approval required` };
    }
    return {
      action: "needs-approval",
      effectiveClass: declaredClass,
      reason: `unrecognized class "${declaredClass}" — parked by default`,
    };
  }
}
