#!/usr/bin/env bash
# GUS Phase 0 gate drill (foundation spec §2.2, Phase 0 gate).
#
# Proves, against the REAL containers:
#   1. the agent loop answers from inside the sandbox (chat job settles
#      verified-done with a receipt, via a control-plane post-condition);
#   2. a workspace write is verified by content hash read-back;
#   3. sandbox escape attempts fail (control-plane state unreachable,
#      no network out, rootfs read-only);
#   4. a destructive tool call parks in needs-approval, nothing executed;
#   5. /stop from the channel surface kills a running job (failed-loudly
#      + receipt), the kill persists, /resume restores service;
#   6. secret-guard refuses a pasted credential at ingress: warning to
#      the user, no job, and the secret string appears NOWHERE on disk
#      or in container logs;
#   7. steady-state RAM of control plane + sandbox is within the 1 GB
#      budget (spec §0 rule 4).
#
# Vehicle note: canonical artifacts are the Dockerfiles + compose file.
# This drill drives podman+crun because the dev VM used to author Phase 0
# cannot run a Docker daemon's networking (no CAP_NET_ADMIN, locked
# /proc overmounts). The OCI images, hardening flags, and topology are
# identical; on a normal host, `docker compose up` + the same message
# sequence is the drill. See docs/LOCAL-DRILL.md.
#
# Env: PODMAN (default "podman"), KEEP=1 keeps containers + drill dir.
set -u
cd "$(dirname "$0")/../.."
PODMAN=${PODMAN:-podman}
DRILL="${DRILL_DIR:-$PWD/drill/phase0}"
JOBS_FILE="$DRILL/state/jobs.jsonl"
EVIDENCE="$DRILL/evidence.log"
FAILS=0
rm -rf "$DRILL"
mkdir -p "$DRILL"/{comm,workspace,state,run}
: > "$EVIDENCE"
# The fake-transport files are written by the host harness and read by the
# unprivileged container user (and vice versa) — pre-create them open.
touch "$DRILL/run/inbound.ndjson" "$DRILL/run/outbound.ndjson"
chmod 666 "$DRILL/run/inbound.ndjson" "$DRILL/run/outbound.ndjson"

say() { echo "$@" | tee -a "$EVIDENCE"; }
pass() { say "PASS  $1"; }
fail() { say "FAIL  $1"; FAILS=$((FAILS+1)); }
check() { # check <name> <cmd...>
  local name="$1"; shift
  if "$@" >>"$EVIDENCE" 2>&1; then pass "$name"; else fail "$name"; fi
}

say "=== GUS Phase 0 gate drill — $(date -u +%FT%TZ) ==="

$PODMAN rm -f gus-control gus-sandbox >/dev/null 2>&1
$PODMAN run -d --name gus-control --userns=auto --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:size=32m \
  -v "$DRILL/state:/state:U" -v "$DRILL/comm:/comm:U" -v "$DRILL/run:/run/gus:U" \
  -e GUS_CHANNEL=fake-file \
  -e GUS_FAKE_INBOUND=/run/gus/inbound.ndjson \
  -e GUS_FAKE_OUTBOUND=/run/gus/outbound.ndjson \
  gus-control:dev >>"$EVIDENCE" 2>&1
$PODMAN run -d --name gus-sandbox --userns=auto --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:size=32m \
  -v "$DRILL/comm:/comm:U" -v "$DRILL/workspace:/workspace:U" \
  gus-agent:dev >>"$EVIDENCE" 2>&1

# Wait for the comm socket + runtime hello.
for i in $(seq 1 50); do [ -S "$DRILL/comm/gus.sock" ] && break; sleep 0.2; done
sleep 2

UPD_ID=0
send_msg() {
  UPD_ID=$((UPD_ID+1))
  python3 - "$UPD_ID" "$1" >> "$DRILL/run/inbound.ndjson" <<'PYEOF'
import json,sys,time
uid=int(sys.argv[1]); text=sys.argv[2]
print(json.dumps({"update_id":uid,"message":{"message_id":uid,"date":int(time.time()),"text":text,"chat":{"id":4242},"from":{"id":777}}}))
PYEOF
}
wait_out() { # wait_out <pattern> <seconds>
  local pat="$1" secs="$2" i
  for i in $(seq 1 $((secs*5))); do
    grep -q "$pat" "$DRILL/run/outbound.ndjson" 2>/dev/null && return 0
    sleep 0.2
  done
  return 1
}
job_state() { # job_state <kind-or-any> -> latest state lines
  JOBS_FILE="$JOBS_FILE" python3 - "$1" <<'PYEOF'
import json,sys,os
want=sys.argv[1]; latest={}
for l in open(os.environ["JOBS_FILE"]):
    if l.strip():
        r=json.loads(l); latest[r["id"]]=r
for r in latest.values():
    if want=="any" or r["kind"]==want:
        print(r["id"], r["kind"], r["state"], r.get("receiptId",""), "|", r.get("outcomeNote","")[:90])
PYEOF
}

# --- 1. chat through the sandbox -------------------------------------------
send_msg "hello gus, what can you do?"
check "chat reply arrives from the sandbox loop" wait_out "offline stub provider" 15
say "--- jobs after chat:"; job_state any | tee -a "$EVIDENCE"
check "chat job settled verified-done with receipt" bash -c '
  JOBS_FILE="'"$JOBS_FILE"'" python3 - <<PYEOF
import json,os
latest={}
for l in open(os.environ["JOBS_FILE"]):
    if l.strip():
        r=json.loads(l); latest[r["id"]]=r
ok=[r for r in latest.values() if r["state"]=="verified-done" and r.get("receiptId")]
assert ok, "no verified-done job with receipt"
PYEOF'

# --- 2. verified workspace write -------------------------------------------
send_msg "write file notes/drill.txt phase zero lives"
check "write reply arrives" wait_out "Done — workspace_write" 15
check "workspace file exists with exact content" bash -c 'test "$(cat "'"$DRILL"'/workspace/notes/drill.txt")" = "phase zero lives"'
check "write job verified by hash post-condition" grep -q "workspace file content hash matches" "$JOBS_FILE"

# --- 3. sandbox escape attempts ---------------------------------------------
say "--- escape attempts (all must fail):"
ESCAPE_JS='
const fs = require("fs");
const net = require("net");
const results = [];
try { fs.readFileSync("/state/jobs.jsonl"); results.push("STATE_READ:SUCCEEDED(BAD)"); }
catch (e) { results.push("STATE_READ:blocked:" + e.code); }
try { fs.readdirSync("/run/gus"); results.push("RUNLS:SUCCEEDED(BAD)"); }
catch (e) { results.push("RUNLS:blocked:" + e.code); }
try { fs.writeFileSync("/etc/pwn", "x"); results.push("ROOTFS_WRITE:SUCCEEDED(BAD)"); }
catch (e) { results.push("ROOTFS_WRITE:blocked:" + e.code); }
try { fs.readdirSync("/comm"); results.push("COMM_LS:" + fs.readdirSync("/comm").join(",")); }
catch (e) { results.push("COMM_LS:blocked:" + e.code); }
const s = net.createConnection({ host: "127.0.0.1", port: 9 });
s.on("connect", () => { results.push("NET_LOOPBACK:SUCCEEDED(BAD)"); console.log(results.join("\n")); process.exit(0); });
s.on("error", (e) => { results.push("NET_LOOPBACK:blocked:" + e.code);
  fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(2000) })
    .then(() => { results.push("NET_INTERNET:SUCCEEDED(BAD)"); console.log(results.join("\n")); })
    .catch((e2) => { results.push("NET_INTERNET:blocked"); console.log(results.join("\n")); });
});
setTimeout(() => console.log(results.join("\n")), 4000);
'
$PODMAN run --rm --name gus-probe --userns=auto --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:size=32m \
  -v "$DRILL/comm:/comm:U" -v "$DRILL/workspace:/workspace:U" \
  --entrypoint /usr/bin/node gus-agent:dev -e "$ESCAPE_JS" > "$DRILL/escape.txt" 2>&1
cat "$DRILL/escape.txt" | tee -a "$EVIDENCE"
check "control-plane state not readable from sandbox" grep -q "STATE_READ:blocked" "$DRILL/escape.txt"
check "channel run dir not visible from sandbox" grep -q "RUNLS:blocked" "$DRILL/escape.txt"
check "sandbox rootfs is read-only" grep -q "ROOTFS_WRITE:blocked" "$DRILL/escape.txt"
check "no loopback network from sandbox" grep -q "NET_LOOPBACK:blocked" "$DRILL/escape.txt"
check "no internet from sandbox" grep -q "NET_INTERNET:blocked" "$DRILL/escape.txt"
check "comm volume exposes only the socket" grep -q "COMM_LS:gus.sock" "$DRILL/escape.txt"

# --- 4. destructive call parks ----------------------------------------------
send_msg "delete 5 files"
check "parked notice arrives" wait_out "Job parked" 15
check "job is needs-approval, nothing settled" grep -q '"state":"needs-approval"' "$JOBS_FILE"

# --- 5. kill drill ------------------------------------------------------------
send_msg "slow job"
sleep 2
send_msg "/stop"
check "kill confirmation arrives" wait_out "Kill switch is ON" 15
check "KILLED flag persisted in control-plane state" test -f "$DRILL/state/KILLED"
check "slow job ended failed-loudly with receipt" bash -c '
  JOBS_FILE="'"$JOBS_FILE"'" python3 - <<PYEOF
import json,os
latest={}
for l in open(os.environ["JOBS_FILE"]):
    if l.strip():
        r=json.loads(l); latest[r["id"]]=r
slow=[r for r in latest.values() if r["kind"]=="slow-demo"]
assert slow and slow[0]["state"]=="failed-loudly" and slow[0].get("receiptId"), slow
PYEOF'
send_msg "hello again"
check "while killed, new work is refused at the channel" wait_out "Nothing is running" 15
send_msg "/resume"
check "resume confirmation arrives" wait_out "Kill switch off" 15
send_msg "hello once more"
check "service restored after resume" bash -c 'sleep 3; test $(grep -c "offline stub provider" "'"$DRILL"'/run/outbound.ndjson") -ge 2'

# --- 6. secret-guard drill ----------------------------------------------------
SECRET="AKIAGUSTEST123456789"
JOBS_BEFORE=$(grep -c "" "$JOBS_FILE" 2>/dev/null || echo 0)
send_msg "here is my aws key $SECRET do not share it"
check "secret warning arrives naming the class" wait_out "That looked like a secret (aws_key)" 15
check "guard log holds only the redacted form" grep -q "\[secret refused: aws_key\]" "$DRILL/state/guard.jsonl"
# Scope: everything GUS controls — its state, the workspace, its outbound
# messages, and both containers' logs. The harness's inbound.ndjson is the
# simulated platform side (the user's own sent message lives in the chat
# by construction); GUS's duty is to never ingest or propagate it further.
if grep -r "$SECRET" "$DRILL/state" "$DRILL/workspace" > /dev/null 2>&1 || grep -q "$SECRET" "$DRILL/run/outbound.ndjson" || $PODMAN logs gus-control 2>&1 | grep -q "$SECRET" || $PODMAN logs gus-sandbox 2>&1 | grep -q "$SECRET"; then
  fail "secret string appears NOWHERE in GUS-controlled state/logs/outbound"
else
  pass "secret string appears NOWHERE in GUS-controlled state/logs/outbound"
fi
JOBS_AFTER=$(grep -c "" "$JOBS_FILE" 2>/dev/null || echo 0)
check "no job was created for the refused message" test "$JOBS_BEFORE" = "$JOBS_AFTER"

# --- 7. resource budget ---------------------------------------------------------
sleep 1
# RSS measured host-side: sum VmRSS over each container's process tree.
tree_rss() {
  local root_pid
  root_pid=$($PODMAN inspect -f '{{.State.Pid}}' "$1" 2>/dev/null) || return
  python3 - "$root_pid" <<'PYEOF'
import os, sys
root = int(sys.argv[1])
children = {}
rss = {}
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    try:
        with open(f"/proc/{pid}/stat") as f:
            parts = f.read().rsplit(") ", 1)[1].split()
        ppid = int(parts[1])
        with open(f"/proc/{pid}/status") as f:
            kb = next((int(l.split()[1]) for l in f if l.startswith("VmRSS:")), 0)
        children.setdefault(ppid, []).append(int(pid))
        rss[int(pid)] = kb
    except Exception:
        pass
total, stack = 0, [root]
while stack:
    p = stack.pop()
    total += rss.get(p, 0)
    stack.extend(children.get(p, []))
print(total)
PYEOF
}
C_RSS=$(tree_rss gus-control)
S_RSS=$(tree_rss gus-sandbox)
TOTAL_KB=$(( ${C_RSS:-0} + ${S_RSS:-0} ))
say "RSS control-plane: ${C_RSS} KB · sandbox: ${S_RSS} KB · total: ${TOTAL_KB} KB (budget: 1048576 KB)"
python3 -c "import json; json.dump({'controlRssKb': ${C_RSS:-0}, 'sandboxRssKb': ${S_RSS:-0}}, open('$DRILL/metrics.json','w'))"
check "steady-state RAM within 1 GB budget" test "$TOTAL_KB" -le 1048576

# Keep evidence + metrics with the repo even when the working dir is elsewhere.
mkdir -p "$PWD/drill/phase0"
cp "$DRILL/metrics.json" "$PWD/drill/phase0/metrics.json" 2>/dev/null
cp "$EVIDENCE" "$PWD/drill/phase0/evidence.log" 2>/dev/null

say "=== drill complete: $FAILS failure(s) ==="
if [ "${KEEP:-0}" != "1" ]; then $PODMAN rm -f gus-control gus-sandbox >/dev/null 2>&1; fi
exit "$FAILS"
