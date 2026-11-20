/**
 * Devices OF the identity (v0.13.0 — the redo: pairing grants
 * are GONE; devices are re-homed under the one identity in
 * identity.ts).
 *
 * What v0.12.0 had, and why it went: the phone paired through
 * a PAIRING GRANT — a single-use, short-lived secret shown as
 * a QR code, exchanged once for a per-device credential. The
 * field verdict on that flow was decisive: Tailscale + QR was
 * too technical for novices, the v0.12.0 QR re-pair FAILED in
 * the operator's own drill, and afterwards even manual
 * re-pairing would not connect — a failed re-pair locked the
 * operator out of re-pairing entirely. The redo deletes the
 * QR flow rather than patching it: pairing is replaced by
 * login identity, not by a better ticket.
 *
 * What remains, and why it is shaped this way:
 *
 *   - A device is a CREDENTIAL OF THE IDENTITY. Every record
 *     carries the identityId it was enrolled under (stamped
 *     from the registry's identity at enrollment time), and
 *     the registry file itself records which identity it
 *     belongs to.
 *   - Enrollment is LOCAL: `enrollDevice` is the primitive the
 *     operator-present paths call — the operator is physically
 *     at the machine, or a future sign-in flow (R4) has already
 *     authenticated the identity and calls this on its behalf.
 *     There is no remote grant-exchange anymore: nothing
 *     unauthenticated can mint a device.
 *   - The per-device credential itself is unchanged in spirit:
 *     minted per device, returned ONCE at enrollment, stored
 *     only as a SHA-256 digest, revocable — and revocation
 *     stops the credential on the very next request because
 *     the registry is re-read on every authentication, like
 *     every other control-plane state file.
 *   - The panel's operator-token path is UNTOUCHED by all of
 *     this: the operator token still authenticates the panel
 *     exactly as before, and device credentials still only
 *     reach the surface the panel server grants them.
 *
 * Storage: `<stateDir>/devices.json`, mode 0600, following the
 * governor-mode.json pattern (re-read per decision, defensive
 * parse, a malformed file reads as an empty registry — never
 * as a permissive one). An OLD devices.json carrying a
 * "grants" array still loads: the field is simply ignored —
 * in-place migration by indifference — and the next save
 * writes the file without it. Secrets are stored HASHED
 * (SHA-256), never in clear: the file at rest holds only
 * digests, and the clear credential exists only in the
 * enrollment that mints it and in the device's own storage.
 * Comparisons are timing-safe (the digests are fixed-length,
 * so timingSafeEqual always applies). Nothing in this module
 * logs a secret — it returns device records and one-time
 * credentials to its caller and writes nothing anywhere else.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEVICES_FILE = "devices.json";

/** lastSeenAt is persisted at most this often per device — the
 *  companion polls every few seconds, and a state write per
 *  poll is churn the registry doesn't need. In-memory callers
 *  see the fresh value on the record returned by authenticate;
 *  the file carries the last persisted one. */
const LAST_SEEN_PERSIST_MS = 60 * 1000;

export interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number;
  revoked: boolean;
  /** The identity this device is a credential OF (identity.ts),
   *  stamped at enrollment when the registry knows it. Optional
   *  so records enrolled before the re-homing — and the panel's
   *  mirror type — keep their shape. */
  identityId?: string;
}

interface StoredDevice extends DeviceRecord {
  credentialHash: string;
}

interface DevicesFile {
  /** Which identity this registry belongs to, when known. */
  identityId?: string;
  devices: StoredDevice[];
}

function digest(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function digestHex(secret: string): string {
  return digest(secret).toString("hex");
}

/** Timing-safe equality over the fixed-length digests — the
 *  same discipline as the panel's operator-token check, applied
 *  to hashes so differing candidate lengths can't short-circuit
 *  the comparison. */
function digestEqual(aHex: string, candidate: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = digest(candidate);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cleanLabel(value: unknown, fallback: string, max: number): string {
  const s = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return (s || fallback).slice(0, max);
}

export class DeviceRegistry {
  /**
   * `identityId`, when the caller knows the install's identity
   * (identity.ts), is the registry's owner stamp: it wins over
   * whatever a loaded file says and is written on the next
   * save. Without it the registry keeps whatever identityId a
   * previous save recorded.
   */
  constructor(
    private stateDir: string,
    private identityId?: string,
  ) {}

  private path(): string {
    return join(this.stateDir, DEVICES_FILE);
  }

  /** The registry on disk, defensively parsed. A missing or
   *  malformed file is an EMPTY registry — devices simply
   *  don't exist until the file says so. A legacy "grants"
   *  array (v0.12.0) is ignored, not an error: see the header. */
  private load(): DevicesFile {
    try {
      const raw = JSON.parse(readFileSync(this.path(), "utf8")) as Partial<DevicesFile>;
      const devices = Array.isArray(raw.devices)
        ? raw.devices.filter(
            (d): d is StoredDevice =>
              !!d &&
              typeof d.id === "string" &&
              typeof d.credentialHash === "string" &&
              typeof d.createdAt === "number",
          )
        : [];
      const fileIdentityId =
        typeof raw.identityId === "string" && raw.identityId ? raw.identityId : undefined;
      const effectiveIdentityId = this.identityId ?? fileIdentityId;
      return {
        ...(effectiveIdentityId ? { identityId: effectiveIdentityId } : {}),
        devices: devices.map((d) => ({
          id: d.id,
          name: cleanLabel(d.name, "Unnamed device", 64),
          platform: cleanLabel(d.platform, "unknown", 32),
          createdAt: d.createdAt,
          lastSeenAt: typeof d.lastSeenAt === "number" ? d.lastSeenAt : d.createdAt,
          revoked: d.revoked === true,
          ...(typeof d.identityId === "string" && d.identityId ? { identityId: d.identityId } : {}),
          credentialHash: d.credentialHash,
        })),
      };
    } catch {
      return {
        ...(this.identityId ? { identityId: this.identityId } : {}),
        devices: [],
      };
    }
  }

  private save(file: DevicesFile): void {
    // The constructor's identityId wins; otherwise whatever the
    // loaded file carried is written back unchanged.
    const identityId = this.identityId ?? file.identityId;
    const out: DevicesFile = {
      ...(identityId ? { identityId } : {}),
      devices: file.devices,
    };
    writeFileSync(this.path(), JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  }

  /**
   * Enroll a device LOCALLY: the operator is present (or an
   * already-authenticated identity flow calls this on their
   * behalf — R4's sign-in will). This is what replaces the
   * deleted remote grant-exchange at the module level.
   *
   * Mints a per-device credential (32 random bytes, base64url),
   * stores only its SHA-256 digest, stamps the record with the
   * registry's identityId when known, and returns the clear
   * credential ONCE — the device stores it; this module keeps
   * no copy that could ever be read back.
   */
  enrollDevice(
    device: { name?: unknown; platform?: unknown },
    now: number = Date.now(),
  ): { device: DeviceRecord; credential: string } {
    const file = this.load();
    const identityId = this.identityId ?? file.identityId;
    const credential = randomBytes(32).toString("base64url");
    const record: StoredDevice = {
      id: randomUUID(),
      name: cleanLabel(device.name, "Unnamed device", 64),
      platform: cleanLabel(device.platform, "unknown", 32),
      createdAt: now,
      lastSeenAt: now,
      revoked: false,
      ...(identityId ? { identityId } : {}),
      credentialHash: digestHex(credential),
    };
    file.devices.push(record);
    this.save(file);
    const { credentialHash: _held, ...pub } = record;
    return { device: pub, credential };
  }

  /**
   * Authenticate a device credential. Returns the device record
   * (with lastSeenAt refreshed) or null — unknown, malformed,
   * and REVOKED credentials all read the same null, and a
   * revoked device stops working on the very next call because
   * the registry is re-read here every time.
   */
  authenticate(credential: string, now: number = Date.now()): DeviceRecord | null {
    if (!credential) return null;
    const file = this.load();
    const found = file.devices.find((d) => !d.revoked && digestEqual(d.credentialHash, credential));
    if (!found) return null;
    if (now - found.lastSeenAt >= LAST_SEEN_PERSIST_MS) {
      found.lastSeenAt = now;
      this.save(file);
    }
    const { credentialHash: _held, ...pub } = found;
    return { ...pub, lastSeenAt: Math.max(pub.lastSeenAt, now) };
  }

  /** The registry as the operator sees it — records only, never
   *  a digest, never a credential. */
  list(): DeviceRecord[] {
    return this.load().devices.map(({ credentialHash: _held, ...pub }) => pub);
  }

  /** Revoke a device: its credential stops working immediately
   *  (authenticate() re-reads the registry). The record stays —
   *  the operator should be able to see what was enrolled and
   *  when it was cut off. */
  revoke(id: string): boolean {
    const file = this.load();
    const found = file.devices.find((d) => d.id === id);
    if (!found || found.revoked) return false;
    found.revoked = true;
    this.save(file);
    return true;
  }
}
