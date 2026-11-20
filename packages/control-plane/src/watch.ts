/**
 * The Watch view's data sources (v0.6) — the timeline reader and
 * the frame source behind the panel backend (main.ts wires them;
 * they live here so the unit suite exercises the real code).
 *
 * Timeline: events.jsonl (host/channel events) merged with
 * gate.jsonl (Shield decisions), newest first. Both logs are
 * append-only durable state; torn lines are skipped, and receipt
 * ids ride along wherever the record carries one so a line can be
 * traced to its verifiable receipt. Since v0.11.0 each entry also
 * carries a derived category / narration / flagged triple (see
 * describeEvent/describeGate below) — the read model behind the
 * desktop chat's secure log.
 *
 * Frame: one on-demand observation of the Mac bridge, throttled
 * to ~1 fps by a cache (a client polling faster just gets the
 * same frame back), with an in-flight observation shared rather
 * than duplicated. Only successes are cached — a bridge that
 * appears recovers on the very next poll. The frame is decoded
 * here and served by the panel; it is never written to disk, and
 * the model never sees it (MacService's own observe path builds
 * its summary from the accessibility text alone).
 */
import type { PanelTimelineEntryData, PanelWatchFrameResult } from "@gus/panel";
import type { MacHostAdapter } from "./mac.js";
import { JsonlLogCache } from "./log-cache.js";

/**
 * v0.11.0 (the secure log): derive a timeline entry's category,
 * plain-language narration, and permissive-flag from the record
 * itself. Pure description of records that already exist — the
 * reader adds these fields so the chat secure log (and any other
 * surface) renders the same honest lines without re-deriving
 * them, and so the derivation is exercised by the unit suite
 * rather than living only in a view layer.
 *
 * The flagged narration is deliberately ONE short line — allowed,
 * logged, flagged as potentially insecure — in place of the long
 * recorded detail; the full detail and the receipt id stay on
 * the entry, one tap away. Nothing here changes what any record
 * means or what the gate/Governor did: presentation only.
 */
const FLAGGED_TAIL = "flagged as potentially insecure · logged";

function humanizeKind(kind: string): string {
  const words = kind.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : kind;
}

function toolOf(detail: string): string | undefined {
  return /^tool (\S+)/.exec(detail)?.[1];
}

function describeEvent(
  kind: string,
  detail: string,
): { category: "scan" | "approval" | "action"; narration: string; flagged: boolean } {
  if (kind === "permissive_action") {
    const tool = toolOf(detail);
    if (detail.includes("approved by GUS under the approval-delegation policy")) {
      // A delegated approval is an approval, not a bare
      // let-through: GUS decided, with its reason on the record.
      return {
        category: "approval",
        flagged: false,
        narration: `Approved by GUS as delegated approver — ${tool ? `tool ${tool}` : "the action"} is executing · logged`,
      };
    }
    return {
      category: "action",
      flagged: true,
      narration: tool
        ? `⚑ Allowed under Permissive — tool ${tool} proceeded · ${FLAGGED_TAIL}`
        : `⚑ Allowed under Permissive — ${FLAGGED_TAIL}`,
    };
  }
  if (kind === "permissive_ingress") {
    return {
      category: "scan",
      flagged: true,
      narration: `⚑ Allowed under Permissive — a flagged message proceeded · ${FLAGGED_TAIL}`,
    };
  }
  if (kind === "shield_flag_inbound") {
    return {
      category: "scan",
      flagged: false,
      narration: detail ? `Shield flagged an inbound message — ${detail}` : "Shield flagged an inbound message",
    };
  }
  if (kind === "shield_scan_skipped_voice") {
    return {
      category: "scan",
      flagged: false,
      narration: "Spoken turn proceeded without the Shield scan — the voice scan switch is off; the skip is on the record",
    };
  }
  if (kind.startsWith("approval")) {
    const lead =
      kind === "approval_requested" ? "Parked for approval — nothing runs until it is resolved"
      : kind === "approval_approved" ? "Approval granted"
      : kind === "approval_denied" ? "Approval denied — the action never ran"
      : kind === "approval_expired" ? "Approval expired — no answer counts as a denial"
      : kind === "approval_resolve_rejected" ? "An approval resolution was rejected"
      : humanizeKind(kind);
    return {
      category: "approval",
      flagged: false,
      narration: detail ? `${lead} — ${detail}` : lead,
    };
  }
  return {
    category: "action",
    flagged: false,
    narration: detail || humanizeKind(kind),
  };
}

function describeGate(
  surface: string,
  action: string,
  base: string,
  wouldBe: string | undefined,
): { category: "scan"; narration: string; flagged: boolean } {
  if (wouldBe) {
    return {
      category: "scan",
      flagged: true,
      narration: `⚑ Allowed under Permissive — this ${surface} scan would ${wouldBe} under Enforcing · ${FLAGGED_TAIL}`,
    };
  }
  return {
    category: "scan",
    flagged: false,
    narration: base ? `Shield scan — ${surface}: ${action} — ${base}` : `Shield scan — ${surface}: ${action}`,
  };
}

/** v0.14.0 (R2): the DERIVED timeline entries are cached per
 *  file through the incremental log cache (log-cache.ts) — the
 *  describeEvent/describeGate derivation below runs once per
 *  appended line, not once per poll over both whole files. One
 *  cache per log, module-level because readWatchTimeline is a
 *  free function the panel backend calls per poll; the caches
 *  key their state by full path, so state dirs never collide. */
const eventsTimelineCache = new JsonlLogCache<PanelTimelineEntryData>();
const gateTimelineCache = new JsonlLogCache<PanelTimelineEntryData>();

function mapEventLine(raw: unknown): PanelTimelineEntryData | undefined {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== "object") return undefined;
  if (typeof r.ts !== "number" || typeof r.kind !== "string") return undefined;
  const detail =
    typeof r.detail === "string" ? r.detail
    : typeof r.error === "string" ? r.error
    : typeof r.summary === "string" ? r.summary
    : typeof r.id === "string" ? `id ${r.id}`
    : "";
  return {
    ts: r.ts,
    source: "events",
    kind: r.kind,
    detail,
    ...(typeof r.jobId === "string" ? { jobId: r.jobId } : {}),
    ...describeEvent(r.kind, detail),
  };
}

function mapGateLine(raw: unknown): PanelTimelineEntryData | undefined {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== "object") return undefined;
  if (typeof r.ts !== "number") return undefined;
  const surface = typeof r.surface === "string" ? r.surface : "gate";
  const action = typeof r.action === "string" ? r.action : "decision";
  const base = typeof r.detail === "string" ? r.detail : "";
  const detail = r.wouldBe ? `${base} (permissive — enforcing would ${String(r.wouldBe)})` : base;
  return {
    ts: r.ts,
    source: "gate",
    kind: `gate ${surface} → ${action}`,
    detail,
    ...(typeof r.jobId === "string" ? { jobId: r.jobId } : {}),
    ...(typeof r.receiptId === "string" ? { receiptId: r.receiptId } : {}),
    ...describeGate(surface, action, base, typeof r.wouldBe === "string" && r.wouldBe ? r.wouldBe : undefined),
  };
}

export function readWatchTimeline(stateDir: string, limit = 60): PanelTimelineEntryData[] {
  const events = eventsTimelineCache.read(`${stateDir}/events.jsonl`, mapEventLine);
  const gate = gateTimelineCache.read(`${stateDir}/gate.jsonl`, mapGateLine);
  // The merge preserves the pre-cache reader's exact ordering
  // contract: events entries then gate entries, concatenated in
  // file order, then a (stable) newest-first sort — equal-ts
  // entries keep that concatenation order. The spread builds the
  // merged copy the sort may mutate; the caches' own arrays are
  // never sorted in place.
  return [...events, ...gate].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export class WatchFrameSource {
  private lastFrame?: { ts: number; bytes: Buffer };
  private inFlight?: Promise<PanelWatchFrameResult>;

  constructor(
    private host: MacHostAdapter,
    private minIntervalMs = 900,
  ) {}

  frame(): Promise<PanelWatchFrameResult> {
    if (this.lastFrame && Date.now() - this.lastFrame.ts < this.minIntervalMs) {
      return Promise.resolve({ ok: true, contentType: "image/png", bytes: this.lastFrame.bytes });
    }
    if (!this.inFlight) {
      this.inFlight = (async (): Promise<PanelWatchFrameResult> => {
        try {
          const obs = await this.host.observe();
          if (!obs.screenshotPngBase64) {
            return {
              ok: false,
              detail:
                "The Mac bridge answered, but the observation carried no screen frame — " +
                "Screen Recording is probably not granted to GUS.app (System Settings → " +
                "Privacy & Security → Screen Recording). The timeline below still works.",
            };
          }
          const bytes = Buffer.from(obs.screenshotPngBase64, "base64");
          this.lastFrame = { ts: Date.now(), bytes };
          return { ok: true, contentType: "image/png", bytes };
        } catch (e) {
          return {
            ok: false,
            detail: `No frame: ${e instanceof Error ? e.message : String(e)} The timeline below still works.`,
          };
        } finally {
          this.inFlight = undefined;
        }
      })();
    }
    return this.inFlight;
  }
}
