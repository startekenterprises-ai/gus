/**
 * Vault Broker (foundation spec §1.3) — the control plane's secret store.
 *
 * The one rule everything else follows from: **there is no API that
 * returns a secret value.** Callers inside the control plane can:
 *   - ask which names exist (`listNames`, `has`) — names are not secret;
 *   - hand a callback to `withSecret`, which decrypts in control-plane
 *     memory and passes the value to that callback (the egress proxy's
 *     injection path) — the value never crosses a process boundary;
 *   - ask whether a text contains a stored value (`findValuesIn`) or have
 *     stored values scrubbed out of a text (`redactValues`) — detection
 *     and redaction, never disclosure.
 * Admin operations (`add`, `remove`) exist on this class but are wired
 * ONLY to the operator-side admin CLI in the control-plane process
 * (vault-admin). Nothing on the sandbox comm bridge imports this module.
 *
 * At rest: each value is encrypted with ChaCha20-Poly1305 under a 32-byte
 * host key held in a key file (0600) that lives in control-plane state —
 * outside the sandbox, which cannot see the state volume at all. The
 * store file itself is written 0600.
 *
 * Substitution note: the spec names age/XChaCha20-Poly1305. Node's
 * built-in crypto provides chacha20-poly1305 (12-byte nonce form) with
 * no external dependency; that is what is used here. The security
 * property the spec depends on — authenticated encryption under an
 * operator-held key file, ciphertext-only at rest — is identical.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

/** Secret names are handles, not secrets: lowercase slug, max 64 chars. */
export const SECRET_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Marker that replaces a stored secret value in any text that is about
 *  to cross toward the sandbox or a log. Names the handle, never the value. */
export function vaultRedactionMarker(name: string): string {
  return `[vault secret withheld: ${name}]`;
}

interface VaultEntry {
  /** base64 nonce (12 bytes) */
  n: string;
  /** base64 ciphertext */
  c: string;
  /** base64 Poly1305 auth tag (16 bytes) */
  t: string;
  createdAt: number;
}

interface VaultFile {
  version: 1;
  entries: Record<string, VaultEntry>;
}

export class VaultBroker {
  /**
   * @param storePath ciphertext store (JSON), created 0600 on first add
   * @param keyPath   host key file (32 raw bytes), created 0600 if absent
   */
  constructor(
    private storePath: string,
    private keyPath: string,
  ) {}

  // ---- key + store plumbing (control-plane local only) ----

  private key(): Buffer {
    if (existsSync(this.keyPath)) {
      const k = readFileSync(this.keyPath);
      if (k.length !== 32) {
        throw new Error(`vault key file ${this.keyPath} is ${k.length} bytes, expected 32`);
      }
      return k;
    }
    const k = randomBytes(32);
    writeFileSync(this.keyPath, k, { mode: 0o600 });
    chmodSync(this.keyPath, 0o600);
    return k;
  }

  private load(): VaultFile {
    if (!existsSync(this.storePath)) return { version: 1, entries: {} };
    const parsed = JSON.parse(readFileSync(this.storePath, "utf8")) as VaultFile;
    if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
      throw new Error(`vault store ${this.storePath} has an unrecognized shape`);
    }
    return parsed;
  }

  private save(file: VaultFile): void {
    writeFileSync(this.storePath, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    chmodSync(this.storePath, 0o600);
  }

  private encrypt(value: string): VaultEntry {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("chacha20-poly1305", this.key(), nonce, {
      authTagLength: 16,
    });
    const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      n: nonce.toString("base64"),
      c: ct.toString("base64"),
      t: cipher.getAuthTag().toString("base64"),
      createdAt: Date.now(),
    };
  }

  private decrypt(entry: VaultEntry): string {
    const decipher = createDecipheriv(
      "chacha20-poly1305",
      this.key(),
      Buffer.from(entry.n, "base64"),
      { authTagLength: 16 },
    );
    decipher.setAuthTag(Buffer.from(entry.t, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(entry.c, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  // ---- name-only surface (safe anywhere in the control plane) ----

  listNames(): string[] {
    return Object.keys(this.load().entries).sort();
  }

  has(name: string): boolean {
    return name in this.load().entries;
  }

  // ---- admin surface (operator CLI only — never comm, never sandbox) ----

  add(name: string, value: string): void {
    if (!SECRET_NAME_RE.test(name)) {
      throw new Error(`invalid secret name "${name}" (want ${SECRET_NAME_RE})`);
    }
    if (value.length < 8) {
      throw new Error("secret value too short (minimum 8 characters)");
    }
    const file = this.load();
    file.entries[name] = this.encrypt(value);
    this.save(file);
  }

  remove(name: string): boolean {
    const file = this.load();
    if (!(name in file.entries)) return false;
    delete file.entries[name];
    this.save(file);
    return true;
  }

  // ---- use surface (control-plane memory only) ----

  /**
   * The ONLY way a secret value is ever used: decrypted here, handed to
   * a control-plane callback (egress injection), never returned across
   * any boundary the sandbox can reach. Returns undefined when the name
   * is unknown. A tampered entry throws (auth-tag failure) — callers
   * treat that as a hard error, never as an empty secret.
   */
  withSecret<T>(name: string, fn: (value: string) => T): T | undefined {
    const entry = this.load().entries[name];
    if (!entry) return undefined;
    return fn(this.decrypt(entry));
  }

  /** Names of stored secrets whose VALUES appear in `text`. Detection
   *  only — used by the egress proxy to refuse outbound smuggling and to
   *  scrub responses before they can reach the sandbox. */
  findValuesIn(text: string): string[] {
    if (!text) return [];
    const found: string[] = [];
    for (const name of this.listNames()) {
      const hit = this.withSecret(name, (v) => v.length > 0 && text.includes(v));
      if (hit) found.push(name);
    }
    return found;
  }

  /** Replace every stored secret value in `text` with its marker.
   *  Returns the scrubbed text and the names that were scrubbed. */
  redactValues(text: string): { text: string; names: string[] } {
    let out = text;
    const names: string[] = [];
    for (const name of this.listNames()) {
      const scrubbed = this.withSecret(name, (v) =>
        v.length > 0 && out.includes(v)
          ? out.split(v).join(vaultRedactionMarker(name))
          : null,
      );
      if (scrubbed != null) {
        out = scrubbed;
        names.push(name);
      }
    }
    return { text: out, names };
  }
}
