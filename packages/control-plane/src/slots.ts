/**
 * Install slots + the version pointer (foundation spec §1.1) — Phase 3.
 *
 * The install layout (on the install volume shared by both containers):
 *
 *   <install>/
 *     current.json      the pointer (this module owns its shape)
 *     slots/A/          a full packed bundle (control-plane/, runtime/,
 *     slots/B/          node_modules/, VERSION) — one per slot
 *     staging/<id>/     the Updater's work area for an in-flight update
 *
 * A/B discipline: an update is staged into the slot that is NOT live,
 * verified there, and activated by flipping the pointer — a single
 * atomic rename. The running slot is never mutated. Rollback is the
 * same flip in the other direction, which is why it takes seconds and
 * works even when the new version cannot start at all: nothing about
 * the old slot was ever touched.
 *
 * Who writes the pointer:
 *   - the Updater, at promotion (confirmPending: true) and when it
 *     finalizes or self-rolls-back (confirmPending: false);
 *   - the slot LAUNCHER's watchdog (packages/sandbox/launcher.mjs),
 *     only in one case: a control plane started into a confirm-pending
 *     slot died before finalizing — the launcher flips back to
 *     `previous` so the known-good control plane boots and finalizes
 *     the update as rolled back. The launcher re-implements this
 *     file's read/flip in miniature (it must run before any slot code
 *     exists); the shape here is the canonical one.
 *
 * State discipline (the Phase 3 rule, stated once, here):
 *   - CODE rolls back: slots + pointer.
 *   - CONFIG rolls back: governor.json / policy.json / egress-policy.json
 *     are snapshotted before promotion and restored on rollback (a bad
 *     release must not be able to leave migrated/loosened config behind).
 *   - DATA never rolls back: ledger.jsonl, jobs.jsonl, approvals.jsonl,
 *     receipts*.jsonl, egress*.jsonl and the vault store are append-only
 *     or operator-owned; an update may append to them, never truncate,
 *     rewrite, or restore them. The kill flag is operator intent and is
 *     likewise never rolled back. snapshotStores() records sizes/hashes
 *     so a drill (or an operator) can prove the prefix property held.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface SlotRef {
  slot: string;
  version: string;
}

export interface SlotPointer {
  /** The live slot. */
  slot: string;
  /** The live version. */
  version: string;
  /** Where to roll back to; null when no update is in flight. */
  previous: SlotRef | null;
  /**
   * True between the promotion flip and the new control plane's
   * finalization: the new version is live but NOT yet confirmed. If
   * the new control plane dies in this window, the launcher watchdog
   * flips back to `previous`.
   */
  confirmPending: boolean;
  updatedAt: number;
  /** Set by whoever flipped last ("updater" | "watchdog" | "launcher-seed"). */
  note?: string;
}

export function pointerPath(installDir: string): string {
  return join(installDir, "current.json");
}

export function slotDir(installDir: string, slot: string): string {
  return join(installDir, "slots", slot);
}

export function otherSlot(slot: string): string {
  return slot === "A" ? "B" : "A";
}

export function readPointer(installDir: string): SlotPointer | null {
  try {
    const raw = readFileSync(pointerPath(installDir), "utf8");
    const p = JSON.parse(raw) as SlotPointer;
    if (typeof p.slot !== "string" || typeof p.version !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

/** Atomic pointer write: tmp file in the same directory + rename, so a
 *  reader (a launcher polling every 250 ms) never sees a torn file. */
export function writePointer(installDir: string, ptr: SlotPointer): void {
  mkdirSync(installDir, { recursive: true });
  const tmp = join(installDir, `.current.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(ptr, null, 2) + "\n");
  renameSync(tmp, pointerPath(installDir));
}

/** The version a slot's bundle declares (its VERSION file, written by
 *  scripts/pack.mjs from @gus/shared's GUS_VERSION). Null if absent. */
export function slotVersion(installDir: string, slot: string): string | null {
  try {
    const v = readFileSync(join(slotDir(installDir, slot), "VERSION"), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- config snapshots

/** Operator config files an update may affect and a rollback restores.
 *  Deliberately NOT here: KILLED (operator intent), and every data
 *  store (append-only — see the module header). */
export const CONFIG_FILES = ["governor.json", "policy.json", "egress-policy.json"] as const;

export function snapshotConfig(stateDir: string, snapshotDir: string): string[] {
  mkdirSync(snapshotDir, { recursive: true });
  const copied: string[] = [];
  for (const f of CONFIG_FILES) {
    const src = join(stateDir, f);
    if (existsSync(src)) {
      copyFileSync(src, join(snapshotDir, f));
      copied.push(f);
    }
  }
  // Presence is part of the snapshot: a file absent at snapshot time
  // must be absent after a rollback (a bad release may have created
  // one). The marker records exactly which files existed.
  writeFileSync(join(snapshotDir, "MANIFEST.json"), JSON.stringify({ files: copied }, null, 2) + "\n");
  return copied;
}

export function restoreConfig(stateDir: string, snapshotDir: string): void {
  const marker = join(snapshotDir, "MANIFEST.json");
  if (!existsSync(marker)) return;
  const { files } = JSON.parse(readFileSync(marker, "utf8")) as { files: string[] };
  for (const f of CONFIG_FILES) {
    const dest = join(stateDir, f);
    if (files.includes(f)) {
      copyFileSync(join(snapshotDir, f), dest);
    } else if (existsSync(dest)) {
      // Did not exist at snapshot time: a rollback removes what the
      // rolled-back window created — the file's absence IS the
      // restored state.
      unlinkSync(dest);
    }
  }
}

// ---------------------------------------------------------- store integrity

/** Append-only / operator-owned data stores whose integrity an update
 *  must preserve. Recorded before and after an update; `prefixIntact`
 *  is the proof an update appended at most, and lost nothing. */
export const APPEND_ONLY_STORES = [
  "ledger.jsonl",
  "jobs.jsonl",
  "approvals.jsonl",
  "receipts.jsonl",
  "egress.jsonl",
  "egress-receipts.jsonl",
  "vault.json",
] as const;

export interface StoreStat {
  file: string;
  exists: boolean;
  bytes: number;
  /** sha256 of the file's full content at record time. Combined with
   *  the post-update length, the prefix check is: the first `bytes`
   *  bytes of the later file hash to this value. */
  sha256?: string;
}

export function snapshotStores(stateDir: string): StoreStat[] {
  return APPEND_ONLY_STORES.map((file) => {
    const p = join(stateDir, file);
    if (!existsSync(p)) return { file, exists: false, bytes: 0 };
    const data = readFileSync(p);
    return {
      file,
      exists: true,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  });
}

/** True iff every store that existed at snapshot time still begins
 *  with exactly its snapshot bytes (appends allowed, loss impossible),
 *  and no store that existed has vanished. */
export function storesPrefixIntact(stateDir: string, before: StoreStat[]): boolean {
  for (const s of before) {
    if (!s.exists) continue;
    const p = join(stateDir, s.file);
    if (!existsSync(p)) return false;
    const data = readFileSync(p);
    if (data.length < s.bytes) return false;
    const prefix = data.subarray(0, s.bytes);
    if (createHash("sha256").update(prefix).digest("hex") !== s.sha256) return false;
  }
  return true;
}

/** Directory that holds one update's snapshot + record-keeping. */
export function snapshotDirFor(stateDir: string, updateId: string): string {
  return join(stateDir, "snapshots", updateId);
}

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

export function fileSize(p: string): number {
  return existsSync(p) ? statSync(p).size : 0;
}
