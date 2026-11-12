/**
 * The Shield gate (foundation spec §1.7) — Phase 4 enforcement.
 *
 * Three choke points, all in the control plane, none optional once the
 * gate is provisioned:
 *   1. inbound messages — scanned before a job is ever pushed to the
 *      runtime;
 *   2. tool-call arguments — scanned before policy classification and
 *      authorization (scan-before-act);
 *   3. tool results (fetched pages, file contents, MCP responses) —
 *      scanned before the result can enter the model's context.
 *
 * This class makes the DECISION and keeps the record; the callers
 * (ChannelHost, CommServer) apply it — settle the job, relay or
 * withhold the result. Every decision lands in <state>/gate.jsonl with
 * the full Shield receipt (content-free by design) and a hash of what
 * was scanned — never the content itself.
 *
 * Unprovisioned vs unavailable — the distinction that keeps the gate
 * honest:
 *   - NOT PROVISIONED (no key in the vault) and not required by policy:
 *     the gate steps aside (allow, recorded as skipped). This is the
 *     pre-onboarding state; Phases 0–3 behavior is byte-identical.
 *   - REQUIRED by policy (set at onboarding when the key is
 *     provisioned) but the key is missing or the API is unreachable:
 *     the OPERATOR's recorded fail policy decides — "closed" (default,
 *     and the default for tool calls specifically) blocks the surface;
 *     "open" lets it proceed, flagged, with NO receipt (the record says
 *     exactly that; nothing pretends a scan happened).
 */
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  gateActionFor,
  type ShieldClient,
  type ShieldReceipt,
} from "./shield.js";

export type GateSurface = "inbound-message" | "tool-call" | "tool-result";

export interface ShieldPolicyView {
  /** True once onboarding has provisioned the gate: absence of the key
   *  or of the API is then a failure to decide on, not a skip. */
  required: boolean;
  /** What to do when no scan can be performed. Default "closed". */
  onUnavailable: "closed" | "open";
}

export const DEFAULT_SHIELD_POLICY: ShieldPolicyView = {
  required: false,
  onUnavailable: "closed",
};

/** The Governor's enforcement mode (v0.4, SELinux-style). Enforcing:
 *  verdicts bind. Permissive: verdicts are recorded and receipted
 *  but do not bind — the action proceeds, stamped with what
 *  enforcing mode would have done. Scanning itself never turns
 *  off in either mode; neither do the spend caps or the kill
 *  switch, which are Governor mechanics, not content policy. */
export type GateMode = "enforcing" | "permissive";

export interface GateDecision {
  action: "allow" | "flag" | "block";
  /** True when a real scan produced this decision. */
  scanned: boolean;
  verdict?: string;
  receipt: ShieldReceipt | null;
  /** Plain-language explanation, safe for the operator and the job
   *  record (screened by callers before persisting, like all notes). */
  detail: string;
  /** True when this decision was relaxed by permissive mode. */
  permissive?: boolean;
  /** What enforcing mode would have done ("block"). */
  wouldBe?: string;
}

export interface GateLogEntry {
  ts: number;
  jobId: string;
  surface: GateSurface;
  action: "allow" | "flag" | "block";
  scanned: boolean;
  verdict?: string;
  receiptId?: string;
  verifyUrl?: string;
  /** The full Shield receipt, content-free, kept for re-verification. */
  receipt?: Record<string, unknown> | null;
  /** sha256 of the scanned content — correlation, never content. */
  contentSha256: string;
  detail: string;
  /** v0.4: the Governor mode in force for this decision, and — when
   *  permissive mode relaxed it — what enforcing would have done. */
  mode?: GateMode;
  wouldBe?: string;
  /** v0.9.10: the scan ran in fast mode (deterministic patterns
   *  only, semantic stage skipped) at the caller's request. */
  fast?: boolean;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const CONTENT_TYPE_FOR: Record<GateSurface, "prompt" | "text" | "webpage"> = {
  "inbound-message": "prompt",
  "tool-call": "text",
  "tool-result": "webpage",
};

export class ShieldGate {
  constructor(
    private opts: {
      client: ShieldClient;
      policy: () => ShieldPolicyView;
      logPath: string;
      /** v0.4: the Governor mode, re-read per scan so a mode flip is
       *  live on the next decision. Absent = enforcing, always. */
      mode?: () => GateMode;
    },
  ) {}

  private mode(): GateMode {
    return this.opts.mode?.() ?? "enforcing";
  }

  get client(): ShieldClient {
    return this.opts.client;
  }

  /** Provisioned = a key is in the vault right now. */
  provisioned(): boolean {
    return this.opts.client.hasKey();
  }

  /** Provision via zero-form signup (the client stores the key). */
  async provision(): Promise<{ ok: boolean; already?: boolean; detail: string }> {
    return this.opts.client.provision("gus");
  }

  async scanSurface(
    surface: GateSurface,
    jobId: string,
    content: string,
    opts?: { fastScan?: boolean },
  ): Promise<GateDecision> {
    const policy = this.opts.policy();
    const contentSha256 = sha256Hex(content);
    // v0.9.10: fast mode is a property of the REQUEST (the caller
    // asked for deterministic-only); it rides to the client call
    // and into the log entry above, whatever the decision.
    const fastMode = opts?.fastScan === true;
    const decide = (d: GateDecision, receiptRaw?: Record<string, unknown> | null): GateDecision => {
      const entry: GateLogEntry = {
        ts: Date.now(),
        jobId,
        surface,
        action: d.action,
        scanned: d.scanned,
        verdict: d.verdict,
        receiptId: d.receipt?.receiptId,
        verifyUrl: d.receipt?.verifyUrl,
        receipt: receiptRaw ?? null,
        contentSha256,
        detail: d.detail,
        mode: this.mode(),
        ...(d.wouldBe ? { wouldBe: d.wouldBe } : {}),
        // v0.9.10: a fast-mode scan (deterministic only, the
        // semantic stage skipped at the caller's request) is
        // named in the record — present only when it ran fast.
        ...(fastMode ? { fast: true } : {}),
      };
      try {
        appendFileSync(this.opts.logPath, JSON.stringify(entry) + "\n");
      } catch {
        /* the gate log is control-plane local; a logging failure must
           never turn a block into an allow — the decision stands. */
      }
      return d;
    };

    if (!this.opts.client.hasKey()) {
      if (!policy.required) {
        return decide({
          action: "allow",
          scanned: false,
          receipt: null,
          detail: "Shield gate not provisioned yet — scan skipped (onboarding provisions it)",
        });
      }
      return this.unavailable(
        decide,
        policy,
        surface,
        "the Shield gate is required by policy but no API key is in the vault",
      );
    }

    const outcome = await this.opts.client.scan(content, CONTENT_TYPE_FOR[surface], jobId, opts);
    if (outcome.status === "no-key") {
      // Raced with a key removal between hasKey and scan.
      if (!policy.required) {
        return decide({
          action: "allow",
          scanned: false,
          receipt: null,
          detail: "Shield gate not provisioned yet — scan skipped (onboarding provisions it)",
        });
      }
      return this.unavailable(decide, policy, surface, "the Shield API key vanished from the vault");
    }
    if (outcome.status === "unavailable") {
      return this.unavailable(decide, policy, surface, outcome.detail);
    }

    const action = gateActionFor(outcome);
    const receiptNote = outcome.receipt
      ? ` (Shield receipt ${outcome.receipt.receiptId})`
      : " (the Shield returned no receipt)";
    if (action === "block") {
      if (this.mode() === "permissive") {
        // SELinux-permissive semantics: the scan ran, the verdict is
        // real and receipted — it just does not bind. The decision
        // and the gate log both carry the would-be outcome, so the
        // permissive report can show exactly what enforcing mode
        // would have stopped.
        return decide(
          {
            action: "allow",
            scanned: true,
            verdict: outcome.verdict,
            receipt: outcome.receipt,
            permissive: true,
            wouldBe: "block",
            detail:
              `Agent-Shield verdict "${outcome.verdict}" — would be BLOCKED in enforcing mode; ` +
              `proceeding under PERMISSIVE mode${receiptNote}`,
          },
          outcome.receiptRaw,
        );
      }
      return decide(
        {
          action,
          scanned: true,
          verdict: outcome.verdict,
          receipt: outcome.receipt,
          detail: `Agent-Shield verdict "${outcome.verdict}" — blocked${receiptNote}`,
        },
        outcome.receiptRaw,
      );
    }
    if (action === "flag") {
      return decide(
        {
          action,
          scanned: true,
          verdict: outcome.verdict,
          receipt: outcome.receipt,
          detail: `Agent-Shield verdict "${outcome.verdict}" — flagged, proceeding${receiptNote}`,
        },
        outcome.receiptRaw,
      );
    }
    return decide(
      {
        action,
        scanned: true,
        verdict: outcome.verdict,
        receipt: outcome.receipt,
        detail: `Agent-Shield verdict "${outcome.verdict}" — no known-bad patterns detected${receiptNote}`,
      },
      outcome.receiptRaw,
    );
  }

  private unavailable(
    decide: (d: GateDecision, receiptRaw?: Record<string, unknown> | null) => GateDecision,
    policy: ShieldPolicyView,
    surface: GateSurface,
    why: string,
  ): GateDecision {
    if (policy.onUnavailable === "open") {
      return decide({
        action: "flag",
        scanned: false,
        receipt: null,
        detail: `Agent-Shield unavailable (${why}) — proceeding under the operator's fail-open policy; NO scan happened and no receipt exists`,
      });
    }
    return decide({
      action: "block",
      scanned: false,
      receipt: null,
      detail: `Agent-Shield unavailable (${why}) — blocked under the operator's fail-closed policy for ${surface}; no scan happened`,
    });
  }
}
