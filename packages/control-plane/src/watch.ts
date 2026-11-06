/**
 * The Watch view's data sources (v0.6) — the timeline reader and
 * the frame source behind the panel backend (main.ts wires them;
 * they live here so the unit suite exercises the real code).
 *
 * Timeline: events.jsonl (host/channel events) merged with
 * gate.jsonl (Shield decisions), newest first. Both logs are
 * append-only durable state; torn lines are skipped, and receipt
 * ids ride along wherever the record carries one so a line can be
 * traced to its verifiable receipt.
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
import { existsSync, readFileSync } from "node:fs";
import type { PanelTimelineEntryData, PanelWatchFrameResult } from "@gus/panel";
import type { MacHostAdapter } from "./mac.js";

export function readWatchTimeline(stateDir: string, limit = 60): PanelTimelineEntryData[] {
  const entries: PanelTimelineEntryData[] = [];
  const readLines = (file: string): Record<string, unknown>[] => {
    try {
      if (!existsSync(file)) return [];
      const out: Record<string, unknown>[] = [];
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as Record<string, unknown>);
        } catch { /* torn line — skip */ }
      }
      return out;
    } catch {
      return [];
    }
  };
  for (const r of readLines(`${stateDir}/events.jsonl`)) {
    if (typeof r.ts !== "number" || typeof r.kind !== "string") continue;
    const detail =
      typeof r.detail === "string" ? r.detail
      : typeof r.error === "string" ? r.error
      : typeof r.summary === "string" ? r.summary
      : typeof r.id === "string" ? `id ${r.id}`
      : "";
    entries.push({
      ts: r.ts,
      source: "events",
      kind: r.kind,
      detail,
      ...(typeof r.jobId === "string" ? { jobId: r.jobId } : {}),
    });
  }
  for (const r of readLines(`${stateDir}/gate.jsonl`)) {
    if (typeof r.ts !== "number") continue;
    const surface = typeof r.surface === "string" ? r.surface : "gate";
    const action = typeof r.action === "string" ? r.action : "decision";
    const base = typeof r.detail === "string" ? r.detail : "";
    const detail = r.wouldBe ? `${base} (permissive — enforcing would ${String(r.wouldBe)})` : base;
    entries.push({
      ts: r.ts,
      source: "gate",
      kind: `gate ${surface} → ${action}`,
      detail,
      ...(typeof r.jobId === "string" ? { jobId: r.jobId } : {}),
      ...(typeof r.receiptId === "string" ? { receiptId: r.receiptId } : {}),
    });
  }
  return entries.sort((a, b) => b.ts - a.ts).slice(0, limit);
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
