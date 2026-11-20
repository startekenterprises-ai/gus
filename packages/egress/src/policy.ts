/**
 * Egress policy (foundation spec §§1.3/1.7) — the operator-owned rules
 * the proxy enforces OUTSIDE the model:
 *
 *   allow:      exact host (+ optional port list) destinations the
 *               sandbox may reach at all. No wildcards in v1 — an entry
 *               names one host, deliberately.
 *   injections: bindings of (host, port, secret name) -> header. A vault
 *               secret may be injected ONLY where a binding exists, ONLY
 *               into the named header, ONLY by the proxy. The agent asks
 *               for a secret BY NAME; the binding decides whether that
 *               name may travel to that destination.
 *
 * The policy file lives in control-plane state. The sandbox cannot read
 * or write it (it cannot see the state volume). The proxy re-reads it on
 * every call, so an operator edit takes effect on the next request and
 * there is no cached copy for anything to tamper with. A missing or
 * malformed policy is a DENY-ALL policy — fail closed, never open.
 */
import { existsSync, readFileSync } from "node:fs";

export interface AllowEntry {
  host: string;
  /** Ports allowed for this host. Omitted = the scheme default port only. */
  ports?: number[];
}

export interface InjectionBinding {
  host: string;
  /** Port the binding applies to. Omitted = the scheme default port. */
  port?: number;
  /** Vault secret NAME (a handle — never a value). */
  secret: string;
  /** Header the proxy injects the value into, e.g. "x-api-key". */
  header: string;
}

export interface EgressPolicyData {
  allow: AllowEntry[];
  injections: InjectionBinding[];
}

export const DENY_ALL_POLICY: EgressPolicyData = { allow: [], injections: [] };

export function loadPolicy(policyPath: string): EgressPolicyData {
  try {
    if (!existsSync(policyPath)) return DENY_ALL_POLICY;
    const parsed = JSON.parse(readFileSync(policyPath, "utf8")) as Partial<EgressPolicyData>;
    const allow = Array.isArray(parsed.allow)
      ? parsed.allow.filter(
          (e): e is AllowEntry =>
            !!e && typeof e.host === "string" &&
            (e.ports === undefined || (Array.isArray(e.ports) && e.ports.every((p) => Number.isInteger(p)))),
        )
      : [];
    const injections = Array.isArray(parsed.injections)
      ? parsed.injections.filter(
          (b): b is InjectionBinding =>
            !!b && typeof b.host === "string" && typeof b.secret === "string" &&
            typeof b.header === "string" &&
            (b.port === undefined || Number.isInteger(b.port)),
        )
      : [];
    return { allow, injections };
  } catch {
    return DENY_ALL_POLICY; // fail closed on any parse/shape error
  }
}

export function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function hostMatches(entryHost: string, url: URL): boolean {
  return entryHost.toLowerCase() === url.hostname.toLowerCase();
}

export function isAllowed(policy: EgressPolicyData, url: URL): boolean {
  const port = effectivePort(url);
  return policy.allow.some((e) => {
    if (!hostMatches(e.host, url)) return false;
    if (e.ports === undefined) {
      return port === (url.protocol === "https:" ? 443 : 80);
    }
    return e.ports.includes(port);
  });
}

export function findBinding(
  policy: EgressPolicyData,
  url: URL,
  secretName: string,
): InjectionBinding | undefined {
  const port = effectivePort(url);
  return policy.injections.find((b) => {
    if (!hostMatches(b.host, url) || b.secret !== secretName) return false;
    const bindingPort = b.port ?? (url.protocol === "https:" ? 443 : 80);
    return bindingPort === port;
  });
}
