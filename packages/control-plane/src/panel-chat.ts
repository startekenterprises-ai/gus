/**
 * The panel Chat adapter (v0.6) — the operator panel as a channel.
 *
 * The Chat view needed a way to speak to GUS that is NOT a bypass:
 * every other surface reaches the agent by emitting a ChannelEvent
 * into the ChannelHost, where secret screening, the sender gate,
 * the Shield ingress scan, the classifier, the Governor caps and
 * the receipt chain all apply. So the panel is wired as exactly
 * that — one more ChannelAdapter, named "panel", with a single
 * conversation ("panel-chat"). Submitting the composer emits the
 * same event a Telegram message would have produced; the sender is
 * the panel itself, which only the operator token can reach, and an
 * ungated conversation reads as the operator under delegates.ts —
 * the same trust the panel's other buttons already carry.
 *
 * What makes it a chat and not just a job form is the return path:
 * everything the host sends to this conversation — results, park
 * notices, block notices, cap notices — is appended to
 * <stateDir>/chat.jsonl by send(). That file is the durable
 * transcript: the panel's history endpoint reads it back, so a
 * reload (or a control-plane restart) loses nothing. Inbound
 * submissions are recorded by submit() itself (the host does not
 * echo the operator's own words back), so the file holds both
 * directions in order.
 *
 * The record holds TEXT ONLY, exactly as egress-screened by the
 * host before send() is called. Buttons are not recorded: the
 * panel renders live approval cards from the Approval Engine's
 * own durable state, never from transcript text.
 *
 * v0.24.0: photos. A submission may carry images (the iOS chat's
 * photo attach). The images ride the emitted event to the model
 * as image input, but they are NEVER recorded: the transcript
 * entry carries only the photo COUNT (`photos`), so the durable
 * record shows a photo was sent without holding the photo.
 *
 * v0.26.0: chat-history sync. Every transcript entry is now a
 * synced record in the sense of @gus/shared's chat-sync: born
 * with a globally unique ID, its creating device's ID, a
 * per-device sequence number, and a causal pointer (`prevId` —
 * the last message its creator had seen; timestamps stay
 * display-only). The core's device ID is minted once into
 * <stateDir>/chat-sync.json. Entries written before sync
 * existed are migrated in place on first use: one atomic
 * rewrite gives them IDs in file order, chained by prevId,
 * under the core's device ID (the core was their custodian —
 * whichever surface created them, it recorded them), and the
 * append-only file discipline is preserved from there on.
 *
 * Two doors bring a phone-born message into this store, and
 * they are NOT interchangeable:
 *  - submit(..., identity) is the LIVE door: record (unless the
 *    ID is already held — an idempotent retry) AND emit the
 *    channel event, so the pipeline answers it.
 *  - syncExchange's ingest is the HISTORY door: records arrive
 *    verbatim and are NEVER emitted — they were already
 *    answered (or deliberately never dispatched) where they
 *    were born. Re-emitting one would double-answer it.
 * A divergent copy of a held ID (corruption/tampering — honest
 * sync cannot produce one) is never silently dropped: the
 * merge core picks the deterministic winner for the canonical
 * view, and the losing copy is archived whole to
 * <stateDir>/chat-sync-conflicts.jsonl.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  ChannelAdapter,
  ChannelEvent,
  MessageImage,
  OutboundMessage,
  SyncedChatMessage,
} from "@gus/shared";
import {
  chatIdsLacking,
  chatMessagesMissingFrom,
  mergeChatMessages,
  orderChatMessages,
  sameChatMessage,
  validateSyncedChatMessage,
} from "@gus/shared";
import { JsonlLogCache } from "./log-cache.js";

export const PANEL_CHAT_CONVERSATION = "panel-chat";
export const PANEL_CHAT_SENDER = "panel";

const MAX_TEXT_CHARS = 8_000;
const MAX_HISTORY = 200;
/** v0.24.0: photo caps for one submission — the iOS app sends a
 *  single downscaled JPEG (hundreds of KB); these are headroom,
 *  not targets. The ChannelHost re-validates before the runtime. */
export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BASE64_CHARS = 8_000_000;
/** v0.26.0: one sync push carries at most this many records —
 *  far beyond a normal catch-up; a peer with more sends another
 *  exchange. */
export const MAX_SYNC_MESSAGES = 500;

export interface PanelChatEntry {
  ts: number;
  direction: "in" | "out";
  text: string;
  /** v0.24.0: how many photos the operator sent with this entry
   *  (inbound only). The image data itself is never recorded. */
  photos?: number;
  /** v0.26.0: sync identity — present on every entry since the
   *  store's migration (and from birth on new entries). */
  id?: string;
  deviceId?: string;
  seq?: number;
  prevId?: string | null;
}

/** The sync identity a live submission may carry (minted by the
 *  creating device — the iOS chat). ts rides along so the record
 *  keeps the creation time the creating device saw. */
export interface ChatSubmitIdentity {
  id: string;
  deviceId: string;
  seq: number;
  prevId: string | null;
  ts: number;
}

export interface ChatSyncExchangeRequest {
  deviceId: string;
  haveIds: string[];
  messages?: unknown[];
}

export interface ChatSyncExchangeResult {
  deviceId: string;
  /** Store records the caller lacks (its haveIds didn't name
   *  them), in canonical causal order. */
  missing: SyncedChatMessage[];
  /** Of the caller's haveIds, the ones this store lacks — the
   *  caller sends those records in a follow-up exchange. */
  wantIds: string[];
  /** Divergent copies archived during this exchange. */
  conflicts: number;
}

/** v0.24.0: shape-check one submitted image. Returns the image
 *  when it is a plausible photo payload, undefined otherwise. */
export function sanitizeChatImage(raw: unknown): MessageImage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { mediaType?: unknown; data?: unknown };
  if (typeof r.mediaType !== "string" || !r.mediaType.startsWith("image/")) return undefined;
  if (typeof r.data !== "string" || r.data.length === 0) return undefined;
  if (r.data.length > MAX_CHAT_IMAGE_BASE64_CHARS) return undefined;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(r.data)) return undefined;
  return { mediaType: r.mediaType, data: r.data };
}

/** The history mapping, applied by the log cache once per line
 *  at append time (v0.14.0): the panel conversation's records
 *  only, shape-checked exactly as the old per-call parse checked
 *  them — anything else on the file is not transcript. v0.26.0:
 *  sync fields ride through when they validate as a set (the
 *  migration guarantees they do); an entry without them is a
 *  pre-migration record and reads as plain transcript. */
function mapChatLine(raw: unknown): PanelChatEntry | undefined {
  const r = raw as {
    conversationId?: string;
    ts?: number;
    direction?: string;
    text?: string;
    photos?: number;
    id?: unknown;
    deviceId?: unknown;
    seq?: unknown;
    prevId?: unknown;
  };
  if (!r || typeof r !== "object") return undefined;
  if (r.conversationId !== PANEL_CHAT_CONVERSATION) return undefined;
  if (typeof r.ts !== "number" || typeof r.text !== "string") return undefined;
  const entry: PanelChatEntry = {
    ts: r.ts,
    direction: r.direction === "in" ? "in" : "out",
    text: r.text,
    ...(typeof r.photos === "number" && r.photos > 0 ? { photos: r.photos } : {}),
  };
  const synced = validateSyncedChatMessage({
    id: r.id,
    deviceId: r.deviceId,
    seq: r.seq,
    prevId: r.prevId,
    ts: r.ts,
    direction: entry.direction,
    text: r.text,
    ...(entry.photos ? { photos: entry.photos } : {}),
  });
  if (synced) {
    entry.id = synced.id;
    entry.deviceId = synced.deviceId;
    entry.seq = synced.seq;
    entry.prevId = synced.prevId;
  }
  return entry;
}

/** A transcript entry as a synced record, or undefined when it
 *  carries no sync identity (pre-migration — the migration runs
 *  before any sync surface answers, so sync code never sees
 *  these). */
function entryToSynced(entry: PanelChatEntry): SyncedChatMessage | undefined {
  if (entry.id === undefined || entry.deviceId === undefined || entry.seq === undefined) {
    return undefined;
  }
  return {
    id: entry.id,
    deviceId: entry.deviceId,
    seq: entry.seq,
    prevId: entry.prevId ?? null,
    ts: entry.ts,
    direction: entry.direction,
    text: entry.text,
    ...(entry.photos ? { photos: entry.photos } : {}),
  };
}

export class PanelChatAdapter implements ChannelAdapter {
  readonly name = "panel";
  private onEvent?: (ev: ChannelEvent) => void;
  private counter = 0;
  /** v0.14.0 (R2): history reads through the incremental log
   *  cache — record()'s own appends are appendFileSync, whose
   *  size growth the cache's stat-delta picks up on the next
   *  history() call, so the transcript stays exactly as durable
   *  and exactly as current as the old full re-read. */
  private historyCache = new JsonlLogCache<PanelChatEntry>();

  // -- v0.26.0 sync state -------------------------------------
  private syncReady = false;
  private coreDeviceId = "";
  private nextSeq = 1;
  /** IDs that entered the store through the HISTORY door
   *  (sync ingest) and have never been emitted as channel
   *  events. Marked by a `via: "sync"` key on their file lines
   *  (not part of the synced record), rebuilt by scanning the
   *  file at readiness time. A live submission naming one of
   *  these IDs is that message's first dispatch — see submit(). */
  private syncIngestedIds = new Set<string>();
  /** The canonical (merged, causally ordered) sync view,
   *  memoized on the history cache's revision + entry count:
   *  either changing means the file grew or was replaced. */
  private canonicalCache: { revision: number; count: number; messages: SyncedChatMessage[] } | null =
    null;

  constructor(private stateDir: string) {}

  private logPath(): string {
    return `${this.stateDir}/chat.jsonl`;
  }

  private syncIdentityPath(): string {
    return `${this.stateDir}/chat-sync.json`;
  }

  private conflictsPath(): string {
    return `${this.stateDir}/chat-sync-conflicts.jsonl`;
  }

  async start(onEvent: (ev: ChannelEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  async stop(): Promise<void> {}

  // -- sync readiness + legacy migration -----------------------

  /** Mint-or-load the core's sync device ID, migrate legacy
   *  transcript entries (once), and derive the next core
   *  sequence number. Runs lazily on the first surface that
   *  needs sync state; afterwards it is a flag check. */
  private ensureSyncReady(): void {
    if (this.syncReady) return;
    this.syncReady = true;

    // The core's device identity: minted once, persisted, and
    // stable across restarts — it names the creating device on
    // every core-born record from here on.
    try {
      const raw = JSON.parse(readFileSync(this.syncIdentityPath(), "utf8")) as {
        deviceId?: unknown;
      };
      if (typeof raw.deviceId === "string" && raw.deviceId.length > 0) {
        this.coreDeviceId = raw.deviceId;
      }
    } catch {
      /* missing or unreadable — mint below */
    }
    if (!this.coreDeviceId) {
      this.coreDeviceId = randomUUID();
      writeFileSync(this.syncIdentityPath(), JSON.stringify({ deviceId: this.coreDeviceId }) + "\n");
    }

    this.migrateLegacyEntries();

    // Provenance scan: which held IDs arrived via sync ingest
    // (their file lines carry via: "sync") and so have never
    // been emitted as channel events.
    if (existsSync(this.logPath())) {
      for (const line of readFileSync(this.logPath(), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { via?: unknown; id?: unknown };
          if (parsed.via === "sync" && typeof parsed.id === "string") {
            this.syncIngestedIds.add(parsed.id);
          }
        } catch {
          /* torn line — not provenance */
        }
      }
    }

    // Next core sequence: one past the highest the core has
    // used (its own records, migrated ones included).
    let max = 0;
    for (const entry of this.allEntries()) {
      if (entry.deviceId === this.coreDeviceId && typeof entry.seq === "number") {
        if (entry.seq > max) max = entry.seq;
      }
    }
    this.nextSeq = max + 1;
  }

  /** Give every pre-sync transcript entry a sync identity, in
   *  file order: IDs minted fresh, prevId chained to the
   *  previous entry, sequence numbers under the core's device
   *  ID. One atomic rewrite (tmp + rename — the proposals
   *  store's pattern); non-transcript lines and torn tails are
   *  preserved byte-for-byte. Runs only when a legacy entry is
   *  actually found, so a migrated store never churns. */
  private migrateLegacyEntries(): void {
    const path = this.logPath();
    if (!existsSync(path)) return;
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    let prevId: string | null = null;
    let seq = 0;
    let changed = false;
    const out: string[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        out.push(line);
        continue;
      }
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }
      if (!parsed || parsed.conversationId !== PANEL_CHAT_CONVERSATION) {
        out.push(line);
        continue;
      }
      // An entry that already validates as a synced record
      // keeps its identity; the chain pointer just follows it.
      const existing = validateSyncedChatMessage({
        id: parsed.id,
        deviceId: parsed.deviceId,
        seq: parsed.seq,
        prevId: parsed.prevId,
        ts: parsed.ts,
        direction: parsed.direction === "in" ? "in" : "out",
        text: parsed.text,
        ...(typeof parsed.photos === "number" ? { photos: parsed.photos } : {}),
      });
      if (existing) {
        prevId = existing.id;
        if (existing.deviceId === this.coreDeviceId && existing.seq > seq) seq = existing.seq;
        out.push(line);
        continue;
      }
      if (typeof parsed.ts !== "number" || typeof parsed.text !== "string") {
        out.push(line); // not transcript shape — preserved, unmigrated
        continue;
      }
      seq += 1;
      const id = randomUUID();
      const migrated = {
        ...parsed,
        id,
        deviceId: this.coreDeviceId,
        seq,
        prevId,
      };
      prevId = id;
      changed = true;
      out.push(JSON.stringify(migrated));
    }
    if (!changed) return;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, out.join("\n"));
    renameSync(tmp, path);
    // The rename replaced the file under the log cache; its
    // inode tripwire would catch it, but drop the state
    // explicitly so the next read is a clean full parse.
    this.historyCache.clear(path);
    this.canonicalCache = null;
  }

  // -- the canonical sync view ---------------------------------

  private allEntries(): PanelChatEntry[] {
    return [...this.historyCache.read(this.logPath(), mapChatLine)];
  }

  /** Every synced record in the store, in canonical causal
   *  order (the merge core's order over the file's set — file
   *  order and causal order agree for single-device history,
   *  and diverge exactly where offline branches interleave). */
  private canonicalMessages(): SyncedChatMessage[] {
    const revision = this.historyCache.revision(this.logPath());
    const entries = this.allEntries();
    if (
      this.canonicalCache &&
      this.canonicalCache.revision === revision &&
      this.canonicalCache.count === entries.length
    ) {
      return this.canonicalCache.messages;
    }
    const records: SyncedChatMessage[] = [];
    for (const entry of entries) {
      const synced = entryToSynced(entry);
      if (synced) records.push(synced);
    }
    // The merge fold, not a plain sort: the file can hold two
    // copies of one ID exactly once in its life — when an
    // ingested copy WON a conflict against the filed copy, the
    // winner was appended too (both preserved; see
    // syncExchange). The fold dedupes identical copies and
    // resolves divergent ones by the same deterministic rule,
    // so the view is a pure function of the file's set.
    const messages = mergeChatMessages(records, []).messages;
    this.canonicalCache = { revision, count: entries.length, messages };
    return messages;
  }

  private headId(): string | null {
    const messages = this.canonicalMessages();
    return messages.length > 0 ? messages[messages.length - 1].id : null;
  }

  private findMessage(id: string): SyncedChatMessage | undefined {
    return this.canonicalMessages().find((m) => m.id === id);
  }

  /** Mint a core-born identity for a new record. */
  private mintCoreIdentity(ts: number): SyncedChatMessage {
    return {
      id: randomUUID(),
      deviceId: this.coreDeviceId,
      seq: this.nextSeq++,
      prevId: this.headId(),
      ts,
      direction: "in",
      text: "",
    };
  }

  // -- the two doors --------------------------------------------

  /**
   * The composer's send button, via the panel backend. Records the
   * operator's words, then emits the ordinary message event — from
   * here on the pipeline cannot tell (and does not care) that the
   * words came from the panel rather than Telegram.
   *
   * v0.24.0: `images` carries the submission's photos. Each is
   * shape-checked and capped here (and again in the ChannelHost);
   * a submission naming photos that are not usable image payloads
   * is refused outright — a photo is never silently dropped. A
   * photo-only submission (no words) is a real message: the event
   * text is empty and the ChannelHost frames it for the model.
   * The transcript records the photo count, never the data.
   *
   * v0.26.0: `identity` carries the sync identity the creating
   * device minted (the iOS chat). The record is stored under
   * THAT identity — the phone is the creating device; the core
   * is its custodian. A submission whose ID the store already
   * holds is an idempotent retry (the first attempt's response
   * was lost): it records nothing and emits nothing, because
   * the original is already recorded and in flight.
   */
  submit(
    text: string,
    images?: MessageImage[],
    identity?: ChatSubmitIdentity,
  ): { ok: boolean; detail: string } {
    const trimmed = text.trim();
    let photos: MessageImage[] | undefined;
    if (images !== undefined) {
      if (!Array.isArray(images) || images.length > MAX_CHAT_IMAGES) {
        return { ok: false, detail: `Too many photos — at most ${MAX_CHAT_IMAGES} per message. Nothing was sent.` };
      }
      photos = [];
      for (const raw of images) {
        const img = sanitizeChatImage(raw);
        if (!img) {
          return { ok: false, detail: "One of the attached photos isn't a usable image — nothing was sent." };
        }
        photos.push(img);
      }
      if (photos.length === 0) photos = undefined;
    }
    if (!trimmed && !photos) return { ok: false, detail: "The message is empty — nothing was sent." };
    if (trimmed.length > MAX_TEXT_CHARS) {
      return { ok: false, detail: `That message is over the ${MAX_TEXT_CHARS}-character limit for one job — nothing was sent.` };
    }
    if (!this.onEvent) {
      return { ok: false, detail: "The chat channel is not running yet — nothing was sent." };
    }
    this.ensureSyncReady();

    // The record's sync identity: the creating device's, when
    // one rides along and validates against this submission;
    // otherwise the core mints its own (the Mac panel's own
    // composer is a core-born surface).
    let record: SyncedChatMessage;
    if (identity) {
      const validated = validateSyncedChatMessage({
        id: identity.id,
        deviceId: identity.deviceId,
        seq: identity.seq,
        prevId: identity.prevId,
        ts: identity.ts,
        direction: "in",
        text: trimmed,
        ...(photos ? { photos: photos.length } : {}),
      });
      if (!validated) {
        return { ok: false, detail: "The message's sync identity isn't usable — nothing was sent." };
      }
      if (this.findMessage(validated.id)) {
        // Already recorded — normally an idempotent retry (the
        // first send's response was lost): the original is
        // recorded and in flight, so nothing emits twice. ONE
        // exception: a record that arrived through the history
        // door was never dispatched at all. If nothing has
        // answered it, this live submission is its first
        // dispatch — the phone held it for the operator's
        // Shield OK, it synced as history meanwhile, and the
        // OK came after. Emit now, without re-recording.
        if (this.syncIngestedIds.has(validated.id) && !this.hasOutDescendant(validated.id)) {
          this.syncIngestedIds.delete(validated.id);
          this.emitSubmit(validated, photos);
          return {
            ok: true,
            detail: "Sent — it goes through the same scan, caps and receipts as any channel message.",
          };
        }
        return {
          ok: true,
          detail: "Already recorded — the first send is the one in flight; nothing was sent twice.",
        };
      }
      record = validated;
    } else {
      const minted = this.mintCoreIdentity(Date.now());
      record = {
        ...minted,
        direction: "in",
        text: trimmed,
        ...(photos ? { photos: photos.length } : {}),
      };
    }
    this.record({
      ts: record.ts,
      direction: "in",
      text: trimmed,
      ...(photos ? { photos: photos.length } : {}),
      id: record.id,
      deviceId: record.deviceId,
      seq: record.seq,
      prevId: record.prevId,
    });
    this.emitSubmit(record, photos);
    return { ok: true, detail: "Sent — it goes through the same scan, caps and receipts as any channel message." };
  }

  /** Emit a recorded submission as the ordinary channel event.
   *  The caller has already established the channel is running
   *  (submit's onEvent check) and the record is in the store. */
  private emitSubmit(record: SyncedChatMessage, photos?: MessageImage[]): void {
    this.onEvent?.({
      type: "message",
      message: {
        conversationId: PANEL_CHAT_CONVERSATION,
        messageId: record.id,
        senderId: PANEL_CHAT_SENDER,
        text: record.text,
        receivedAt: record.ts,
        ...(photos ? { images: photos } : {}),
      },
    });
  }

  /** Whether any "out" record causally descends from the given
   *  message (its prevId chain reaches it) — i.e. it has been
   *  answered. Used by submit's history-door exception: an
   *  answered message is never re-dispatched. */
  private hasOutDescendant(id: string): boolean {
    const children = new Map<string, SyncedChatMessage[]>();
    for (const m of this.canonicalMessages()) {
      if (m.prevId) {
        const list = children.get(m.prevId);
        if (list) list.push(m);
        else children.set(m.prevId, [m]);
      }
    }
    const seen = new Set<string>([id]);
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const child of children.get(current) ?? []) {
        if (seen.has(child.id)) continue;
        if (child.direction === "out") return true;
        seen.add(child.id);
        queue.push(child.id);
      }
    }
    return false;
  }

  /** Outbound: the host has already egress-screened this text.
   *  Persist it as the transcript's "out" side. v0.26.0: the
   *  record is core-born — it causally follows the store's
   *  current head, which includes the message being answered
   *  (that was recorded before the pipeline ran). */
  async send(msg: OutboundMessage): Promise<void> {
    if (msg.conversationId !== PANEL_CHAT_CONVERSATION) return;
    this.ensureSyncReady();
    const minted = this.mintCoreIdentity(Date.now());
    this.record({
      ts: minted.ts,
      direction: "out",
      text: msg.text,
      id: minted.id,
      deviceId: minted.deviceId,
      seq: minted.seq,
      prevId: minted.prevId,
    });
  }

  async ackButton(): Promise<void> {
    /* Buttons never originate from the panel adapter — the panel
     * resolves approvals through the panel backend's POST route. */
  }

  private record(entry: PanelChatEntry): void {
    appendFileSync(this.logPath(), JSON.stringify({ conversationId: PANEL_CHAT_CONVERSATION, ...entry }) + "\n");
    this.canonicalCache = null;
  }

  /** The durable transcript, oldest first, capped. A torn final
   *  line (a crash mid-append) is skipped, never fatal — the
   *  cache holds it unparsed until its newline lands. slice()
   *  copies, so the cache's array is never handed out mutably. */
  history(limit = MAX_HISTORY): PanelChatEntry[] {
    this.ensureSyncReady();
    return this.historyCache.read(this.logPath(), mapChatLine).slice(-limit);
  }

  // -- sync exchange ---------------------------------------------

  /** This store's sync device ID (the core's). */
  syncDeviceId(): string {
    this.ensureSyncReady();
    return this.coreDeviceId;
  }

  /** The store's full canonical sync view — every record, in
   *  causal order. */
  syncMessages(): SyncedChatMessage[] {
    this.ensureSyncReady();
    return this.canonicalMessages();
  }

  /**
   * One sync exchange with a peer device:
   *  1. INGEST the records the peer pushes (the history door —
   *     recorded verbatim, never emitted). Unknown IDs append;
   *     identical copies skip; divergent copies resolve by the
   *     merge core's deterministic winner for the canonical
   *     view and the loser is archived whole to the conflicts
   *     file — never silently dropped.
   *  2. ANSWER from the post-ingest store: the records the
   *     peer lacks (missing) and the peer's IDs this store
   *     lacks (wantIds), which the peer sends in a follow-up
   *     exchange.
   */
  syncExchange(req: ChatSyncExchangeRequest): ChatSyncExchangeResult {
    this.ensureSyncReady();
    let conflicts = 0;

    const pushed: SyncedChatMessage[] = [];
    if (Array.isArray(req.messages)) {
      for (const raw of req.messages.slice(0, MAX_SYNC_MESSAGES)) {
        const validated = validateSyncedChatMessage(raw);
        if (validated) pushed.push(validated);
      }
    }
    if (pushed.length > 0) {
      const held = new Map(this.canonicalMessages().map((m) => [m.id, m]));
      const fresh: SyncedChatMessage[] = [];
      for (const incoming of orderChatMessages(pushed)) {
        const existing = held.get(incoming.id);
        if (!existing) {
          fresh.push(incoming);
          held.set(incoming.id, incoming);
          continue;
        }
        if (sameChatMessage(existing, incoming)) continue;
        // Divergent copies of one ID: the merge core picks the
        // winner for the canonical view; the loser is archived
        // whole, with the winner named — nothing is dropped.
        // When the incoming copy wins, it is ALSO appended to
        // the transcript file (the filed loser stays — the file
        // is append-only; the canonical fold above the file
        // resolves the pair deterministically).
        const { conflicts: found } = mergeChatMessages([existing], [incoming]);
        for (const conflict of found) {
          conflicts++;
          appendFileSync(
            this.conflictsPath(),
            JSON.stringify({
              ts: Date.now(),
              id: conflict.id,
              kept: conflict.kept,
              dropped: conflict.dropped,
              peerDeviceId: req.deviceId,
            }) + "\n",
          );
          held.set(conflict.id, conflict.kept);
          if (conflict.kept === incoming) fresh.push(incoming);
        }
      }
      // Fresh records append to the file verbatim (the file is
      // the raw record; the canonical view above it applies
      // the merge rules, winner included). Their lines carry
      // via: "sync" — provenance, not part of the record — so
      // a later live submission can tell "recorded, in flight"
      // from "recorded as history, never dispatched".
      for (const m of fresh) {
        appendFileSync(
          this.logPath(),
          JSON.stringify({
            conversationId: PANEL_CHAT_CONVERSATION,
            ts: m.ts,
            direction: m.direction,
            text: m.text,
            ...(m.photos ? { photos: m.photos } : {}),
            id: m.id,
            deviceId: m.deviceId,
            seq: m.seq,
            prevId: m.prevId,
            via: "sync",
          }) + "\n",
        );
        this.syncIngestedIds.add(m.id);
      }
      if (fresh.length > 0) this.canonicalCache = null;
    }

    const store = this.canonicalMessages();
    const have = new Set(
      (Array.isArray(req.haveIds) ? req.haveIds : []).filter(
        (id): id is string => typeof id === "string",
      ),
    );
    return {
      deviceId: this.coreDeviceId,
      missing: chatMessagesMissingFrom(store, have),
      wantIds: chatIdsLacking(store, [...have]),
      conflicts,
    };
  }
}
