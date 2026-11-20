/**
 * Incremental cache for append-only JSONL logs (v0.14.0, R2
 * performance work).
 *
 * Why this exists: the operator poll (the desktop app asks ~9
 * panel endpoints every 2.5 s) used to re-read and re-parse
 * ENTIRE append-only logs on every call — the Governor's ledger
 * three times over for one spend summary, gate.jsonl +
 * events.jsonl in full for a 60-line timeline. On a well-used
 * install those files are megabytes; the parse alone burned
 * ~265 ms of CPU per poll on a fast VM and several times that
 * on the 2014 iMac the app targets, so the control plane spent
 * a core just answering polls. That was the "ridiculously
 * slow."
 *
 * The discipline that makes the cache safe is the one the state
 * files already live under (slots.ts): these logs are
 * APPEND-ONLY — writers only ever append complete lines, and
 * nothing truncates, rewrites, or restores them. So a reader
 * never needs to re-parse bytes it has already consumed: stat
 * the file, and when it grew, read and parse only the appended
 * tail. The steady-state poll cost becomes one statSync per
 * file plus whatever derivation the caller does over the
 * (already parsed) entries.
 *
 * Contract:
 *  - `read(path, mapLine)` returns every mapped entry in file
 *    order. `mapLine` receives the JSON-parsed line and returns
 *    the caller's entry, or `undefined` to skip the line (a
 *    record for another conversation, a gate line without the
 *    field the caller derives from, …). Lines that are not
 *    valid JSON are skipped, matching the torn-line tolerance
 *    every reader of these logs already had.
 *  - A torn final line (bytes after the last newline — a crash
 *    mid-append) is HELD, never parsed: the consumed offset
 *    stops at the last complete newline, and the tail is parsed
 *    on a later call once its newline lands.
 *  - The returned array is the cache's own: callers MUST NOT
 *    mutate it (no in-place sort, push, or splice). Copy first
 *    (`[...entries]`) wherever a caller sorts or edits — the
 *    consumers that sort build their merged copy anyway.
 *  - One cache instance must be read with ONE mapLine per path:
 *    the mapping runs once per line, at append time, so two
 *    different derivations of the same file need two cache
 *    instances (watch.ts keeps exactly that: one per log).
 *
 * Reset rules (a replaced or rewritten file must never be read
 * as its predecessor's tail): the cache tracks, per path, the
 * consumed byte offset, the file's size + mtimeMs + inode, and
 * a hash of the last consumed line. A read resets to a full
 * re-read when the file shrank below the consumed offset, the
 * inode changed (a rename-replacement), mtime moved backwards,
 * the size is unchanged-but-mtime-changed at the consumed
 * offset (a same-length rewrite), or the last consumed line's
 * bytes no longer hash to what was consumed (an in-place
 * rewrite that grew). A missing file reads as empty and drops
 * its state, so a file created later is read from byte zero.
 * These are heuristics layered on the append-only contract,
 * not a general file-sync: a rewrite that preserves size,
 * inode, mtime, AND the last line's bytes while altering
 * earlier lines would slip past — and cannot occur under the
 * append-only discipline, which is the premise of the cache.
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

interface FileState<T> {
  /** Bytes consumed — always just past a newline. */
  offset: number;
  size: number;
  mtimeMs: number;
  ino: number;
  entries: T[];
  /** Byte offset where the last consumed line starts, and the
   *  sha256 of its bytes (newline excluded) — the rewrite
   *  tripwire described in the header. -1 / "" when no line has
   *  been consumed yet. */
  lastLineStart: number;
  lastLineHash: string;
  /** Bumps whenever the entries change (growth or reset), so a
   *  consumer memoizing a derivation over the entries can key
   *  on it instead of re-deriving per call. */
  revision: number;
}

const EMPTY: readonly never[] = Object.freeze([]);

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export class JsonlLogCache<T> {
  private files = new Map<string, FileState<T>>();

  /** The current revision for a path (0 when never read). */
  revision(path: string): number {
    return this.files.get(path)?.revision ?? 0;
  }

  /** Drop cached state (one path, or all). The next read is a
   *  full re-read. Exists for tests and for any future caller
   *  that learns a file was replaced out-of-band. */
  clear(path?: string): void {
    if (path === undefined) this.files.clear();
    else this.files.delete(path);
  }

  read(
    path: string,
    mapLine: (raw: unknown) => T | undefined,
  ): readonly T[] {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      // Missing (or unreadable) reads as empty, exactly like the
      // existsSync-guarded readers this replaces — and the state
      // goes with it, so a later-created file starts at byte 0.
      this.files.delete(path);
      return EMPTY;
    }

    let state = this.files.get(path);
    if (!state) {
      state = {
        offset: 0,
        size: 0,
        mtimeMs: 0,
        ino: 0,
        entries: [],
        lastLineStart: -1,
        lastLineHash: "",
        revision: 0,
      };
      this.files.set(path, state);
    }

    // ---- reset checks (see header) ---------------------------
    let reset =
      state.offset > 0 &&
      (st.size < state.offset ||
        (st.ino !== 0 && state.ino !== 0 && st.ino !== state.ino) ||
        st.mtimeMs < state.mtimeMs ||
        (st.size === state.offset && st.mtimeMs !== state.mtimeMs));
    if (!reset && state.offset > 0 && st.size >= state.offset && state.lastLineStart >= 0) {
      // In-place-rewrite tripwire: the last line we consumed
      // must still be there, byte for byte. One small read —
      // nothing next to the full parse it stands in for.
      try {
        const fd = openSync(path, "r");
        try {
          const len = state.offset - 1 - state.lastLineStart;
          if (len < 0) {
            reset = true;
          } else {
            const buf = Buffer.alloc(len);
            readSync(fd, buf, 0, len, state.lastLineStart);
            if (sha256Hex(buf) !== state.lastLineHash) reset = true;
          }
        } finally {
          closeSync(fd);
        }
      } catch {
        reset = true;
      }
    }
    if (reset) {
      state.entries = [];
      state.offset = 0;
      state.lastLineStart = -1;
      state.lastLineHash = "";
      state.revision++;
    }

    // ---- delta read ------------------------------------------
    if (st.size > state.offset) {
      let chunk: Buffer | null = null;
      try {
        const fd = openSync(path, "r");
        try {
          // fstat the open fd: the size the delta is read
          // against is the file actually being read.
          const fst = fstatSync(fd);
          if (fst.size > state.offset) {
            chunk = Buffer.alloc(fst.size - state.offset);
            let read = 0;
            while (read < chunk.length) {
              const n = readSync(fd, chunk, read, chunk.length - read, state.offset + read);
              if (n <= 0) break;
              read += n;
            }
            if (read < chunk.length) chunk = chunk.subarray(0, read);
          }
        } finally {
          closeSync(fd);
        }
      } catch {
        chunk = null; // vanished mid-read: serve what we hold
      }
      if (chunk && chunk.length > 0) {
        const lastNl = chunk.lastIndexOf(0x0a);
        if (lastNl >= 0) {
          const base = state.offset;
          const text = chunk.subarray(0, lastNl).toString("utf8");
          let grew = false;
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            let raw: unknown;
            try {
              raw = JSON.parse(line);
            } catch {
              continue; // invalid line — skipped, as always
            }
            const mapped = mapLine(raw);
            if (mapped !== undefined) {
              state.entries.push(mapped);
              grew = true;
            }
          }
          // The rewrite tripwire follows the new last line.
          const prevNl = lastNl > 0 ? chunk.lastIndexOf(0x0a, lastNl - 1) : -1;
          state.lastLineStart = base + prevNl + 1;
          state.lastLineHash = sha256Hex(chunk.subarray(prevNl + 1, lastNl));
          state.offset = base + lastNl + 1;
          if (grew) state.revision++;
        }
        // No newline in the chunk: a torn tail, held for the
        // next call (offset deliberately unmoved).
      }
    }

    state.size = st.size;
    state.mtimeMs = st.mtimeMs;
    state.ino = st.ino;
    return state.entries;
  }
}
