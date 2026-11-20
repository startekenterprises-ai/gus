/**
 * The entitlement skeleton (v0.12.0 — pivot spec §2.1, shipped
 * dark in Phase 1 / iPhone Step 1).
 *
 * Editions are a CLAIMS CHECK, not a code path: one codebase,
 * three editions (self-hosted / hosted / enterprise), resolved
 * at runtime from a signed-claims-shaped object:
 *
 *   { edition, features[], policyFloor?, expiresAt, keyId }
 *
 * Today there is exactly one issuer — nobody. With no
 * entitlement file on disk (the universal case), resolution
 * yields the DEFAULT claim set: edition "self-hosted", every
 * feature in the vocabulary present, no expiry, no floor. No
 * call site gates on a claim yet, no network call is made, and
 * behaviour is bit-for-bit what it was before this module
 * existed. The skeleton exists so later phases hang real
 * editions off it — feature checks at the same call sites in
 * every build — instead of retrofitting a fork.
 *
 * An operator-placed `<stateDir>/entitlement.json` is parsed
 * defensively and honoured for its edition/features shape;
 * anything malformed resolves to the default set (an invalid
 * entitlement degrades to self-hosted behaviour, never to a
 * dead agent — pivot spec §2.1). Signature VERIFICATION is
 * deliberately not faked here: there is no entitlement signing
 * key infrastructure yet, the claims' `signature` field is
 * carried for shape, and when StarTek's entitlement service
 * exists its signatures get verified at this exact seam before
 * a hosted claim is honoured. Until then the file is local
 * operator state, with the same trust as governor-mode.json:
 * someone who can write the state dir already owns the agent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type GusEdition = "self-hosted" | "hosted" | "enterprise";

/** The feature vocabulary claims are checked against — the
 *  pivot spec's call-site names (§2.1). Growing this list is
 *  how a capability becomes edition-gated; nothing gates on
 *  any of them yet. */
export const ENTITLEMENT_FEATURES = [
  "served-inference",
  "rendezvous",
  "sync",
  "approval-proxy",
  "policy-floor",
] as const;

export type EntitlementFeature = (typeof ENTITLEMENT_FEATURES)[number];

export interface EntitlementClaims {
  edition: GusEdition;
  features: string[];
  /** Slot for the enterprise policy floor (pivot spec §6.2) —
   *  carried, never applied in this release. */
  policyFloor?: Record<string, unknown>;
  /** null = no expiry (the self-hosted default). */
  expiresAt: number | null;
  /** Who issued the claims. The default set's issuer is the
   *  install itself. */
  keyId: string;
  /** Carried for shape; verified at this seam when an
   *  entitlement service exists (see header). */
  signature?: string;
}

const ENTITLEMENT_FILE = "entitlement.json";
const EDITIONS: readonly string[] = ["self-hosted", "hosted", "enterprise"];

/** The default claim set: self-hosted, everything on, forever.
 *  This is what every install resolves to today. */
export function defaultEntitlements(): EntitlementClaims {
  return {
    edition: "self-hosted",
    features: [...ENTITLEMENT_FEATURES],
    expiresAt: null,
    keyId: "local-default",
  };
}

/**
 * Resolve the install's entitlements. Re-read per call, like
 * every other control-plane state file, so a future entitlement
 * refresh needs no restart. `now` is injectable for tests: an
 * EXPIRED non-default claim set degrades to the default
 * (self-hosted) set rather than honouring stale features.
 */
export function resolveEntitlements(stateDir: string, now: number = Date.now()): EntitlementClaims {
  let raw: Partial<EntitlementClaims>;
  try {
    raw = JSON.parse(readFileSync(join(stateDir, ENTITLEMENT_FILE), "utf8")) as Partial<EntitlementClaims>;
  } catch {
    return defaultEntitlements();
  }
  if (!raw || typeof raw !== "object") return defaultEntitlements();
  if (typeof raw.edition !== "string" || !EDITIONS.includes(raw.edition)) return defaultEntitlements();
  if (!Array.isArray(raw.features) || raw.features.some((f) => typeof f !== "string")) {
    return defaultEntitlements();
  }
  const expiresAt = typeof raw.expiresAt === "number" ? raw.expiresAt : null;
  if (expiresAt !== null && expiresAt <= now) return defaultEntitlements();
  return {
    edition: raw.edition as GusEdition,
    features: [...raw.features],
    policyFloor:
      raw.policyFloor && typeof raw.policyFloor === "object" && !Array.isArray(raw.policyFloor)
        ? (raw.policyFloor as Record<string, unknown>)
        : undefined,
    expiresAt,
    keyId: typeof raw.keyId === "string" && raw.keyId ? raw.keyId : "local-file",
    signature: typeof raw.signature === "string" ? raw.signature : undefined,
  };
}

/** The claims check every future edition gate calls. */
export function hasFeature(claims: EntitlementClaims, feature: EntitlementFeature): boolean {
  return claims.features.includes(feature);
}
