/**
 * Agent-Shield API client (foundation spec §1.7) — Phase 4.
 *
 * The hosted half of the gate: the control plane calls the REAL
 * Agent-Shield worker (POST /v2/scan) and gets back a verdict plus a
 * signed, stateless, independently verifiable Protocol receipt
 * (POST /v1/receipts/verify, GET /v/<receipt_id>). The base URL is
 * configuration (env GUS_SHIELD_BASE_URL), so the identical wiring runs
 * against production, a self-hosted Shield, or a drill stand-in — the
 * code cannot tell the difference, and neither can the receipts' shape.
 *
 * Key handling (the discipline the whole product is built on):
 *   - The API key lives in the Vault Broker under the name
 *     "agent-shield". It is used ONLY inside a withSecret callback to
 *     set the X-API-Key header — it is never returned from any method,
 *     never written to a log, never placed in an error string.
 *   - Provisioning is the zero-form free signup (POST /v1/signup): the
 *     returned key goes straight from the response into the vault. The
 *     one place the value crosses a function boundary is the signup
 *     response handler below, in this process's memory, on its way
 *     into the encrypted store.
 */
import type { VaultBroker } from "@gus/vault";

export const SHIELD_KEY_NAME = "agent-shield";
export const DEFAULT_SHIELD_BASE_URL = "https://agent-shield.startekenterprises.com";

/** v2 honest vocabulary: "no_signals" replaces "clean" (the scanner
 *  detects signals; it does not certify absence). "clean" is accepted
 *  for robustness against v1-shaped responses. */
export type ShieldVerdict = "no_signals" | "clean" | "suspicious" | "malicious";

export interface ShieldReceipt {
  receiptId: string;
  verifyUrl: string;
  verdict: string;
  contentHash: string;
  scannedAt: string;
  analyzer: string;
}

export interface ShieldFinding {
  pattern: string;
  severity: string;
  detail?: string;
}

export type ShieldScanOutcome =
  | {
      status: "ok";
      verdict: ShieldVerdict;
      /** The API's own enforce-mode recommendation, when present. */
      action?: "allow" | "review" | "block";
      receipt: ShieldReceipt | null;
      /** The receipt exactly as issued (signature and all) — content-free
       *  by design, safe to persist; it is what /v1/receipts/verify
       *  re-checks later. */
      receiptRaw: Record<string, unknown> | null;
      findings: ShieldFinding[];
    }
  | { status: "no-key" }
  | { status: "unavailable"; detail: string };

export type ShieldTransportResponse = {
  status: number;
  json: () => Promise<unknown>;
};

/** Injectable for unit tests and drills; production uses global fetch. */
export type ShieldTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<ShieldTransportResponse>;

const defaultTransport: ShieldTransport = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, json: async () => res.json().catch(() => null) };
};

/** Map a scan outcome onto the gate's three actions (spec §1.7):
 *  block → never proceeds; flag → proceeds, flagged on the record;
 *  allow → proceeds. */
export function gateActionFor(outcome: Extract<ShieldScanOutcome, { status: "ok" }>): "allow" | "flag" | "block" {
  if (outcome.verdict === "malicious" || outcome.action === "block") return "block";
  if (outcome.verdict === "suspicious" || outcome.action === "review") return "flag";
  return "allow";
}

interface RawReceipt {
  receipt_id?: string;
  verify_url?: string;
  verdict?: string;
  content_hash?: string;
  scanned_at?: string;
  analyzer?: string;
  [k: string]: unknown;
}

export class ShieldClient {
  private transport: ShieldTransport;
  readonly baseUrl: string;

  constructor(
    private opts: {
      vault: VaultBroker;
      baseUrl?: string;
      keyName?: string;
      transport?: ShieldTransport;
    },
  ) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_SHIELD_BASE_URL).replace(/\/+$/, "");
    this.transport = opts.transport ?? defaultTransport;
  }

  private get keyName(): string {
    return this.opts.keyName ?? SHIELD_KEY_NAME;
  }

  hasKey(): boolean {
    return this.opts.vault.has(this.keyName);
  }

  /**
   * Zero-form free signup → key stored directly into the vault.
   * Returns a status only — the key value never leaves this method.
   */
  async provision(label = "gus"): Promise<{ ok: boolean; already?: boolean; detail: string }> {
    if (this.hasKey()) {
      return { ok: true, already: true, detail: "an Agent-Shield key is already in the vault" };
    }
    let res: ShieldTransportResponse;
    try {
      res = await this.transport(`${this.baseUrl}/v1/signup`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "gus-control-plane/0.4" },
        body: JSON.stringify({ label }),
      });
    } catch (e) {
      return { ok: false, detail: `signup request failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const body = (await res.json().catch(() => null)) as { api_key?: string } | null;
    if (res.status !== 200 || !body?.api_key) {
      return { ok: false, detail: `signup refused (HTTP ${res.status})` };
    }
    // The ONLY place the value exists outside the vault: this local,
    // on its way into the encrypted store in the next statement.
    const apiKey = body.api_key;
    try {
      this.opts.vault.add(this.keyName, apiKey);
    } catch (e) {
      return { ok: false, detail: `could not store the key in the vault: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, detail: "free Agent-Shield key provisioned and stored in the vault" };
  }

  /** Scan one piece of content. The key is attached inside the
   *  withSecret callback; it never exists in this method's frame. */
  async scan(
    content: string,
    contentType: "text" | "prompt" | "tool_output" | "email" | "webpage",
    nonce?: string,
  ): Promise<ShieldScanOutcome> {
    if (!this.hasKey()) return { status: "no-key" };
    let res: ShieldTransportResponse;
    try {
      const sent = await this.opts.vault.withSecret(this.keyName, (key) =>
        this.transport(`${this.baseUrl}/v2/scan`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "gus-control-plane/0.4",
            "x-api-key": key,
          },
          body: JSON.stringify({
            content,
            content_type: contentType,
            mode: "enforce",
            ...(nonce ? { nonce } : {}),
          }),
        }),
      );
      if (!sent) return { status: "no-key" };
      res = sent;
    } catch (e) {
      return {
        status: "unavailable",
        detail: `scan request failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: "unavailable", detail: `the Shield rejected our API key (HTTP ${res.status})` };
    }
    if (res.status === 429) {
      return { status: "unavailable", detail: "the Shield scan quota is exhausted for today (HTTP 429)" };
    }
    if (res.status !== 200) {
      return { status: "unavailable", detail: `scan failed (HTTP ${res.status})` };
    }
    const body = (await res.json().catch(() => null)) as {
      verdict?: string;
      action?: string;
      findings?: Array<{ pattern?: string; severity?: string; detail?: string }>;
      receipt?: RawReceipt | null;
    } | null;
    if (!body || typeof body.verdict !== "string") {
      return { status: "unavailable", detail: "scan response had no verdict" };
    }
    const r = body.receipt;
    return {
      status: "ok",
      verdict: body.verdict as ShieldVerdict,
      action:
        body.action === "allow" || body.action === "review" || body.action === "block"
          ? body.action
          : undefined,
      receipt:
        r && typeof r.receipt_id === "string"
          ? {
              receiptId: r.receipt_id,
              verifyUrl: typeof r.verify_url === "string" ? r.verify_url : `${this.baseUrl}/v/${r.receipt_id}`,
              verdict: String(r.verdict ?? body.verdict),
              contentHash: String(r.content_hash ?? ""),
              scannedAt: String(r.scanned_at ?? ""),
              analyzer: String(r.analyzer ?? ""),
            }
          : null,
      receiptRaw: r && typeof r.receipt_id === "string" ? (r as Record<string, unknown>) : null,
      findings: (body.findings ?? []).map((f) => ({
        pattern: String(f.pattern ?? "?"),
        severity: String(f.severity ?? "?"),
        detail: typeof f.detail === "string" ? f.detail : undefined,
      })),
    };
  }

  /**
   * Verify a full Shield receipt object against the live verify
   * endpoint (no key required — receipts are stateless and public to
   * verify by design). Returns null when the endpoint is unreachable,
   * so callers report "unverified" instead of guessing.
   */
  async verifyReceipt(receipt: Record<string, unknown>): Promise<boolean | null> {
    try {
      const res = await this.transport(`${this.baseUrl}/v1/receipts/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "gus-control-plane/0.4" },
        body: JSON.stringify({ receipt }),
      });
      if (res.status !== 200) return null;
      const body = (await res.json().catch(() => null)) as { valid?: boolean } | null;
      return body?.valid === true;
    } catch {
      return null;
    }
  }
}
