/**
 * The ONE GUS identity (v0.13.0 — the redo, spec §2.1).
 *
 * The problem this replaces: in v0.12.0 every surface had its
 * own idea of who was asking. The panel held the operator
 * token, the phone held a per-device credential minted by a
 * QR pairing grant, and nothing tied them together except
 * proximity to the same Mac. The redo's answer is a single
 * identity, minted once for the install, that every surface
 * authenticates TO: devices are credentials OF this identity
 * (devices.ts), the panel's operator-token path is untouched,
 * and a future phone sign-in resolves to this same record
 * instead of inventing a second account.
 *
 * Providers sit at ONE seam, in build order:
 *
 *   1. "local"          — no-login local: the machine is the
 *                         lock. This is the default and the
 *                         current posture; being able to run
 *                         GUS on the machine at all IS the
 *                         authentication.
 *   2. "local-password" — an optional local username/password,
 *                         for operators who want a lock on top
 *                         of the machine.
 *   3. "google"/"apple" — hosted-edition sign-in. SEAM STUBS
 *                         ONLY in this build: no OAuth, no
 *                         network, nothing to configure. They
 *                         exist so the hosted edition can add
 *                         them without another identity
 *                         redesign.
 *   4. "sso"            — enterprise SSO. SEAM STUB ONLY, same
 *                         reasoning as (3).
 *
 * Storage: `<stateDir>/identity.json`, mode 0600, following
 * the devices.json / governor-mode.json pattern (defensive
 * parse, re-read per call). A MISSING file mints a fresh
 * identity and persists it; a MALFORMED file also mints fresh
 * — this module never throws over its own state, because an
 * identity that can't load would lock the operator out of
 * their own agent entirely. Minting fresh loses nothing but
 * the record itself: device credentials live in devices.json
 * and keep authenticating against their digests regardless.
 *
 * The password credential, when one is set, lives separately
 * in `<stateDir>/identity-credentials.json`, mode 0600, and is
 * NEVER stored in clear: only a scrypt digest (with its salt)
 * is written. Verification recomputes the digest and compares
 * with timingSafeEqual over the fixed-length digests, so
 * differing candidate lengths can't short-circuit the check.
 * Nothing in this module logs or prints a password — it
 * returns plain-language results and writes digests only.
 *
 * v0.14.5: the launch gate. The identity record gains a
 * `welcomedAt` marker — set explicitly by the panel when the
 * operator completes or dismisses the first-run login screen
 * (identity.json alone can't be the first-run signal: this
 * service auto-mints it at startup). A successful sign-in
 * through the ACTIVE provider mints a session into
 * `<stateDir>/session.json`, mode 0600, holding a random
 * token, the provider kind, and a creation time — never a
 * password. A present session whose provider still matches
 * the active provider is what lets a later launch skip the
 * gate (log in once, stay logged in, until explicit
 * sign-out). The gate is a launch screen, not a new security
 * boundary: the app→panel channel stays loopback + the
 * panel-token file, and this module's session never leaves
 * the state dir — readouts carry the provider and creation
 * time, never the token.
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IDENTITY_FILE = "identity.json";
const CREDENTIALS_FILE = "identity-credentials.json";
const SESSION_FILE = "session.json";

/** Every provider kind, in build order — providers() reports
 *  in exactly this order. */
export type IdentityProviderKind = "local" | "local-password" | "google" | "apple" | "sso";

const PROVIDER_KINDS: readonly IdentityProviderKind[] = [
  "local",
  "local-password",
  "google",
  "apple",
  "sso",
];

export interface IdentityRecord {
  /** Minted once (a uuid) when the identity is first created;
   *  every device enrolled under this identity is stamped
   *  with it (see devices.ts). */
  id: string;
  createdAt: number;
  displayName?: string;
  /** The ACTIVE provider — how this install authenticates
   *  its operator. Only "local" and "local-password" can be
   *  active in this build; the stub kinds refuse. */
  provider: IdentityProviderKind;
  /** v0.14.5: when the operator completed (or dismissed) the
   *  first-run login screen. Absent = the screen still owes
   *  this install one appearance. Set only by markWelcomed()
   *  — never at mint time. */
  welcomedAt?: number;
  /** v0.14.6: the operator's auto-login posture. Absent or
   *  true = the launch gate applies (the first-run screen is
   *  owed; a password provider asks at every cold start).
   *  False = the operator turned the gate off from the
   *  Protection home: the app opens straight in. A posture,
   *  not a credential — the password itself is untouched, and
   *  turning the gate back on restores the ask immediately. */
  launchGateEnabled?: boolean;
}

/** v0.14.5: the public readout of a live session — the
 *  provider it was minted under and when. The token itself
 *  never appears here (or anywhere outside session.json). */
export interface IdentitySession {
  provider: IdentityProviderKind;
  createdAt: number;
}

export type IdentityAuthResult =
  | { ok: true; principal: "operator" }
  | { ok: false; detail: string };

/** One authentication provider at the seam. `configured()`
 *  says whether this provider could authenticate anyone at
 *  all right now; `authenticate()` is the check itself. The
 *  only principal this build knows is the operator — a future
 *  hosted edition widens the principal, not the seam. */
export interface IdentityProvider {
  kind: IdentityProviderKind;
  configured(): boolean;
  authenticate(cred: { username?: string; password?: string }): IdentityAuthResult;
}

/**
 * Provider 1 — no-login local. The machine is the lock: an
 * operator who can run GUS on this machine is the operator.
 * Always configured, always authenticates.
 */
export class LocalProvider implements IdentityProvider {
  readonly kind: IdentityProviderKind = "local";

  configured(): boolean {
    return true;
  }

  authenticate(_cred: { username?: string; password?: string }): IdentityAuthResult {
    return { ok: true, principal: "operator" };
  }
}

/**
 * Provider 2 — local username/password. Configured exactly
 * when a password credential is on file; authentication is
 * delegated to the service's verifyPassword so there is one
 * scrypt/timing-safe code path, not a second one hiding here.
 */
export class LocalPasswordProvider implements IdentityProvider {
  readonly kind: IdentityProviderKind = "local-password";

  constructor(
    private deps: {
      isConfigured: () => boolean;
      verify: (username: string, password: string) => boolean;
    },
  ) {}

  configured(): boolean {
    return this.deps.isConfigured();
  }

  authenticate(cred: { username?: string; password?: string }): IdentityAuthResult {
    if (!this.configured()) {
      return {
        ok: false,
        detail:
          "No local password is set — GUS is using no-login local identity. Set a password first if you want one.",
      };
    }
    if (!cred.username || !cred.password) {
      return { ok: false, detail: "A username and a password are both needed to sign in. Nothing was signed in." };
    }
    if (!this.deps.verify(cred.username, cred.password)) {
      return { ok: false, detail: "That username or password doesn't match what's on file. Nothing was signed in." };
    }
    return { ok: true, principal: "operator" };
  }
}

/**
 * Providers 3 and 4 — the seam stubs (Google, Apple,
 * enterprise SSO). Deliberately inert: not configured, never
 * authenticates, no OAuth, no network. The seam exists so the
 * hosted edition can add real sign-in behind this same
 * interface without another identity redesign.
 */
export class StubIdentityProvider implements IdentityProvider {
  constructor(
    readonly kind: IdentityProviderKind,
    private displayName: string,
  ) {}

  configured(): boolean {
    return false;
  }

  authenticate(_cred: { username?: string; password?: string }): IdentityAuthResult {
    return {
      ok: false,
      detail: `${this.displayName} sign-in isn't configured in this build — the provider seam exists so the hosted edition can add it without another identity redesign. Nothing was signed in.`,
    };
  }
}

/** The display name a stub kind answers to in plain language. */
function stubDisplayName(kind: IdentityProviderKind): string {
  switch (kind) {
    case "google":
      return "Google";
    case "apple":
      return "Apple";
    case "sso":
      return "Enterprise SSO";
    default:
      return kind;
  }
}

interface StoredCredentials {
  username: string;
  /** Hex, 16 random bytes, minted fresh on every setPassword. */
  salt: string;
  /** Hex, the 64-byte scrypt digest of the password. The
   *  password itself is never stored, in any form. */
  hash: string;
  updatedAt: number;
}

/**
 * Password hashing: node:crypto scryptSync with its DEFAULT
 * cost parameters (N=16384, r=8, p=1) and a 64-byte output.
 * The defaults are a deliberate choice, not an oversight —
 * they are Node's tuned interactive-login cost, and this
 * build has no reason to second-guess them. If the cost is
 * ever raised, stored digests need a version field first;
 * verification below always recomputes at the same length.
 */
function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 64);
}

export class IdentityService {
  constructor(private stateDir: string) {}

  private identityPath(): string {
    return join(this.stateDir, IDENTITY_FILE);
  }

  private credentialsPath(): string {
    return join(this.stateDir, CREDENTIALS_FILE);
  }

  /** The identity on disk, defensively parsed. Returns null
   *  for a missing OR malformed file — identity() treats both
   *  the same way (mint fresh) and never throws. */
  private loadIdentity(): IdentityRecord | null {
    try {
      const raw = JSON.parse(readFileSync(this.identityPath(), "utf8")) as Partial<IdentityRecord>;
      if (!raw || typeof raw !== "object") return null;
      if (typeof raw.id !== "string" || !raw.id) return null;
      if (typeof raw.createdAt !== "number") return null;
      if (typeof raw.provider !== "string" || !PROVIDER_KINDS.includes(raw.provider as IdentityProviderKind)) {
        return null;
      }
      return {
        id: raw.id,
        createdAt: raw.createdAt,
        ...(typeof raw.displayName === "string" && raw.displayName ? { displayName: raw.displayName } : {}),
        provider: raw.provider as IdentityProviderKind,
        ...(typeof raw.welcomedAt === "number" ? { welcomedAt: raw.welcomedAt } : {}),
        ...(typeof raw.launchGateEnabled === "boolean" ? { launchGateEnabled: raw.launchGateEnabled } : {}),
      };
    } catch {
      return null;
    }
  }

  private saveIdentity(record: IdentityRecord): void {
    writeFileSync(this.identityPath(), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  }

  /** The password credential on disk, defensively parsed.
   *  Null when absent or malformed — an unreadable credential
   *  is the same as no credential: verification fails closed
   *  and the provider reads as unconfigured. */
  private loadCredentials(): StoredCredentials | null {
    try {
      const raw = JSON.parse(readFileSync(this.credentialsPath(), "utf8")) as Partial<StoredCredentials>;
      if (!raw || typeof raw !== "object") return null;
      if (typeof raw.username !== "string" || !raw.username) return null;
      if (typeof raw.salt !== "string" || !/^[0-9a-f]+$/i.test(raw.salt)) return null;
      if (typeof raw.hash !== "string" || !/^[0-9a-f]+$/i.test(raw.hash)) return null;
      if (typeof raw.updatedAt !== "number") return null;
      return { username: raw.username, salt: raw.salt, hash: raw.hash, updatedAt: raw.updatedAt };
    } catch {
      return null;
    }
  }

  private hasPasswordCredential(): boolean {
    return this.loadCredentials() !== null;
  }

  private sessionPath(): string {
    return join(this.stateDir, SESSION_FILE);
  }

  /** The session on disk, defensively parsed — the stored
   *  shape (WITH the token; this never leaves the service).
   *  Null when absent or malformed: an unreadable session is
   *  the same as being signed out, never an error. */
  private loadSession(): { token: string; provider: IdentityProviderKind; createdAt: number } | null {
    try {
      const raw = JSON.parse(readFileSync(this.sessionPath(), "utf8")) as Partial<{
        token: string;
        provider: string;
        createdAt: number;
      }>;
      if (!raw || typeof raw !== "object") return null;
      if (typeof raw.token !== "string" || !/^[0-9a-f]{32,}$/i.test(raw.token)) return null;
      if (typeof raw.provider !== "string" || !PROVIDER_KINDS.includes(raw.provider as IdentityProviderKind)) {
        return null;
      }
      if (typeof raw.createdAt !== "number") return null;
      return {
        token: raw.token,
        provider: raw.provider as IdentityProviderKind,
        createdAt: raw.createdAt,
      };
    } catch {
      return null;
    }
  }

  /**
   * The install's ONE identity: the record on disk, or a
   * freshly minted one (uuid id, provider "local") persisted
   * on first ask. Missing and malformed files both land here
   * — see the header for why malformed mints instead of
   * throwing.
   */
  identity(): IdentityRecord {
    const existing = this.loadIdentity();
    if (existing) return existing;
    const fresh: IdentityRecord = {
      id: randomUUID(),
      createdAt: Date.now(),
      provider: "local",
    };
    this.saveIdentity(fresh);
    return fresh;
  }

  /** Every provider at the seam, in build order, with whether
   *  each is configured in this build right now. */
  providers(): { kind: IdentityProviderKind; configured: boolean }[] {
    return PROVIDER_KINDS.map((kind) => ({ kind, configured: this.provider(kind).configured() }));
  }

  /** The provider registry: local and local-password are real;
   *  google, apple, and sso are the seam stubs. */
  provider(kind: IdentityProviderKind): IdentityProvider {
    switch (kind) {
      case "local":
        return new LocalProvider();
      case "local-password":
        return new LocalPasswordProvider({
          isConfigured: () => this.hasPasswordCredential(),
          verify: (username, password) => this.verifyPassword(username, password),
        });
      case "google":
      case "apple":
      case "sso":
        return new StubIdentityProvider(kind, stubDisplayName(kind));
      default:
        // Unreachable for typed callers; a runtime caller with
        // an unknown kind gets the stub treatment, never a throw.
        return new StubIdentityProvider(kind, String(kind));
    }
  }

  /**
   * Switch the ACTIVE provider on the identity record. Only
   * "local" and "local-password" may be activated in this
   * build — local-password only once a password is on file —
   * and the stub kinds refuse plainly. A refusal changes
   * nothing on disk.
   */
  setActiveProvider(kind: IdentityProviderKind): { ok: boolean; detail: string } {
    if (kind === "google" || kind === "apple" || kind === "sso") {
      return {
        ok: false,
        detail: `${stubDisplayName(kind)} sign-in isn't configured in this build — it can't be made the active provider. Nothing was changed.`,
      };
    }
    if (kind === "local-password" && !this.hasPasswordCredential()) {
      return {
        ok: false,
        detail:
          "No local password is set — set a password first before switching to local username/password identity. Nothing was changed.",
      };
    }
    if (kind !== "local" && kind !== "local-password") {
      return { ok: false, detail: "That isn't an identity provider GUS knows. Nothing was changed." };
    }
    const record = this.identity();
    const changed = record.provider !== kind;
    record.provider = kind;
    this.saveIdentity(record);
    // v0.14.5: a session minted under the old provider must
    // not carry across a switch — the next launch gates again
    // under the new provider.
    if (changed) this.clearSession();
    return {
      ok: true,
      detail:
        kind === "local"
          ? "Active identity provider is now no-login local — the machine is the lock."
          : "Active identity provider is now local username/password.",
    };
  }

  /**
   * Set (or replace) the local password credential. Only the
   * scrypt digest and its salt are stored — never the
   * plaintext. Setting a password does NOT by itself switch
   * the active provider: the panel/coordinator decides when
   * (and whether) to activate local-password, and the detail
   * says so.
   */
  setPassword(username: string, password: string): { ok: boolean; detail: string } {
    const name = typeof username === "string" ? username.trim() : "";
    if (name.length < 1 || name.length > 64) {
      return { ok: false, detail: "A username needs to be between 1 and 64 characters. Nothing was saved." };
    }
    if (typeof password !== "string" || password.length < 8) {
      return { ok: false, detail: "A password needs to be at least 8 characters. Nothing was saved." };
    }
    const salt = randomBytes(16);
    const stored: StoredCredentials = {
      username: name,
      salt: salt.toString("hex"),
      hash: hashPassword(password, salt).toString("hex"),
      updatedAt: Date.now(),
    };
    writeFileSync(this.credentialsPath(), JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
    const active = this.identity().provider;
    return {
      ok: true,
      detail: `Local password saved for ${name}. Setting a password does not by itself switch the active provider — GUS is still using "${active}" until you switch it.`,
    };
  }

  /**
   * Verify a username/password against the stored credential:
   * recompute the scrypt digest and compare timing-safe over
   * the fixed-length digests. False on absence, malformation,
   * a wrong username, or a wrong password — all read the same.
   */
  verifyPassword(username: string, password: string): boolean {
    try {
      const stored = this.loadCredentials();
      if (!stored) return false;
      if (typeof username !== "string" || username.trim() !== stored.username) return false;
      if (typeof password !== "string" || !password) return false;
      const expected = Buffer.from(stored.hash, "hex");
      if (expected.length !== 64) return false;
      const actual = hashPassword(password, Buffer.from(stored.salt, "hex"));
      if (actual.length !== expected.length) return false;
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  /**
   * Remove the local password credential. If the active
   * provider was local-password it falls back to "local" —
   * an install must never be left pointing at a provider that
   * can no longer authenticate anyone.
   */
  clearPassword(): { ok: boolean; detail: string } {
    try {
      rmSync(this.credentialsPath(), { force: true });
    } catch {
      /* already gone is the goal state either way */
    }
    const record = this.loadIdentity();
    if (record && record.provider === "local-password") {
      record.provider = "local";
      this.saveIdentity(record);
      return {
        ok: true,
        detail: "Local password removed. The active provider was local username/password, so it has fallen back to no-login local.",
      };
    }
    return { ok: true, detail: "Local password removed." };
  }

  /**
   * v0.14.5: mark the first-run login screen as seen. Sets
   * `welcomedAt` on the identity record the first time only —
   * later calls are no-ops that report the original time, so
   * the marker stays the moment of the first welcome.
   */
  markWelcomed(): IdentityRecord {
    const record = this.identity();
    if (typeof record.welcomedAt !== "number") {
      record.welcomedAt = Date.now();
      this.saveIdentity(record);
    }
    return record;
  }

  /**
   * v0.14.5: the live session, if one is on file AND still
   * belongs to the active provider. A session minted under a
   * different provider (the operator switched since signing
   * in) reads as signed out — the gate shows again rather
   * than letting an old posture's session skip it.
   */
  currentSession(): IdentitySession | null {
    const stored = this.loadSession();
    if (!stored) return null;
    if (stored.provider !== this.identity().provider) return null;
    return { provider: stored.provider, createdAt: stored.createdAt };
  }

  /** v0.14.5: everything the launch gate needs, in one read:
   *  whether the first-run screen is still owed, the active
   *  provider, and the live session (if any). v0.14.6 adds the
   *  launch-gate posture, resolved (absent = enabled). */
  sessionStatus(): { welcomedAt?: number; provider: IdentityProviderKind; session: IdentitySession | null; launchGateEnabled: boolean } {
    const record = this.identity();
    return {
      ...(typeof record.welcomedAt === "number" ? { welcomedAt: record.welcomedAt } : {}),
      provider: record.provider,
      session: this.currentSession(),
      launchGateEnabled: record.launchGateEnabled !== false,
    };
  }

  /** v0.14.6: set the auto-login posture (the Protection
   *  home's launch-gate toggle). Operator-only through the
   *  panel route; the credential itself is never touched. */
  setLaunchGateEnabled(enabled: boolean): IdentityRecord {
    const record = this.identity();
    record.launchGateEnabled = enabled;
    this.saveIdentity(record);
    return record;
  }

  /**
   * v0.14.5: sign in through the ACTIVE provider. On success
   * a fresh session is minted (replacing any previous one)
   * and returned as a readout — the token stays in
   * session.json. On failure nothing is written and the
   * provider's own plain-language detail is the answer.
   */
  signIn(cred: { username?: string; password?: string }): { ok: boolean; detail: string; session?: IdentitySession } {
    const record = this.identity();
    const result = this.provider(record.provider).authenticate(cred);
    if (!result.ok) return { ok: false, detail: result.detail };
    const stored = {
      token: randomBytes(32).toString("hex"),
      provider: record.provider,
      createdAt: Date.now(),
    };
    writeFileSync(this.sessionPath(), JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
    return {
      ok: true,
      detail:
        record.provider === "local"
          ? "Signed in — this Mac is the lock, and GUS will open straight in from now on."
          : "Signed in — GUS will open straight in until you sign out.",
      session: { provider: stored.provider, createdAt: stored.createdAt },
    };
  }

  /** v0.14.5: sign out — the session file goes away and the
   *  next launch shows the login screen again (under a
   *  local-password provider; under no-login local there is
   *  nothing to gate, and the panel hides the action). */
  signOut(): { ok: boolean; detail: string } {
    const had = this.loadSession() !== null;
    this.clearSession();
    return {
      ok: true,
      detail: had
        ? "Signed out. The login screen will show at the next launch."
        : "Signed out — no session was on file.",
    };
  }

  private clearSession(): void {
    try {
      rmSync(this.sessionPath(), { force: true });
    } catch {
      /* already gone is the goal state either way */
    }
  }
}
