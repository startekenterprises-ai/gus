/**
 * Chat-history sync (v0.26.0) — the merge core for the ONE
 * conversation that lives on every device (design: 2026-11-20,
 * gus-ios-ux-feedback Addendum 17).
 *
 * The design, settled before a line was built:
 *  - Messages are APPEND-ONLY and immutable. Each is born with
 *    a globally unique ID (UUID), the creating device's ID, and
 *    a per-device sequence number. Nothing is ever edited in
 *    place, so there is almost nothing to conflict.
 *  - Merge = UNION, never overwrite. Devices exchange only the
 *    IDs the other lacks; a message seen twice is recognized by
 *    ID and skipped — sync is idempotent and duplicates are
 *    structurally impossible.
 *  - Ordering does NOT trust wall-clock timestamps (device
 *    clocks drift): each message carries a causal pointer —
 *    `prevId`, the last message its creator had seen. `ts` is
 *    display-only. Simultaneous offline chats on two devices
 *    interleave by causal order; both are preserved.
 *
 * This module is the pure core: identity validation, the
 * canonical causal order, the union merge, and the
 * have/want arithmetic of one sync exchange. It is shared by
 * the core (control-plane's panel-chat store) and mirrored
 * function-for-function in Swift (apps/ios/App/ChatHistoryStore
 * .swift) for the phone's store — the rules are identical, so
 * both sides converge to the same set in the same order from
 * the same inputs.
 *
 * Conflicts: the same ID with different content cannot arise
 * from honest use (IDs are minted once, records never change).
 * If it ever appears — corruption, tampering — the merge NEVER
 * silently drops a copy: the winner is chosen deterministically
 * (field-by-field comparison, no serialization involved, so
 * every implementation picks the same winner), and the loser
 * is reported in `conflicts` so the caller can archive and log
 * it. The winner rule compares (deviceId, seq, ts, direction,
 * text, prevId) in that order.
 */

export interface SyncedChatMessage {
  /** Globally unique message ID (UUID), minted at birth. */
  id: string;
  /** The device that created the message. */
  deviceId: string;
  /** Per-device sequence number on the creating device. */
  seq: number;
  /** Causal pointer: the last message the creator had seen
   *  (the conversation head at creation), or null for the
   *  first message a device ever created into an empty view. */
  prevId: string | null;
  /** Creation time, milliseconds — DISPLAY ONLY. Ordering
   *  never reads this. */
  ts: number;
  /** "in" = the operator's words; "out" = what GUS delivered. */
  direction: "in" | "out";
  text: string;
  /** Photos sent with the message — the count only; image
   *  data is never part of a synced record. */
  photos?: number;
}

export interface ChatSyncConflict {
  id: string;
  /** The copy that won the deterministic comparison. */
  kept: SyncedChatMessage;
  /** The copy that lost — preserved by the caller, never
   *  silently dropped. */
  dropped: SyncedChatMessage;
}

const MAX_TEXT_CHARS = 8_000;

/** Strict shape check for a synced record arriving from
 *  another device (or read back from a store file). Anything
 *  malformed is refused — a bad record never enters a store. */
export function validateSyncedChatMessage(raw: unknown): SyncedChatMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0 || r.id.length > 128) return undefined;
  if (typeof r.deviceId !== "string" || r.deviceId.length === 0 || r.deviceId.length > 128) return undefined;
  if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 0) return undefined;
  // prevId may be absent (Swift's Codable omits nil optionals)
  // — absent means null, the genesis pointer.
  if (r.prevId !== undefined && r.prevId !== null && typeof r.prevId !== "string") return undefined;
  if (typeof r.prevId === "string" && (r.prevId.length === 0 || r.prevId.length > 128)) return undefined;
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts) || r.ts < 0) return undefined;
  if (r.direction !== "in" && r.direction !== "out") return undefined;
  if (typeof r.text !== "string" || r.text.length > MAX_TEXT_CHARS) return undefined;
  const msg: SyncedChatMessage = {
    id: r.id,
    deviceId: r.deviceId,
    seq: r.seq,
    prevId: (r.prevId ?? null) as string | null,
    ts: r.ts,
    direction: r.direction,
    text: r.text,
  };
  if (r.photos !== undefined) {
    if (typeof r.photos !== "number" || !Number.isInteger(r.photos) || r.photos < 0 || r.photos > 64) {
      return undefined;
    }
    if (r.photos > 0) msg.photos = r.photos;
  }
  return msg;
}

/** Field-by-field identity: two copies of a message are the
 *  same record iff every field matches. */
export function sameChatMessage(a: SyncedChatMessage, b: SyncedChatMessage): boolean {
  return (
    a.id === b.id &&
    a.deviceId === b.deviceId &&
    a.seq === b.seq &&
    a.prevId === b.prevId &&
    a.ts === b.ts &&
    a.direction === b.direction &&
    a.text === b.text &&
    (a.photos ?? 0) === (b.photos ?? 0)
  );
}

/** The conflict comparison: negative when `a` wins over `b`.
 *  Pure value comparison — no serialization, no hashing — so
 *  every implementation of these rules picks the same winner
 *  from the same pair. */
export function compareChatMessageCopies(a: SyncedChatMessage, b: SyncedChatMessage): number {
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.direction !== b.direction) return a.direction < b.direction ? -1 : 1;
  if (a.text !== b.text) return a.text < b.text ? -1 : 1;
  const ap = a.prevId ?? "";
  const bp = b.prevId ?? "";
  if (ap !== bp) return ap < bp ? -1 : 1;
  return (a.photos ?? 0) - (b.photos ?? 0);
}

/** The deterministic sibling order: messages that share a
 *  predecessor (concurrent branches — two devices writing
 *  offline from the same head) interleave by (deviceId, seq,
 *  id), identically on every device, with no clock involved. */
function compareSiblings(a: SyncedChatMessage, b: SyncedChatMessage): number {
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * The canonical causal order over a set of messages: a
 * topological order following prevId links (a message always
 * sorts after the message it saw), with concurrent siblings
 * ordered by compareSiblings. A prevId pointing outside the
 * set (a partial view) makes the message a root. A cycle —
 * impossible from honest prev assignment — is broken
 * deterministically rather than looping or dropping: the
 * remaining messages append in sibling order. The output
 * depends only on the set, never on input order, so two
 * devices holding the same set render the same history.
 */
export function orderChatMessages(messages: readonly SyncedChatMessage[]): SyncedChatMessage[] {
  const byId = new Map<string, SyncedChatMessage>();
  for (const m of messages) byId.set(m.id, m);
  const children = new Map<string, SyncedChatMessage[]>();
  const roots: SyncedChatMessage[] = [];
  for (const m of byId.values()) {
    if (m.prevId !== null && byId.has(m.prevId) && m.prevId !== m.id) {
      const list = children.get(m.prevId);
      if (list) list.push(m);
      else children.set(m.prevId, [m]);
    } else {
      roots.push(m);
    }
  }
  roots.sort(compareSiblings);
  for (const list of children.values()) list.sort(compareSiblings);

  // Kahn's walk with a sibling-sorted frontier: always emit
  // the smallest available message whose predecessor is out.
  const out: SyncedChatMessage[] = [];
  const emitted = new Set<string>();
  const frontier: SyncedChatMessage[] = [...roots];
  const insertFrontier = (m: SyncedChatMessage): void => {
    let i = frontier.length;
    while (i > 0 && compareSiblings(frontier[i - 1], m) > 0) i--;
    frontier.splice(i, 0, m);
  };
  while (frontier.length > 0) {
    const next = frontier.shift()!;
    if (emitted.has(next.id)) continue;
    emitted.add(next.id);
    out.push(next);
    for (const child of children.get(next.id) ?? []) insertFrontier(child);
  }
  if (out.length < byId.size) {
    // A cycle among the leftovers (corrupt prev links): emit
    // them in sibling order — deterministic, nothing dropped.
    const rest = [...byId.values()].filter((m) => !emitted.has(m.id)).sort(compareSiblings);
    out.push(...rest);
  }
  return out;
}

/**
 * Union merge: the union of both sets by ID, in canonical
 * causal order. Divergent copies of one ID resolve by
 * compareChatMessageCopies and are reported as conflicts —
 * the caller archives the loser; it is never silently
 * dropped here either (it travels back in `conflicts`).
 */
export function mergeChatMessages(
  local: readonly SyncedChatMessage[],
  remote: readonly SyncedChatMessage[],
): { messages: SyncedChatMessage[]; conflicts: ChatSyncConflict[] } {
  const byId = new Map<string, SyncedChatMessage>();
  const conflicts: ChatSyncConflict[] = [];
  const fold = (m: SyncedChatMessage): void => {
    const held = byId.get(m.id);
    if (!held) {
      byId.set(m.id, m);
      return;
    }
    if (sameChatMessage(held, m)) return;
    const winner = compareChatMessageCopies(held, m) <= 0 ? held : m;
    const loser = winner === held ? m : held;
    byId.set(m.id, winner);
    conflicts.push({ id: m.id, kept: winner, dropped: loser });
  };
  for (const m of local) fold(m);
  for (const m of remote) fold(m);
  return { messages: orderChatMessages([...byId.values()]), conflicts };
}

/** What `mine` holds that a peer listing `theirIds` lacks —
 *  the messages one sync push should carry. */
export function chatMessagesMissingFrom(
  mine: readonly SyncedChatMessage[],
  theirIds: ReadonlySet<string>,
): SyncedChatMessage[] {
  return mine.filter((m) => !theirIds.has(m.id));
}

/** Which of the peer's IDs `mine` lacks — the want list of a
 *  sync exchange. */
export function chatIdsLacking(
  mine: readonly SyncedChatMessage[],
  theirIds: readonly string[],
): string[] {
  const held = new Set(mine.map((m) => m.id));
  return theirIds.filter((id) => !held.has(id));
}
