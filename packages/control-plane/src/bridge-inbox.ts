/**
 * The Bridge Inbox (Phase 10) — file-based delegate ingress.
 *
 * Why this exists (field discovery, 2026-11-05): Telegram does not
 * deliver bot messages to other bots, in any configuration. The
 * delegate bridge's group chat works for the operator and for each
 * bot individually, but Nova (a bot) can never reach GUS (a bot)
 * through it. The last hop therefore runs over the host filesystem,
 * which Nova reaches through the operator's paired-device channel:
 *
 *   Nova appends one JSON file per request into
 *   `<stateDir>/bridge-inbox/`:
 *     { "id": "<unique>", "text": "<the request>", "ts": <ms> }
 *
 *   v0.5.1: a request may also declare artifact post-conditions:
 *     { …, "deliverables": ["/absolute/path/report.md", …] }
 *   The paths ride the emitted message into the job record, and the
 *   completion path refuses verified-done until every one exists on
 *   disk — a bridge job that promised files can no longer settle on
 *   a text reply alone. A `deliverables` field that is present but
 *   unusable (not an array, or an array with no valid absolute path)
 *   parks the file as .bad like any other malformed request: quietly
 *   dropping a declared post-condition would recreate exactly the
 *   false "done" this field exists to prevent.
 *
 *   This adapter polls the directory, and for each file emits the
 *   exact ChannelEvent a chat message would have produced —
 *   conversation and sender taken from the `bridge` binding in
 *   delegates.json — so EVERY downstream rule is the chat rule,
 *   unchanged: secret screening, the sender gate (the request
 *   arrives as the delegate, never the operator), the Shield
 *   ingress scan, the classifier, the caps. Results, receipts, and
 *   approval buttons post to the conversation through the PRIMARY
 *   adapter (Telegram), where the operator watches; this adapter's
 *   own send() forwards there too, so a refusal notice for a
 *   bridge-submitted command is delivered, never dropped.
 *
 * Processed files move to `bridge-inbox/processed/` (audit trail on
 * disk); malformed ones move there with a `.bad` suffix and are
 * logged. Files are consumed only while a valid bridge binding
 * exists in delegates.json; without one the adapter is inert and
 * files wait untouched.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import type {
  ChannelAdapter,
  ChannelEvent,
  OutboundMessage,
} from "@gus/shared";
import { loadDelegates } from "./delegates.js";

export interface BridgeInboxOptions {
  /** Where outbound bridge traffic goes (the primary adapter's
   *  send). Required for delivery; without it send() throws and the
   *  host logs the loss like any other send failure. */
  sendVia?: (msg: OutboundMessage) => Promise<void>;
  pollMs?: number;
}

const MAX_TEXT_CHARS = 8_000;
const MAX_DELIVERABLES = 16;
const MAX_DELIVERABLE_CHARS = 1024;

/**
 * Parse a request file's optional `deliverables` field.
 *   absent            → { ok: true } with no deliverables (pre-v0.5.1
 *                       request files behave exactly as before)
 *   an array          → the valid entries: strings naming ABSOLUTE
 *                       paths (the completion check runs on this
 *                       machine), deduped, capped. An empty array
 *                       declares nothing and is treated as absent.
 *   anything unusable → { ok: false } — the caller parks the file as
 *                       .bad rather than silently losing the
 *                       requester's post-condition.
 */
export function parseDeliverables(
  raw: unknown,
): { ok: true; deliverables?: string[] } | { ok: false } {
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false };
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    if (!entry.startsWith("/") || entry.length > MAX_DELIVERABLE_CHARS) continue;
    seen.add(entry);
    if (seen.size >= MAX_DELIVERABLES) break;
  }
  if (raw.length > 0 && seen.size === 0) return { ok: false };
  return seen.size ? { ok: true, deliverables: [...seen] } : { ok: true };
}

export class BridgeInboxAdapter implements ChannelAdapter {
  readonly name = "bridge";
  private timer?: ReturnType<typeof setInterval>;
  private emitted = new Set<string>();
  private readonly inboxDir: string;
  private readonly processedDir: string;

  constructor(
    private stateDir: string,
    private opts: BridgeInboxOptions = {},
  ) {
    this.inboxDir = join(stateDir, "bridge-inbox");
    this.processedDir = join(this.inboxDir, "processed");
  }

  async start(onEvent: (ev: ChannelEvent) => void): Promise<void> {
    mkdirSync(this.processedDir, { recursive: true });
    const poll = () => {
      try {
        this.pollOnce(onEvent);
      } catch (e) {
        console.error(
          `gus bridge-inbox: poll failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    };
    poll();
    this.timer = setInterval(poll, this.opts.pollMs ?? 2_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.opts.sendVia) {
      throw new Error("bridge adapter has no outbound route (sendVia not configured)");
    }
    await this.opts.sendVia(msg);
  }

  async ackButton(): Promise<void> {
    /* Buttons never originate from bridge events; nothing to ack. */
  }

  /** One directory sweep. Exposed for the unit suite. */
  pollOnce(onEvent: (ev: ChannelEvent) => void): void {
    const bridge = loadDelegates(this.stateDir).bridge;
    if (!bridge) return;
    let names: string[];
    try {
      names = readdirSync(this.inboxDir)
        .filter((n) => n.endsWith(".json"))
        .sort();
    } catch {
      return; // inbox not created yet — nothing to do
    }
    for (const name of names) {
      const path = join(this.inboxDir, name);
      let entry: { id?: unknown; text?: unknown; deliverables?: unknown };
      try {
        entry = JSON.parse(readFileSync(path, "utf8")) as typeof entry;
      } catch {
        console.error(`gus bridge-inbox: malformed request file ${name} — parked as .bad`);
        this.move(path, `${name}.bad`);
        continue;
      }
      const id = typeof entry.id === "string" && entry.id ? entry.id : name.replace(/\.json$/, "");
      const text = typeof entry.text === "string" ? entry.text : "";
      if (!text || text.length > MAX_TEXT_CHARS) {
        console.error(`gus bridge-inbox: request ${id} has no usable text — parked as .bad`);
        this.move(path, `${name}.bad`);
        continue;
      }
      const parsed = parseDeliverables(entry.deliverables);
      if (!parsed.ok) {
        console.error(`gus bridge-inbox: request ${id} declares unusable deliverables — parked as .bad`);
        this.move(path, `${name}.bad`);
        continue;
      }
      if (this.emitted.has(id)) {
        this.move(path, name);
        continue;
      }
      this.emitted.add(id);
      onEvent({
        type: "message",
        message: {
          conversationId: bridge.conversationId,
          messageId: id,
          senderId: bridge.senderId,
          text,
          receivedAt: Date.now(),
          ...(parsed.deliverables ? { deliverables: parsed.deliverables } : {}),
        },
      });
      this.move(path, name);
    }
  }

  private move(path: string, destName: string): void {
    try {
      renameSync(path, join(this.processedDir, destName));
    } catch (e) {
      console.error(
        `gus bridge-inbox: could not archive ${path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
