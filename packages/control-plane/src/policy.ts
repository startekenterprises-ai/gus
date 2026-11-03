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
 *   2. Policy rules with action "deny".
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

export interface PolicyData {
  version: number;
  /** Bulk threshold: count/path-list at or above this needs approval. */
  bulkThreshold: number;
  /** Approval lifetime; an unanswered approval is a denial. */
  approvalTimeoutMs: number;
  rules: PolicyRule[];
  /** Phase 4: the Shield gate's operator policy (spec §1.7). */
  shield: ShieldPolicyView;
}

export const DEFAULT_POLICY: PolicyData = {
  version: 1,
  bulkThreshold: 5,
  approvalTimeoutMs: 10 * 60 * 1000,
  rules: [],
  shield: { ...DEFAULT_SHIELD_POLICY },
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

export class PolicyStore {
  constructor(private policyPath: string) {}

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
