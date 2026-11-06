/**
 * Stub inference provider — PHASE 0 ONLY.
 *
 * A deterministic, offline "model" so the full pipeline (Governor metering,
 * tool authorization, verification, receipts) can be built and drilled
 * before any real provider is wired. It resolves through the same Governor
 * interface real providers will use in Phase 4 (gateway classes:
 * primary = Anthropic/OpenAI via gateway, cheap = local via Open WebUI).
 *
 * Behavior contract (documented so drills are stable):
 * - "write file <path> <content...>"  -> workspace_write tool call
 * - "read file <path>"                -> workspace_read tool call
 * - "delete <n> files"                -> bulk_delete tool call (destructive)
 * - "delete files <p1> <p2> ..."      -> bulk_delete with concrete paths
 *   (Phase 2: the approval drill vehicle — approve/deny/replay all need
 *   exact, checkable arguments)
 * - "loop spend"                      -> loop_charge tool call, repeated
 *   forever on every TOOL_RESULT (Phase 2 runaway drill vehicle: an
 *   agent loop that will issue paid model calls until something OUTSIDE
 *   the model stops it — that something is the Governor)
 * - "slow job"                        -> slow_work tool call (kill drill)
 * - "fetch <url>"                     -> fetch tool call (egress proxy)
 * - "fetch auth <url> with <name>"    -> fetch with a vault secret NAME
 * - "fetch post <url> :: <body>"      -> fetch POST through the proxy
 * - "vault get <name>"                -> vault_read tool call (Phase 1
 *   red-team vehicle: the control plane refuses — no such API exists)
 * - "TOOL_RESULT ..."                 -> final summary text, EXCEPT when
 *   the result text carries a FOLLOWUP_FETCH / FOLLOWUP_FETCH_POST
 *   marker: then the corresponding fetch tool call is issued. This is
 *   the stub's instruction-following simulation — a naive agent obeying
 *   directives embedded in fetched content (Phase 1 drill, attack (f)).
 *   The Phase 1 point is that even a fully obedient agent cannot leak
 *   what the proxy never let it hold.
 * - anything else                     -> echo-style text reply
 */
import type { ToolClass } from "@gus/shared";

export interface ProviderReply {
  text?: string;
  toolCall?: { tool: string; declaredClass: ToolClass; args: Record<string, unknown> };
}

export const FAKE_MODEL_NAME = "fake/stub-v0 (Phase 0 offline provider)";

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function fakeComplete(prompt: string): ProviderReply {
  const p = prompt.trim();

  if (p.startsWith("TOOL_RESULT")) {
    if (p.startsWith("TOOL_RESULT loop_charge:")) {
      // The runaway loop: never satisfied, never stops on its own. Only
      // the Governor's cap (or the kill switch) ends this job — which is
      // exactly the Phase 2 drill's point.
      return {
        toolCall: { tool: "loop_charge", declaredClass: "read", args: {} },
      };
    }
    const post = p.match(/FOLLOWUP_FETCH_POST\s+(\S+)\s+::\s*([\s\S]+)/);
    if (post) {
      return {
        toolCall: {
          tool: "fetch",
          declaredClass: "write",
          args: { url: post[1], method: "POST", body: post[2].trim() },
        },
      };
    }
    const get = p.match(/FOLLOWUP_FETCH\s+(\S+)/);
    if (get) {
      return { toolCall: { tool: "fetch", declaredClass: "read", args: { url: get[1] } } };
    }
    // First line only: Phase 9 continuations append the operator's
    // original request after the TOOL_RESULT line — the stub's "Done"
    // echoes the tool's outcome, not the framing around it.
    return { text: `Done — ${p.slice("TOOL_RESULT".length).trim().split("\n")[0]}` };
  }
  let m = p.match(/^write file\s+(\S+)\s+([\s\S]+)$/i);
  if (m) {
    return {
      toolCall: {
        tool: "workspace_write",
        declaredClass: "write",
        args: { path: m[1], content: m[2] },
      },
    };
  }
  m = p.match(/^read file\s+(\S+)$/i);
  if (m) {
    return { toolCall: { tool: "workspace_read", declaredClass: "read", args: { path: m[1] } } };
  }
  m = p.match(/^delete\s+(\d+)\s+files?$/i);
  if (m) {
    return {
      toolCall: {
        tool: "bulk_delete",
        declaredClass: "destructive",
        args: { count: Number(m[1]) },
      },
    };
  }
  m = p.match(/^delete\s+files?\s+(\S+(?:\s+\S+)*)$/i);
  if (m) {
    return {
      toolCall: {
        tool: "bulk_delete",
        declaredClass: "destructive",
        args: { paths: m[1].split(/\s+/) },
      },
    };
  }
  if (/^loop spend$/i.test(p)) {
    return { toolCall: { tool: "loop_charge", declaredClass: "read", args: {} } };
  }
  if (/^slow job$/i.test(p)) {
    return { toolCall: { tool: "slow_work", declaredClass: "read", args: { steps: 60 } } };
  }
  m = p.match(/^fetch\s+auth\s+(\S+)\s+with\s+([a-z0-9_-]+)$/i);
  if (m) {
    return {
      toolCall: {
        tool: "fetch",
        declaredClass: "read",
        args: { url: m[1], secretName: m[2].toLowerCase() },
      },
    };
  }
  m = p.match(/^fetch\s+post\s+(\S+)\s+::\s*([\s\S]+)$/i);
  if (m) {
    return {
      toolCall: {
        tool: "fetch",
        declaredClass: "write",
        args: { url: m[1], method: "POST", body: m[2] },
      },
    };
  }
  m = p.match(/^fetch\s+(\S+)$/i);
  if (m) {
    return { toolCall: { tool: "fetch", declaredClass: "read", args: { url: m[1] } } };
  }
  m = p.match(/^(?:vault\s+get|ask\s+vault\s+for)\s+([a-z0-9_-]+)$/i);
  if (m) {
    return {
      toolCall: {
        tool: "vault_read",
        declaredClass: "read",
        args: { name: m[1].toLowerCase() },
      },
    };
  }
  return { text: `GUS here (offline stub provider). You said: "${p.slice(0, 200)}"` };
}
