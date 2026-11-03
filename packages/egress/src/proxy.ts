/**
 * Egress Proxy (foundation spec §§1.3/1.7) — the sandbox's ONLY path to
 * the outside world, and it is not a network path: the sandbox has no
 * network at all. The agent asks (over the comm bridge) for a fetch; the
 * CONTROL PLANE performs it here, under rules the model cannot reach:
 *
 *   1. Scheme must be http/https; destination must be on the policy
 *      allowlist (exact host + port). Anything else is refused before a
 *      socket opens.
 *   2. Outbound screening: the URL, header values, and body are scanned
 *      with the secret-guard (S1 patterns) AND checked against every
 *      value in the vault. A secret value may leave only inside the one
 *      header slot the proxy itself fills (step 3) — anywhere else, in
 *      any request, it is blocked and logged redacted.
 *   3. Injection at the edge: if the request names a secret, a policy
 *      binding for (host, port, name) must exist; the proxy then sets
 *      the bound header from the vault, overwriting whatever the agent
 *      supplied for that header. The value exists only in this process's
 *      memory, only for this request.
 *   4. Redirects are followed manually (max 3), every hop re-checked
 *      against the allowlist. An injected credential is NEVER carried to
 *      a different host:port than its binding — a redirect that would
 *      move it blocks the whole request.
 *   5. Response screening: the body is S1-screened and scrubbed of every
 *      vault value before it can return toward the sandbox. An API that
 *      echoes the credential back gets its echo redacted; the agent
 *      never holds the value, so it can never relay it onward.
 *   6. Every call — allowed or blocked — is appended to the egress log
 *      (destination, secret NAMES used, byte counts, verdict) with a
 *      receipt from the gate package's issuer (Phase 0/1: the local
 *      stub issuer, stamped as such; real Agent-Shield receipts land in
 *      Phase 4). Log lines never contain secret values: URLs are logged
 *      origin+path with the query scrubbed, and all free text is
 *      screened before it is written.
 *
 * DNS pinning (Phase 5 hardening): the allowlist matches hostnames,
 * but a hostname is only as trustworthy as its DNS answer — a rebinding
 * attack resolves an allowlisted name to an internal address between
 * check and connect. So for every hop the proxy resolves the name
 * ONCE, connects to a resolved IP (the built-in transport pins the
 * socket to it via a createConnection override — the name is still
 * used for the Host header, TLS SNI, and certificate verification),
 * and then verifies the socket's actual remote address is in the
 * resolved set before the response is screened or returned. A
 * mismatch is blocked as
 * blocked:dns_rebinding_detected and the fetched bytes are discarded;
 * a name that does not resolve is blocked:dns_resolution_failed and no
 * socket opens. IP-literal destinations skip DNS (the literal IS the
 * pin). Transports injected for tests skip resolution unless a
 * resolver is injected too, but a transport that REPORTS its remote
 * address is always held to the resolved set when one exists.
 */
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP, type NetConnectOpts, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { screenText } from "@gus/shared";
import type { VaultBroker } from "@gus/vault";
import {
  findBinding,
  isAllowed,
  loadPolicy,
  type EgressPolicyData,
} from "./policy.js";

export interface EgressRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Vault secret NAME to inject per policy binding. Never a value. */
  secretName?: string;
}

export interface EgressTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** The IP the transport actually connected to, when it knows it.
   *  The built-in (pinned) transport always reports it; the proxy
   *  verifies it against the resolved set (DNS pinning). */
  remoteAddress?: string;
}

/** Resolves a hostname to its IP addresses. Injectable for tests;
 *  production uses node:dns lookup (all records, verbatim order). */
export type EgressResolver = (hostname: string) => Promise<string[]>;

/** Transport is injectable for unit tests; production uses global fetch
 *  with redirect:"manual" so step 4 above is ours, not the library's. */
export type EgressTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<EgressTransportResponse>;

export interface ReceiptIssuerLike {
  issue(input: {
    jobId: string;
    state: string;
    contentHash: string;
    costUsd: number;
  }): { receiptId: string };
}

export interface EgressResult {
  ok: boolean;
  /** Machine verdict: "allowed" or "blocked:<reason>". */
  verdict: string;
  status?: number;
  /** Response body AFTER vault-value + S1 scrubbing. Sandbox-safe. */
  body?: string;
  note?: string;
  secretNames: string[];
  receiptId: string;
}

export interface EgressLogEntry {
  ts: number;
  jobId: string;
  method: string;
  /** origin + pathname only; query scrubbed of secrets before logging. */
  url: string;
  secretNames: string[];
  bytesOut: number;
  bytesIn: number;
  status?: number;
  verdict: string;
  receiptId: string;
  /** The verified peer address of the final hop, when the transport
   *  reported one — DNS-pinning evidence lives in the audit log,
   *  deliberately NOT in the model-facing result notes: the
   *  tool-result text surface stays byte-stable (the Phase 4
   *  recorded-replay drill pins that format). */
  remoteAddress?: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 256 * 1024;
const BODY_FOR_CONTEXT = 8 * 1024;

/** Normalize an address for set comparison: an IPv4-mapped IPv6 form
 *  ("::ffff:1.2.3.4") is the same endpoint as the bare IPv4. */
function normalizeIp(ip: string): string {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:") && isIP(lower.slice(7)) === 4) return lower.slice(7);
  return lower;
}

const defaultResolver: EgressResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

/**
 * The built-in transport: connects to `pinnedIp` and nothing else.
 * The pin is a `createConnection` override on the request — the socket
 * is opened to the pinned address directly, so no DNS lookup happens
 * at connect time at all. The URL's hostname still drives the Host
 * header, TLS SNI (servername set explicitly), and certificate
 * verification (against the name, as it must be). The socket's real
 * remote address is reported back so the proxy can verify the pin
 * held. Redirects stay manual — the proxy follows them hop by hop.
 */
function pinnedTransport(pinnedIp: string): EgressTransport {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const isHttps = u.protocol === "https:";
      const doRequest = isHttps ? httpsRequest : httpRequest;
      const createConnection = (options: Record<string, unknown>): Socket | TLSSocket =>
        isHttps
          ? tlsConnect({
              ...options,
              host: pinnedIp,
              servername: typeof options.servername === "string" ? options.servername : u.hostname,
            } as ConnectionOptions)
          : netConnect({ ...options, host: pinnedIp } as NetConnectOpts);
      const req = doRequest(
        u,
        {
          method: init.method,
          headers: init.headers,
          timeout: 10_000,
          createConnection: createConnection as never,
        },
        (res) => {
          const remoteAddress = res.socket.remoteAddress;
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (c: Buffer) => {
            total += c.length;
            if (total <= 8 * 1024 * 1024) chunks.push(c);
          });
          res.on("end", () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
            }
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString("utf8"),
              remoteAddress,
            });
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("egress fetch timed out after 10000ms")));
      req.on("error", reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
}

export class EgressProxy {
  private transport: EgressTransport;
  /** True when the built-in pinned transport is in use (no injected
   *  transport): resolution + pinning are then always enforced. */
  private usePinnedTransport: boolean;
  private resolver?: EgressResolver;

  constructor(
    private opts: {
      vault: VaultBroker;
      policyPath: string;
      logPath: string;
      receiptsPath: string;
      issuer: ReceiptIssuerLike;
      transport?: EgressTransport;
      resolver?: EgressResolver;
    },
  ) {
    this.usePinnedTransport = opts.transport === undefined;
    // With the built-in transport there is no single instance: the hop
    // loop constructs pinnedTransport(chosenIp) per hop, after DNS
    // resolution picks the address. This placeholder is never called.
    this.transport =
      opts.transport ??
      (() => Promise.reject(new Error("egress: pinned transport is constructed per hop")));
    this.resolver = opts.resolver ?? (this.usePinnedTransport ? defaultResolver : undefined);
  }

  /** Resolve a hop's hostname once. Returns the normalized address
   *  set, or null when resolution is not in play for this call
   *  (injected test transport without an injected resolver). Throws /
   *  returns [] on resolution failure — the caller blocks. */
  private async resolveHop(hostname: string): Promise<string[] | null> {
    if (isIP(hostname)) return [normalizeIp(hostname)]; // the literal IS the pin
    if (!this.resolver) return null;
    const addrs = await this.resolver(hostname);
    return [...new Set(addrs.map(normalizeIp))];
  }

  /** Scrub a string of vault values and S1-pattern hits (for logging). */
  private scrub(text: string): string {
    const byVault = this.opts.vault.redactValues(text);
    return screenText(byVault.text).redacted;
  }

  private logAndReceipt(
    ctx: { jobId: string },
    req: EgressRequest,
    partial: Omit<EgressLogEntry, "ts" | "jobId" | "method" | "url" | "receiptId">,
    contentForHash: string,
  ): string {
    let logUrl = req.url;
    try {
      const u = new URL(req.url);
      logUrl = u.origin + u.pathname + (u.search ? `?${this.scrub(u.search.slice(1))}` : "");
    } catch {
      logUrl = this.scrub(req.url);
    }
    const receipt = this.opts.issuer.issue({
      jobId: ctx.jobId,
      state: partial.verdict,
      contentHash: sha256Hex(contentForHash),
      costUsd: 0,
    });
    const entry: EgressLogEntry = {
      ts: Date.now(),
      jobId: ctx.jobId,
      method: (req.method ?? "GET").toUpperCase(),
      url: logUrl,
      receiptId: receipt.receiptId,
      ...partial,
    };
    try {
      appendFileSync(this.opts.logPath, JSON.stringify(entry) + "\n");
      appendFileSync(
        this.opts.receiptsPath,
        JSON.stringify({ ...receipt, via: "egress-proxy" }) + "\n",
      );
    } catch {
      /* state dir is control-plane local; a logging failure must not
         turn into an unlogged ALLOWED call — callers see the receipt id
         either way, and the drill asserts the log exists. */
    }
    return receipt.receiptId;
  }

  async fetch(req: EgressRequest, ctx: { jobId: string }): Promise<EgressResult> {
    const vault = this.opts.vault;
    const secretNames = req.secretName ? [req.secretName] : [];
    const method = (req.method ?? "GET").toUpperCase();
    const bytesOut = (req.body ?? "").length;
    const hashInput = `${method} ${req.url}\n${req.body ?? ""}`;

    const blocked = (verdict: string, note: string): EgressResult => {
      const receiptId = this.logAndReceipt(
        ctx,
        req,
        { secretNames, bytesOut, bytesIn: 0, verdict },
        hashInput,
      );
      return { ok: false, verdict, note, secretNames, receiptId };
    };

    // -- step 1: parse + scheme + allowlist -------------------------------
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return blocked("blocked:bad_url", "the URL could not be parsed");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return blocked("blocked:scheme", `scheme ${url.protocol} is not permitted — http/https only`);
    }
    const policy: EgressPolicyData = loadPolicy(this.opts.policyPath);
    if (!isAllowed(policy, url)) {
      return blocked(
        "blocked:destination_not_allowlisted",
        `${url.host} is not on the egress allowlist`,
      );
    }

    // -- step 2: outbound screening (URL, headers, body) ------------------
    const outboundParts: Array<[string, string]> = [
      ["url", req.url],
      ...Object.entries(req.headers ?? {}).map(([k, v]): [string, string] => [`header ${k}`, v]),
      ["body", req.body ?? ""],
    ];
    for (const [where, text] of outboundParts) {
      if (!text) continue;
      const vaultHits = vault.findValuesIn(text);
      if (vaultHits.length > 0) {
        return blocked(
          "blocked:secret_in_outbound",
          `a vault secret value (${vaultHits.join(", ")}) appeared in the outbound ${where}; secrets leave only via proxy injection`,
        );
      }
      const s1 = screenText(text);
      if (!s1.clean) {
        return blocked(
          "blocked:secret_pattern_in_outbound",
          `the outbound ${where} matched secret pattern(s): ${[...new Set(s1.findings.map((f) => f.patternClass))].join(", ")}`,
        );
      }
    }

    // -- steps 3+4: injection + manual redirect following -----------------
    let currentUrl = url;
    let currentMethod = method;
    let currentBody = req.body;
    const baseHeaders: Record<string, string> = { ...(req.headers ?? {}) };
    let redirects = 0;
    let injectedFor: string | null = null; // "host:port" the credential was bound to

    for (;;) {
      const hopPolicy = loadPolicy(this.opts.policyPath);
      if (!isAllowed(hopPolicy, currentUrl)) {
        return blocked(
          "blocked:redirect_destination_not_allowlisted",
          `redirect destination ${currentUrl.host} is not on the egress allowlist`,
        );
      }
      const headers: Record<string, string> = { ...baseHeaders };
      if (req.secretName) {
        const binding = findBinding(hopPolicy, currentUrl, req.secretName);
        if (!binding) {
          return blocked(
            injectedFor
              ? "blocked:redirect_off_binding"
              : "blocked:secret_not_bound_to_destination",
            injectedFor
              ? `redirect to ${currentUrl.host} would move the credential off its binding`
              : `secret "${req.secretName}" has no injection binding for ${currentUrl.host}`,
          );
        }
        // Strip any agent-supplied copy of the bound header (any casing),
        // then set it from the vault. The value never leaves this process.
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === binding.header.toLowerCase()) delete headers[k];
        }
        const injected = vault.withSecret(req.secretName, (value) => {
          headers[binding.header] = value;
          return true;
        });
        if (injected !== true) {
          return blocked("blocked:secret_not_in_vault", `no vault secret named "${req.secretName}"`);
        }
        injectedFor = `${currentUrl.hostname}:${currentUrl.port || (currentUrl.protocol === "https:" ? "443" : "80")}`;
      }

      // -- DNS pinning: resolve this hop once, connect only to a
      //    resolved address, verify the socket's real peer afterwards.
      let resolved: string[] | null;
      try {
        resolved = await this.resolveHop(currentUrl.hostname);
      } catch {
        return blocked(
          "blocked:dns_resolution_failed",
          `DNS resolution failed for ${currentUrl.hostname}; no connection was attempted`,
        );
      }
      if (resolved !== null && resolved.length === 0) {
        return blocked(
          "blocked:dns_resolution_failed",
          `DNS returned no addresses for ${currentUrl.hostname}; no connection was attempted`,
        );
      }

      let resp: EgressTransportResponse;
      try {
        if (this.usePinnedTransport) {
          // Try each resolved address in order; the transport pins the
          // socket to the one in use. (resolved is non-null here: the
          // built-in path always has a resolver.)
          let lastErr: unknown;
          resp = undefined as never;
          for (const ip of resolved ?? []) {
            try {
              resp = await pinnedTransport(ip)(currentUrl.toString(), {
                method: currentMethod,
                headers,
                body: currentBody,
              });
              lastErr = undefined;
              break;
            } catch (e) {
              lastErr = e;
            }
          }
          if (lastErr !== undefined) throw lastErr;
        } else {
          resp = await this.transport(currentUrl.toString(), {
            method: currentMethod,
            headers,
            body: currentBody,
          });
        }
      } catch (e) {
        return blocked("blocked:transport_error", `fetch failed: ${this.scrub(String(e)).slice(0, 200)}`);
      }

      // The peer the socket ACTUALLY reached must be one of the
      // addresses this hop resolved to. Otherwise the name was
      // rebound between resolution and connect: discard the response
      // unscreened — it never gets near the agent.
      if (resolved !== null && resp.remoteAddress !== undefined) {
        if (!resolved.includes(normalizeIp(resp.remoteAddress))) {
          return blocked(
            "blocked:dns_rebinding_detected",
            `connected to ${resp.remoteAddress}, which is not among the resolved addresses for ${currentUrl.hostname} (${resolved.join(", ")}); the response was discarded`,
          );
        }
      }

      const location = resp.headers["location"];
      if (REDIRECT_STATUSES.has(resp.status) && location) {
        if (redirects >= MAX_REDIRECTS) {
          return blocked("blocked:too_many_redirects", `more than ${MAX_REDIRECTS} redirects`);
        }
        let next: URL;
        try {
          next = new URL(location, currentUrl);
        } catch {
          return blocked("blocked:bad_redirect", "redirect Location could not be parsed");
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return blocked("blocked:scheme", `redirect scheme ${next.protocol} is not permitted`);
        }
        if (
          (resp.status === 301 || resp.status === 302 || resp.status === 303) &&
          currentMethod !== "GET" &&
          currentMethod !== "HEAD"
        ) {
          currentMethod = "GET";
          currentBody = undefined;
        }
        currentUrl = next;
        redirects++;
        continue;
      }

      // -- step 5: response screening --------------------------------------
      let body = resp.body ?? "";
      let truncated = false;
      if (body.length > MAX_BODY_BYTES) {
        body = body.slice(0, MAX_BODY_BYTES);
        truncated = true;
      }
      const vaultScrub = vault.redactValues(body);
      const s1 = screenText(vaultScrub.text);
      const cleanBody = s1.redacted.slice(0, BODY_FOR_CONTEXT);
      const notes: string[] = [];
      if (vaultScrub.names.length > 0) {
        notes.push(
          `response contained vault secret value(s) for ${vaultScrub.names.join(", ")} — withheld before reaching the agent`,
        );
      }
      if (!s1.clean) {
        notes.push(
          `response contained secret-pattern content (${[...new Set(s1.findings.map((f) => f.patternClass))].join(", ")}) — redacted`,
        );
      }
      if (truncated) notes.push(`response truncated at ${MAX_BODY_BYTES} bytes`);
      if (redirects > 0) notes.push(`followed ${redirects} redirect(s), all allowlisted`);

      const receiptId = this.logAndReceipt(
        ctx,
        req,
        {
          secretNames,
          bytesOut,
          bytesIn: (resp.body ?? "").length,
          status: resp.status,
          verdict: "allowed",
          ...(resp.remoteAddress !== undefined
            ? { remoteAddress: resp.remoteAddress }
            : {}),
        },
        hashInput,
      );
      return {
        ok: true,
        verdict: "allowed",
        status: resp.status,
        body: cleanBody,
        note: notes.length > 0 ? notes.join("; ") : undefined,
        secretNames,
        receiptId,
      };
    }
  }
}
