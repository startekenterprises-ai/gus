#!/usr/bin/env node
/**
 * Slot launcher — the fixed, NON-versioned supervisor in each GUS
 * image (foundation spec §1.1, Phase 3). It is deliberately tiny,
 * dependency-free, and not part of any release bundle: it is the
 * bootloader the A/B update mechanism stands on.
 *
 *   node launcher.mjs control   (control-plane container)
 *   node launcher.mjs sandbox   (agent-sandbox container)
 *
 * What it does:
 *   - Seeds the install volume on first boot: copies the image's
 *     bundled slot(s) into <install>/slots/ and writes the initial
 *     pointer. After that, the install volume is the truth.
 *   - Follows the pointer (<install>/current.json): starts the named
 *     slot's entrypoint as a child process; when the pointer flips,
 *     the child is replaced with the new slot's. This is how an
 *     update promotes, and how a rollback restores — the launcher
 *     neither knows nor cares which; it follows the pointer.
 *   - CONTROL ROLE ONLY — the watchdog: a control plane started into
 *     a confirm-pending slot (freshly promoted, not yet confirmed)
 *     must finalize the update (clearing confirmPending) or die
 *     trying. If it exits while the pointer is still confirm-pending
 *     for its slot, or fails to finalize within the confirm window,
 *     the launcher flips the pointer back to `previous` and boots
 *     that instead — the known-good control plane then finalizes the
 *     update as rolled back (updater.ts bootReconcile). A promoted
 *     control plane that cannot run can therefore never leave the
 *     install stranded on itself.
 *   - SANDBOX ROLE ONLY — the canary child: the control plane's
 *     updater writes <comm>/canary-boot.json directives; the launcher
 *     runs a second runtime from the named slot, on the canary
 *     socket, in a scratch workspace, for exactly as long as the
 *     directive says. The live child follows the pointer as above.
 *
 * The pointer file's shape is canonically defined in
 * packages/control-plane/src/slots.ts; this file re-implements its
 * read/flip in miniature because the launcher must run before any
 * slot's code can be trusted to exist.
 *
 * Env: GUS_INSTALL_DIR (default /install), GUS_IMAGE_SLOTS (default
 * /app/slots), GUS_COMM_DIR (default /comm), GUS_WORKSPACE (sandbox
 * live workspace, default /workspace), GUS_CANARY_WORKSPACE (default
 * /tmp/gus-canary-ws), GUS_CONFIRM_WINDOW_MS (default 90000).
 */
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const role = process.argv[2];
if (role !== "control" && role !== "sandbox") {
  console.error("usage: node launcher.mjs <control|sandbox>");
  process.exit(2);
}

const INSTALL = process.env.GUS_INSTALL_DIR ?? "/install";
const IMAGE_SLOTS = process.env.GUS_IMAGE_SLOTS ?? "/app/slots";
const COMM = process.env.GUS_COMM_DIR ?? "/comm";
const CONFIRM_WINDOW_MS = Number(process.env.GUS_CONFIRM_WINDOW_MS ?? 90_000);
const POINTER = join(INSTALL, "current.json");

const log = (...a) => console.log(`[launcher:${role}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPointer() {
  try {
    const p = JSON.parse(readFileSync(POINTER, "utf8"));
    if (typeof p.slot === "string" && typeof p.version === "string") return p;
  } catch {
    /* absent or torn — callers tolerate null */
  }
  return null;
}

function writePointer(ptr) {
  mkdirSync(INSTALL, { recursive: true });
  const tmp = join(INSTALL, `.current.json.tmp-launcher-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(ptr, null, 2) + "\n");
  renameSync(tmp, POINTER);
}

function seedIfNeeded() {
  if (readPointer()) return;
  if (!existsSync(IMAGE_SLOTS)) {
    log(`no pointer and no image slots at ${IMAGE_SLOTS} — nothing to run`);
    return;
  }
  const slots = readdirSync(IMAGE_SLOTS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (slots.length === 0) return;
  for (const s of slots) {
    const dest = join(INSTALL, "slots", s);
    if (!existsSync(dest)) {
      mkdirSync(join(INSTALL, "slots"), { recursive: true });
      cpSync(join(IMAGE_SLOTS, s), dest, { recursive: true });
    }
  }
  const first = slots.includes("A") ? "A" : slots[0];
  let version = "unknown";
  try {
    version = readFileSync(join(INSTALL, "slots", first, "VERSION"), "utf8").trim() || version;
  } catch {
    /* VERSION is written by pack.mjs; absence is survivable here */
  }
  writePointer({ slot: first, version, previous: null, confirmPending: false, updatedAt: Date.now(), note: "launcher-seed" });
  log(`seeded install: slot ${first} (v${version}) is live`);
}

// ------------------------------------------------------------ children

let shuttingDown = false;
const children = new Map(); // key -> { proc, slot, startedAt, key }
let lastAnyExitAt = 0;

function startChild(key, slot, entryRel, extraEnv) {
  const entry = join(INSTALL, "slots", slot, entryRel);
  if (!existsSync(entry)) {
    log(`cannot start ${key}: slot ${slot} has no ${entryRel}`);
    return null;
  }
  const proc = spawn(process.execPath, [entry], {
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  const rec = { proc, slot, startedAt: Date.now(), key };
  children.set(key, rec);
  log(`started ${key}: slot ${slot} (${entryRel}) pid ${proc.pid}`);
  proc.on("exit", (code, signal) => {
    if (children.get(key) === rec) children.delete(key);
    lastAnyExitAt = Date.now();
    log(`${key} (slot ${slot}) exited code=${code} signal=${signal}`);
    if (key === "control") onControlExit(rec);
  });
  return rec;
}

function killChild(key) {
  const rec = children.get(key);
  if (!rec) return;
  children.delete(key);
  try {
    rec.proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

/** Watchdog flip-back: only ever invoked for a child that died while
 *  ITS slot was still the confirm-pending promotion target. */
function flipBack(ptr, why) {
  const prev = ptr.previous;
  if (!prev) return false;
  writePointer({
    slot: prev.slot,
    version: prev.version,
    previous: null,
    confirmPending: false,
    updatedAt: Date.now(),
    note: "watchdog",
  });
  log(`WATCHDOG: ${why} — pointer flipped back to slot ${prev.slot} (v${prev.version})`);
  return true;
}

function onControlExit(rec) {
  if (shuttingDown) return;
  const ptr = readPointer();
  if (!ptr) return;
  // The promotion case: the child that died was the freshly promoted,
  // not-yet-confirmed control plane. Roll the pointer back; the main
  // loop boots the previous slot, whose control plane finalizes the
  // update as rolled back.
  if (ptr.confirmPending && ptr.slot === rec.slot && ptr.previous) {
    flipBack(ptr, `control plane for slot ${rec.slot} exited before confirming its promotion`);
  }
}

// ------------------------------------------------------------ control role

async function runControl() {
  seedIfNeeded();
  let rapidExits = 0;
  for (;;) {
    if (shuttingDown) return;
    const ptr = readPointer();
    const cur = children.get("control");
    if (ptr) {
      if (cur && cur.slot !== ptr.slot) {
        killChild("control");
      } else if (!cur) {
        // Crash backoff: a slot that keeps dying instantly must not
        // hot-loop the log (or the CPU).
        if (Date.now() - lastExitAt() < 2_000) rapidExits++;
        else rapidExits = 0;
        if (rapidExits >= 3) {
          log("control child is crash-looping; backing off 5s");
          await sleep(5_000);
          rapidExits = 0;
        }
        const rec = startChild("control", ptr.slot, "control-plane/main.js", {});
        if (!rec) await sleep(1_000);
      } else if (ptr.confirmPending && ptr.slot === cur.slot && ptr.previous) {
        // Hang guard: promoted but never finalized within the window.
        if (Date.now() - cur.startedAt > CONFIRM_WINDOW_MS) {
          log(`WATCHDOG: slot ${cur.slot} did not confirm within ${CONFIRM_WINDOW_MS}ms — killing it`);
          killChild("control"); // exit path (onControlExit) flips back
        }
      }
    }
    await sleep(250);
  }
}

function lastExitAt() {
  return lastAnyExitAt;
}

// ------------------------------------------------------------ sandbox role

function readDirective() {
  try {
    return JSON.parse(readFileSync(join(COMM, "canary-boot.json"), "utf8"));
  } catch {
    return null;
  }
}

async function runSandbox() {
  seedIfNeeded();
  const liveWs = process.env.GUS_WORKSPACE ?? "/workspace";
  const canaryWs = process.env.GUS_CANARY_WORKSPACE ?? "/tmp/gus-canary-ws";
  let lastSeq = null;
  for (;;) {
    if (shuttingDown) return;
    const ptr = readPointer();
    const live = children.get("live");
    if (ptr) {
      if (live && live.slot !== ptr.slot) killChild("live");
      else if (!live) {
        startChild("live", ptr.slot, "runtime/main.js", {
          GUS_COMM_SOCKET: join(COMM, "gus.sock"),
          GUS_WORKSPACE: liveWs,
        });
      }
    }
    const dir = readDirective();
    if (dir && dir.seq !== lastSeq) {
      lastSeq = dir.seq;
      // The supervisor must never die on canary plumbing: if the
      // scratch workspace cannot be prepared, log it and skip the
      // canary (the control plane's health check will fail the
      // candidate safely) — the LIVE runtime's supervision is the
      // job that matters and it continues either way. (Found by the
      // Phase 3 drill: an unwritable canary tmpdir killed the whole
      // sandbox container.)
      try {
        if (dir.action === "start" && typeof dir.slot === "string") {
          killChild("canary");
          rmSync(canaryWs, { recursive: true, force: true });
          mkdirSync(canaryWs, { recursive: true });
          startChild("canary", dir.slot, "runtime/main.js", {
            GUS_COMM_SOCKET: join(COMM, "gus-canary.sock"),
            GUS_WORKSPACE: canaryWs,
          });
        } else if (dir.action === "stop") {
          killChild("canary");
        }
      } catch (e) {
        log(`canary directive ${dir.action} could not be carried out: ${e instanceof Error ? e.message : String(e)} — live runtime unaffected`);
      }
    }
    await sleep(250);
  }
}

// ------------------------------------------------------------ main

process.on("SIGTERM", () => {
  shuttingDown = true;
  for (const key of [...children.keys()]) killChild(key);
  setTimeout(() => process.exit(0), 300);
});
process.on("SIGINT", () => {
  shuttingDown = true;
  for (const key of [...children.keys()]) killChild(key);
  setTimeout(() => process.exit(0), 300);
});

log(`up: install=${INSTALL} imageSlots=${IMAGE_SLOTS} comm=${COMM}`);
if (role === "control") await runControl();
else await runSandbox();
