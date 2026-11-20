#!/usr/bin/env bash
# GUS Phase 5 drill — the Job Runner boot sweep (spec §1.5, must-have 5).
#
# A job left queued/running by a control-plane incarnation that died
# must not hang silently: on the next boot it settles failed-loudly,
# with a receipt, and the operator is told. Parked (needs-approval)
# jobs are NOT swept — approvals are durable state that survives
# restarts by design (Phase 2).
#
# Sequence: seed a parked job into the store, start the control plane,
# send a chat message (its job goes to "running" and, with no runtime
# attached, can never finish), SIGKILL the control plane, start it
# again over the same state, and assert the sweep's work from the
# durable record.
#
# Vehicle note: this drill runs the control plane as a host process,
# not in podman. What is under test is state handling across a crash,
# not sandbox isolation (Phases 0–4 drills prove that in containers);
# the fake-file channel is the production adapter path either way.
set -u
cd "$(dirname "$0")/../.."
DRILL="${DRILL_DIR:-$PWD/drill/boot-sweep}"
EVIDENCE="$DRILL/evidence.log"
STATE="$DRILL/state"
FAILS=0
rm -rf "$DRILL"
mkdir -p "$STATE" "$DRILL/comm" "$DRILL/run"
: > "$EVIDENCE"
touch "$DRILL/run/inbound.ndjson" "$DRILL/run/outbound.ndjson"

say() { echo "$@" | tee -a "$EVIDENCE"; }
pass() { say "PASS  $1"; }
fail() { say "FAIL  $1"; FAILS=$((FAILS+1)); }
check() { local name="$1"; shift; if "$@" >>"$EVIDENCE" 2>&1; then pass "$name"; else fail "$name"; fi; }

say "=== GUS Phase 5 boot-sweep drill — $(date -u +%FT%TZ) ==="

npm run build >>"$EVIDENCE" 2>&1 || { fail "build"; say "drill complete: $FAILS failure(s)"; exit 1; }

PANEL_PORT=$((18700 + RANDOM % 200))
export GUS_STATE_DIR="$STATE"
export GUS_COMM_SOCKET="$DRILL/comm/gus.sock"
export GUS_CHANNEL=fake-file
export GUS_FAKE_INBOUND="$DRILL/run/inbound.ndjson"
export GUS_FAKE_OUTBOUND="$DRILL/run/outbound.ndjson"
export GUS_PANEL_PORT="$PANEL_PORT"
export GUS_INSTALL_DIR="$DRILL/install"

# Seed a parked job BEFORE the first boot: needs-approval must survive
# BOTH incarnations untouched (approvals outlive restarts by design).
node -e '
  const fs = require("node:fs");
  const rec = { id: "job_parked_seed", kind: "workspace-file", state: "needs-approval",
    inputHash: "a".repeat(64), conversationId: "4242", createdAt: Date.now(),
    updatedAt: Date.now(), costUsd: 0, tokensIn: 0, tokensOut: 0 };
  fs.appendFileSync(process.argv[1], JSON.stringify(rec) + "\n");
' "$STATE/jobs.jsonl"

CP_PID=""
start_cp() {
  node packages/control-plane/dist/main.js >"$DRILL/cp-$1.log" 2>&1 &
  CP_PID=$!
  for i in $(seq 1 50); do
    grep -q "control plane up" "$DRILL/cp-$1.log" 2>/dev/null && return 0
    kill -0 "$CP_PID" 2>/dev/null || return 1
    sleep 0.2
  done
  return 1
}
cleanup() { [ -n "$CP_PID" ] && kill -9 "$CP_PID" 2>/dev/null; }
trap cleanup EXIT

check "first incarnation boots" start_cp 1

# A chat message: its job transitions to running and — with no runtime
# attached — can never settle. That is the orphan the sweep exists for.
node -e '
  const fs = require("node:fs");
  const upd = { update_id: 1, message: { message_id: 1, date: 1730000000,
    text: "hello gus, are you there", chat: { id: 4242 }, from: { id: 4242 } } };
  fs.appendFileSync(process.argv[1], JSON.stringify(upd) + "\n");
' "$DRILL/run/inbound.ndjson"

wait_for() { # wait_for <seconds> <node-predicate-file>
  local deadline=$((SECONDS + $1))
  while [ $SECONDS -lt $deadline ]; do
    node -e "$2" "$STATE/jobs.jsonl" 2>/dev/null && return 0
    sleep 0.3
  done
  return 1
}
RUNNING_PRED='
  const fs = require("node:fs");
  const last = {};
  for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
    if (!l) continue; const r = JSON.parse(l); last[r.id] = r;
  }
  process.exit(Object.values(last).some((r) => r.kind === "chat" && r.state === "running") ? 0 : 1);
'
check "chat job is running (orphan-to-be) before the crash" wait_for 20 "$RUNNING_PRED"

# The crash: SIGKILL, no graceful shutdown, no settlement.
kill -9 "$CP_PID"; wait "$CP_PID" 2>/dev/null; CP_PID=""
say "control plane killed with SIGKILL (simulated crash)"

check "second incarnation boots over the same state" start_cp 2

SWEPT_PRED='
  const fs = require("node:fs");
  const last = {};
  for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
    if (!l) continue; const r = JSON.parse(l); last[r.id] = r;
  }
  const chat = Object.values(last).find((r) => r.kind === "chat");
  if (!chat || chat.state !== "failed-loudly") process.exit(1);
  if (!/boot sweep/.test(chat.outcomeNote ?? "")) process.exit(1);
  if (!chat.receiptId) process.exit(1);
  const receipts = fs.readFileSync(process.argv[1].replace("jobs.jsonl", "receipts.jsonl"), "utf8");
  if (!receipts.includes(chat.receiptId)) process.exit(1);
  process.exit(0);
'
check "orphaned chat job settled failed-loudly by the boot sweep, receipt persisted" wait_for 20 "$SWEPT_PRED"

PARKED_PRED='
  const fs = require("node:fs");
  const last = {};
  for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
    if (!l) continue; const r = JSON.parse(l); last[r.id] = r;
  }
  process.exit(last["job_parked_seed"]?.state === "needs-approval" ? 0 : 1);
'
check "parked job still needs-approval after both boots (approvals survive restarts)" node -e "$PARKED_PRED" "$STATE/jobs.jsonl"

check "operator was notified over the channel about the swept job" \
  grep -q "GUS restarted" "$DRILL/run/outbound.ndjson"
check "boot sweep left a runtime-log entry" \
  grep -q "boot sweep" "$STATE/runtime-log.jsonl"

cleanup; CP_PID=""
say "=== boot-sweep drill complete: $FAILS failure(s) ==="
exit $([ "$FAILS" -eq 0 ] && echo 0 || echo 1)
