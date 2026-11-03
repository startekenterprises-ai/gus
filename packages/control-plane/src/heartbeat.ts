/**
 * Install heartbeat (foundation spec §5 — kill-criteria instrumentation).
 *
 * The 6-month adoption criterion needs a number that exists before
 * anyone asks for it, collected without collecting anything ABOUT the
 * operator. The whole design is what this file refuses to do:
 *
 *  - OFF by default. Nothing is sent unless the operator opts in with
 *    GUS_HEARTBEAT=1 (and points GUS_HEARTBEAT_URL at a counter).
 *  - The payload is exactly { version, mode } — the GUS version and
 *    "self-host". No install id, no job counts, no content, no
 *    configuration, nothing derived from the operator's data. There is
 *    deliberately no persistent identifier: the counter learns "an
 *    install of vX exists", never "install #12345 is alive".
 *  - Best-effort and silent: a failed ping is dropped, never retried
 *    aggressively, never logged with the URL, and can never block or
 *    crash the control plane.
 *
 * The receiving end is an aggregate-only counter operated by StarTek
 * (hosted-tier operations — spec §3: operations, never features). This
 * client ships in the open build; the counter's URL is configuration,
 * not code, so a self-hoster can point the same client at their own
 * counter instead of ours, or leave it off.
 */
import { GUS_VERSION } from "@gus/shared";

export interface HeartbeatConfig {
  enabled: boolean;
  url?: string;
  intervalMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function heartbeatConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HeartbeatConfig {
  return {
    enabled: env.GUS_HEARTBEAT === "1" && typeof env.GUS_HEARTBEAT_URL === "string" && env.GUS_HEARTBEAT_URL.length > 0,
    url: env.GUS_HEARTBEAT_URL,
    intervalMs: DAY_MS,
  };
}

/** One ping. Exported for tests; never throws. */
export async function sendHeartbeat(
  config: HeartbeatConfig,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (!config.enabled || !config.url) return false;
  try {
    const res = await fetchFn(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: GUS_VERSION, mode: "self-host" }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false; // best-effort by design: silence, not a retry loop
  }
}

/** Start the (opt-in) heartbeat: one ping at boot, then daily.
 *  Returns a stop function. No-op (returns a no-op stop) when the
 *  operator has not opted in. The timer is unref'd — the heartbeat
 *  never keeps a process alive. */
export function startHeartbeat(
  config: HeartbeatConfig = heartbeatConfigFromEnv(),
  fetchFn: typeof fetch = fetch,
): () => void {
  if (!config.enabled) return () => {};
  void sendHeartbeat(config, fetchFn);
  const timer = setInterval(() => void sendHeartbeat(config, fetchFn), config.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
