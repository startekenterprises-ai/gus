/**
 * Delegate principals (Phase 9) — who may say what in a conversation.
 *
 * Until now every conversation the channel adapter surfaced was the
 * operator's by construction: one private chat, one human. The Nova
 * bridge breaks that assumption — GUS joins a group conversation
 * where a second agent (a delegate) may REQUEST work while the
 * operator keeps every privileged control. This module is the
 * identity half of that line; ChannelHost enforces it:
 *
 *   operator  — full control: jobs, approvals, /stop, /resume,
 *               /update. There is exactly one per conversation.
 *   delegate  — may submit job requests. Its jobs run under the same
 *               classifier, Shield gate, and spend caps as the
 *               operator's; anything that parks still parks for the
 *               OPERATOR. A delegate can never resolve an approval,
 *               stop, resume, or update — not even its own jobs'.
 *   stranger  — any other sender in a gated conversation. Ignored
 *               (and logged); the bot does not answer.
 *   legacy    — a conversation with no entry in delegates.json:
 *               today's behavior, unchanged (a private chat where the
 *               only possible sender is the operator).
 *
 * The config is the operator's file — `delegates.json` in the state
 * dir, written by the operator (or by setup tooling acting for the
 * operator), re-read per event so edits land without a restart:
 *
 *   { "conversations": {
 *       "-1001234567890": {
 *         "operatorId": "7572793265",
 *         "delegates": [{ "senderId": "123456789", "name": "Nova" }]
 *       } } }
 *
 * A missing or malformed file means NO gated conversations (every
 * conversation is legacy) — the pre-bridge world. Sender ids are
 * channel-native (Telegram user ids, as strings).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface DelegatePrincipal {
  senderId: string;
  name: string;
}

export interface ConversationPrincipals {
  operatorId: string;
  delegates: DelegatePrincipal[];
}

export interface DelegatesConfig {
  conversations: Record<string, ConversationPrincipals>;
  /** The file-bridge binding (bridge-inbox.ts): which conversation
   *  bridge-submitted requests belong to, and which delegate sender
   *  they arrive as. Optional; absent = the bridge is inert. */
  bridge?: { conversationId: string; senderId: string };
}

export type PrincipalRole =
  | { role: "operator" }
  | { role: "delegate"; name: string }
  | { role: "stranger" }
  | { role: "legacy" };

export function loadDelegates(stateDir: string): DelegatesConfig {
  try {
    const raw = JSON.parse(
      readFileSync(join(stateDir, "delegates.json"), "utf8"),
    ) as Partial<DelegatesConfig> | null;
    if (
      raw &&
      typeof raw === "object" &&
      raw.conversations &&
      typeof raw.conversations === "object"
    ) {
      const cfg: DelegatesConfig = { conversations: raw.conversations };
      const b = (raw as { bridge?: unknown }).bridge;
      if (
        b &&
        typeof b === "object" &&
        typeof (b as { conversationId?: unknown }).conversationId === "string" &&
        typeof (b as { senderId?: unknown }).senderId === "string"
      ) {
        cfg.bridge = b as { conversationId: string; senderId: string };
      }
      return cfg;
    }
  } catch {
    /* absent or malformed → no gated conversations */
  }
  return { conversations: {} };
}

export function roleFor(
  cfg: DelegatesConfig,
  conversationId: string,
  senderId: string,
): PrincipalRole {
  const conv = cfg.conversations[conversationId];
  if (!conv || typeof conv.operatorId !== "string" || conv.operatorId === "") {
    return { role: "legacy" };
  }
  if (senderId === conv.operatorId) return { role: "operator" };
  const d = (Array.isArray(conv.delegates) ? conv.delegates : []).find(
    (x) => x && x.senderId === senderId,
  );
  if (d) return { role: "delegate", name: typeof d.name === "string" && d.name ? d.name : "delegate" };
  return { role: "stranger" };
}
