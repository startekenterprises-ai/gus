/**
 * Approval delegation policy (v0.5) — who may resolve a park when
 * the operator is not the one answering.
 *
 * Until v0.5 the line was absolute: approvals resolve ONLY by the
 * operator (channel button / command / panel), and a delegate could
 * never resolve anything — not even its own jobs'. Glenn's design
 * (decided 2026-11-06) makes approval authority delegable under a
 * narrow, receipted carve-out:
 *
 *   - Delegation exists ONLY while the Governor is in Permissive
 *     mode. In Enforcing, nothing changes: operator-only, exactly
 *     as before. Flipping back to Enforcing takes every delegation
 *     back at once (the mode is re-read at every decision point).
 *   - The operator enables each path separately, in
 *     <stateDir>/approver-policy.json (re-read per decision, same
 *     pattern as governor-mode.json). All defaults are OFF:
 *       gusApprovesDelegates — GUS may resolve parks on jobs a
 *         delegate submitted (origin "[from <name>] ").
 *       gusApprovesOwn — GUS may resolve parks on its own jobs
 *         (operator/system origin). The ONLY self-approval path,
 *         and only here.
 *       delegatesMayApprove — a named delegate may resolve parks on
 *         jobs it did NOT submit. The Phase 9 invariant survives
 *         inside the carve-out: a requester never approves its own
 *         request.
 *   - Scope: "bounded" covers the reversible-by-construction parks
 *     (Mac input injection, filesystem writes outside the approved
 *     work dirs, non-allowlisted shell). "all_except_floors" covers
 *     every parked class except the FLOORS.
 *   - The FLOORS are never agent-approvable under any setting:
 *     vault_read (hard-denied upstream regardless), deletes,
 *     installs, sends/posts/publishes (the external-send class),
 *     git push, sudo/dd/kill-class shell, keychain access — and
 *     anything the Governor refuses at a spend cap, because the
 *     decision call itself is metered and a cap refusal fails the
 *     decision closed.
 *   - GUS's decision is made HERE, in the control plane (never in
 *     the sandboxed runtime): the configured provider model is
 *     asked with a strict prompt and must answer one JSON object.
 *     Unparseable, timeout, provider error, or a Governor refusal
 *     all resolve to DENY — fail-closed, always.
 *   - Every agent resolution writes the same durable approvals
 *     record an operator resolution writes, plus resolvedBy ("gus"
 *     or "delegate:<name>"), the policy snapshot, and the reason.
 *     Hash-bound, single-use, consumed before execution — unchanged.
 *   - Rate limit: maxApprovalsPerHour across ALL agent approvers.
 *     A park that would be delegable but arrives after the budget
 *     is spent parks for the OPERATOR instead of proceeding.
 *
 * A missing or malformed policy file means delegation is OFF — the
 * pre-v0.5 world.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GovernorMode } from "./governor-mode.js";
import type { Classification, PolicyData, ToolCallShape } from "./policy.js";
import { isMacTool, shellWorstRisk } from "./mac.js";

export type ApproverScope = "bounded" | "all_except_floors";

/** The scope class a parked action falls into for delegation. */
export type ParkScopeClass = "floor" | "bounded" | "other";

export interface ApproverPolicy {
  gusApprovesDelegates: boolean;
  gusApprovesOwn: boolean;
  delegatesMayApprove: boolean;
  scope: ApproverScope;
  maxApprovalsPerHour: number;
}

export const DEFAULT_APPROVER_POLICY: ApproverPolicy = {
  gusApprovesDelegates: false,
  gusApprovesOwn: false,
  delegatesMayApprove: false,
  scope: "bounded",
  maxApprovalsPerHour: 30,
};

const POLICY_FILE = "approver-policy.json";

/** Parse defensively: only a literal `true` enables a path, an
 *  unknown scope is "bounded", and the rate limit clamps to a sane
 *  integer. A typo in the operator's file must fail toward OFF. */
export function parseApproverPolicy(raw: unknown): ApproverPolicy {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_APPROVER_POLICY };
  const r = raw as Partial<ApproverPolicy>;
  const max =
    typeof r.maxApprovalsPerHour === "number" && Number.isFinite(r.maxApprovalsPerHour)
      ? Math.min(1000, Math.max(0, Math.floor(r.maxApprovalsPerHour)))
      : DEFAULT_APPROVER_POLICY.maxApprovalsPerHour;
  return {
    gusApprovesDelegates: r.gusApprovesDelegates === true,
    gusApprovesOwn: r.gusApprovesOwn === true,
    delegatesMayApprove: r.delegatesMayApprove === true,
    scope: r.scope === "all_except_floors" ? "all_except_floors" : "bounded",
    maxApprovalsPerHour: max,
  };
}

export function loadApproverPolicy(stateDir: string): ApproverPolicy {
  try {
    return parseApproverPolicy(JSON.parse(readFileSync(join(stateDir, POLICY_FILE), "utf8")));
  } catch {
    return { ...DEFAULT_APPROVER_POLICY };
  }
}

export function writeApproverPolicy(stateDir: string, policy: ApproverPolicy, setBy: string): void {
  writeFileSync(
    join(stateDir, POLICY_FILE),
    JSON.stringify({ ...parseApproverPolicy(policy), setBy, ts: Date.now() }, null, 2) + "\n",
  );
}

/** The submitting delegate of a job, from its recorded origin
 *  (jobs.ts stamps "[from <name>] " submissions with the name;
 *  everything else is "operator"). Undefined = GUS's own / the
 *  operator's job — no delegate requested it. */
export function originDelegateOf(job: { origin?: string } | undefined): string | undefined {
  return job?.origin && job.origin !== "operator" ? job.origin : undefined;
}

/**
 * Which delegation scope class a parked action falls into.
 *
 * Derived from the tool + arguments and the classifier's effective
 * class — never from the model's declared intent (the classifier
 * already re-derived the class; this only buckets its outcome).
 */
export function parkScopeClass(
  call: ToolCallShape,
  cls: Classification,
  policyData: PolicyData,
): ParkScopeClass {
  const { tool, args } = call;

  // --- the floors, first: never agent-approvable under any setting.
  if (tool === "vault_read") return "floor"; // hard-denied upstream; defensive
  // Sends / posts / publishes park as the external-send class
  // (gmail_send, gmail_reply, and every generic send tool).
  if (cls.effectiveClass === "external-send") return "floor";
  // Deletes: the gmail pack's delete, the bulk delete tool, and any
  // tool whose name carries the delete verb.
  if (tool === "gmail_delete" || tool === "bulk_delete" || /(^|_)delete(_|$)/.test(tool)) {
    return "floor";
  }

  if (isMacTool(tool)) {
    switch (tool) {
      // Mac-control input injection — the bounded set, verbatim.
      case "mac.click":
      case "mac.type":
      case "mac.key":
      case "mac.scroll":
      case "mac.picker.select":
        return "bounded";
      // mac.fs.write parks only when the path escapes the approved
      // work directories — "filesystem writes outside workDirs".
      case "mac.fs.write":
        return "bounded";
      case "mac.fs.read":
        return "other";
      case "mac.shell.run": {
        const command = typeof args.command === "string" ? args.command : "";
        // Judged by the WORST segment, not the classifier's first
        // park: "ls && rm x" is a delete, not an unlisted command.
        switch (shellWorstRisk(command, policyData.mac.shellAllowlist)) {
          // The shell floors: deletes, installs, git push (publishes),
          // sudo/dd-class privilege, kill-class process control,
          // keychain access.
          case "delete":
          case "install":
          case "publish":
          case "privilege":
          case "process":
          case "keychain":
            return "floor";
          // Parked only because no allowlist entry covers it —
          // the bounded set's "non-allowlisted shell".
          case "unlisted":
            return "bounded";
          // Moves/copies, network shells/fetches, and commands the
          // classifier could not see into (redirection/substitution).
          default:
            return "other";
        }
      }
      default:
        return "other";
    }
  }

  // workspace_write parks only on a jail escape — the workspace
  // form of "filesystem writes outside workDirs".
  if (tool === "workspace_write") return "bounded";

  // Remaining gmail parks (bulk or unenumerated label/archive/spam —
  // sends and deletes are floors above) and every other park the
  // classifier produces: credential-use fetches, policy-rule parks,
  // pay-class and unrecognized-class parks.
  return "other";
}

export type ApprovalRoute =
  /** No delegation applies — the mode's normal behavior decides
   *  (park in Enforcing; stamped proceed in Permissive). */
  | { kind: "none"; reason: string }
  /** GUS decides synchronously, in the control plane. */
  | { kind: "gus"; scopeClass: ParkScopeClass }
  /** The park waits; a named delegate (not the submitter) or the
   *  operator may resolve it through the channel. */
  | { kind: "delegate"; scopeClass: ParkScopeClass }
  /** Delegable in principle, but the hourly agent-approval budget
   *  is spent — park for the operator rather than proceed. */
  | { kind: "park-operator"; reason: string };

export interface RouteParkInput {
  mode: GovernorMode;
  policy: ApproverPolicy;
  /** The delegate that submitted the job, if any (originDelegateOf). */
  originDelegate?: string;
  call: ToolCallShape;
  cls: Classification;
  policyData: PolicyData;
  /** Agent approvals already resolved in the trailing hour. */
  agentApprovalsLastHour: number;
}

/** Route a parked action: operator (the mode's default), GUS, a
 *  delegate, or — budget spent — back to the operator as a park. */
export function routePark(input: RouteParkInput): ApprovalRoute {
  if (input.mode !== "permissive") {
    return { kind: "none", reason: "enforcing mode — approvals are the operator's alone" };
  }
  const p = input.policy;
  if (!p.gusApprovesDelegates && !p.gusApprovesOwn && !p.delegatesMayApprove) {
    return { kind: "none", reason: "approval delegation is off" };
  }
  const scopeClass = parkScopeClass(input.call, input.cls, input.policyData);
  if (scopeClass === "floor") {
    return { kind: "none", reason: "floor class — never agent-approvable under any setting" };
  }
  if (p.scope === "bounded" && scopeClass !== "bounded") {
    return { kind: "none", reason: `park class "${scopeClass}" is outside the bounded delegation scope` };
  }
  // GUS (synchronous, in the control plane) is preferred when its
  // checkbox covers this origin; a delegate (asynchronous, through
  // the channel) is the fallback path.
  let route: "gus" | "delegate" | undefined;
  if (input.originDelegate !== undefined) {
    if (p.gusApprovesDelegates) route = "gus";
    else if (p.delegatesMayApprove) route = "delegate";
  } else {
    if (p.gusApprovesOwn) route = "gus";
    else if (p.delegatesMayApprove) route = "delegate";
  }
  if (!route) {
    return { kind: "none", reason: "no enabled delegation checkbox covers this job's origin" };
  }
  if (input.agentApprovalsLastHour >= p.maxApprovalsPerHour) {
    return {
      kind: "park-operator",
      reason:
        `agent-approval rate limit reached (${input.agentApprovalsLastHour}/${p.maxApprovalsPerHour} in the last hour) — ` +
        `this park goes to the operator instead`,
    };
  }
  return { kind: route, scopeClass };
}

/**
 * May THIS delegate resolve THIS park right now? Re-checked at
 * resolution time (not just at park time): the mode, the policy,
 * and the rate budget are all re-read, so flipping back to
 * Enforcing — or the budget running out — closes the path
 * mid-flight. The one invariant that can never be configured away:
 * the delegate that submitted the job cannot resolve its park.
 */
export function delegateResolutionAllowed(input: {
  mode: GovernorMode;
  policy: ApproverPolicy;
  delegation?: { scopeClass: ParkScopeClass; originDelegate?: string };
  resolverName: string;
  agentApprovalsLastHour: number;
}): { ok: true } | { ok: false; reason: string } {
  if (input.mode !== "permissive") {
    return { ok: false, reason: "the Governor is enforcing — approvals are the operator's alone" };
  }
  if (!input.policy.delegatesMayApprove) {
    return { ok: false, reason: "delegate approval is not enabled in the approver policy" };
  }
  if (!input.delegation) {
    return { ok: false, reason: "this park was not routed to agent approvers" };
  }
  if (input.delegation.originDelegate !== undefined && input.delegation.originDelegate === input.resolverName) {
    return { ok: false, reason: "a delegate never resolves a park on a job it submitted itself" };
  }
  if (input.agentApprovalsLastHour >= input.policy.maxApprovalsPerHour) {
    return {
      ok: false,
      reason: `the agent-approval rate limit is reached (${input.agentApprovalsLastHour}/${input.policy.maxApprovalsPerHour} in the last hour)`,
    };
  }
  return { ok: true };
}

/** Parse the decision model's reply. The prompt demands exactly one
 *  JSON object; anything else — prose, a malformed object, an
 *  unknown decision — is unparseable and the caller fails closed. */
export function parseApprovalDecision(
  text: string,
): { decision: "approve" | "deny"; reason: string } | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as { decision?: unknown; reason?: unknown };
    if (raw.decision !== "approve" && raw.decision !== "deny") return undefined;
    return {
      decision: raw.decision,
      reason: typeof raw.reason === "string" ? raw.reason.slice(0, 500) : "",
    };
  } catch {
    return undefined;
  }
}
