#!/usr/bin/env bash
# GUS Phase 3 gate drill — the bad-update drill (foundation spec §2.2,
# Phase 3 gate): "updates never break the user's working agent."
#
# The pipeline under test (all of it in the control plane; the sandbox
# never updates itself): verify the signed manifest + every file hash
# → snapshot config → stage into the idle slot → CANARY REPLAY of the
# recorded scenarios (chat, write+verify, allowlisted fetch, approval
# park) against the candidate runtime → promote by pointer flip →
# live confirmation → settle. Any failure before promotion leaves the
# old version serving; a failure AT promotion rolls back by pointer.
#
# Cases:
#   S2  happy path + the mid-job rule: a real v0.3 → v0.4 update lands
#       while a slow job is running — the job is never interrupted
#       (it settles verified-done BEFORE the switch-over notice), the
#       new greeting proves the new build, /version reports slot B.
#   S3  the approval gate + case (a) CORRUPT PACKAGE: an update
#       requested while an approval is parked WAITS (no failure, no
#       movement); once the park clears, the tampered bundle (altered
#       after signing) is rejected on hash mismatch BEFORE staging —
#       the running version is untouched.
#   S4  case (b) CRASHY RELEASE: a genuinely signed release whose
#       runtime dies at boot fails the canary health check → never
#       promoted, operator notified, old version still serving.
#   S5  case (c) SUBTLY BROKEN RELEASE: boots healthy, but its write
#       path returns wrong content, so the canary's write-verify
#       digest post-condition fails → rolled back before going live;
#       a normal write job then succeeds on the restored version.
#   S6  crashy CONTROL PLANE: passes the canary (its runtime is fine),
#       promotes, and dies at boot → the launcher watchdog flips the
#       pointer back and the old control plane finalizes the rollback
#       with operator notification.
#   S7  integrity: the append-only stores (ledger/jobs/approvals/
#       receipts/egress) are prefix-identical before/after the whole
#       drill — updates appended, never rewrote; the vault file is
#       byte-identical; operator config is byte-identical; the Phase 1
#       canary-secret sweep re-runs over everything, install included.
#
# Vehicle: same podman substitution as Phases 0–2 (docs/LOCAL-DRILL.md).
# Two Phase 3 vehicle notes: the containers boot through the slot
# LAUNCHER (control via drill3-entry.mjs, which keeps the egress test
# world alive across control-plane restarts), and the SHARED volumes
# (comm, install) are mounted WITHOUT :U and pre-created mode 0777 —
# a :U mount re-chowns the tree to whichever container mounted last
# and locks the other container's userns out (EACCES on the comm
# socket; existsSync lies false on the install pointer). Single-
# container volumes (state, run, apilog, workspace) keep :U. The
# canary scratch workspace likewise moves onto the sandbox-owned
# workspace volume (GUS_CANARY_WORKSPACE): this vehicle's tmpfs is
# not writable by the container user. (That failure also caught a
# real bug — the sandbox launcher now treats canary setup errors as
# non-fatal; see launcher.mjs.)
#
# Env: PODMAN (default "podman"), KEEP=1 keeps containers + drill dir.
set -u
cd "$(dirname "$0")/../.."
PODMAN=${PODMAN:-podman}
DRILL="${DRILL_DIR:-$PWD/drill/phase3}"
STATE="$DRILL/state"
JOBS_FILE="$STATE/jobs.jsonl"
LEDGER_FILE="$STATE/ledger.jsonl"
APPROVALS_FILE="$STATE/approvals.jsonl"
UPDATE_FILE="$STATE/update.json"
UPDATES_LOG="$STATE/updates.jsonl"
API_LOG="$DRILL/apilog/api.jsonl"
EVIDENCE="$DRILL/evidence.log"
FAILS=0
rm -rf "$DRILL"
mkdir -p "$DRILL"/{comm,workspace,state,run,apilog,install,keys,baseline}
: > "$EVIDENCE"
touch "$DRILL/run/inbound.ndjson" "$DRILL/run/outbound.ndjson"
chmod 666 "$DRILL/run/inbound.ndjson" "$DRILL/run/outbound.ndjson"
chmod 777 "$DRILL/comm" "$DRILL/install"

say() { echo "$@" | tee -a "$EVIDENCE"; }
pass() { say "PASS  $1"; }
fail() { say "FAIL  $1"; FAILS=$((FAILS+1)); }
check() { # check <name> <cmd...>
  local name="$1"; shift
  if "$@" >>"$EVIDENCE" 2>&1; then pass "$name"; else fail "$name"; fi
}

CANARY="gus-canary-$(python3 -c 'import secrets; print(secrets.token_hex(12))')"

say "=== GUS Phase 3 gate drill (boring updates / bad-update drill) — $(date -u +%FT%TZ) ==="

# --- operator-side setup: egress policy, approval policy, governor caps.
# All control-plane state files the sandbox cannot see (as Phase 2).
cat > "$STATE/egress-policy.json" <<'JSON'
{
  "allow": [{ "host": "127.0.0.1", "ports": [8901] }],
  "injections": [
    { "host": "127.0.0.1", "port": 8901, "secret": "test-api", "header": "x-api-key" }
  ]
}
JSON
cat > "$STATE/policy.json" <<'JSON'
{ "version": 1, "bulkThreshold": 5, "approvalTimeoutMs": 12000, "rules": [] }
JSON
cat > "$STATE/governor.json" <<'JSON'
{
  "maxTokensPerJob": 1000000,
  "maxTokensPerDay": 1000000,
  "maxUsdPerTask": 100.0,
  "maxUsdPerDay": 100.0,
  "maxUsdPerMonth": 100.0,
  "pricesUsdPer1k": { "fake/stub-v0 (Phase 0 offline provider)": 2 }
}
JSON

# --- release keypair: the PRIVATE key stays host-side in the drill
# dir (never enters a container); the public key is pinned into state.
node test/fixtures/gen-update-key.mjs "$DRILL/keys/release-priv.pem" "$DRILL/keys/release-pub.pem" >>"$EVIDENCE" 2>&1
cp "$DRILL/keys/release-pub.pem" "$STATE/update-pubkey.pem"
check "release keypair generated; public key pinned into control-plane state" test -s "$STATE/update-pubkey.pem"

# --- the five releases: one good, four bad (see make-release.mjs).
# All but 0.4.1 are GENUINELY SIGNED bad releases — signature checks
# cannot catch a bad build; the canary replay and rollback must.
mkrel() { # mkrel <version> [sabotage]
  node test/fixtures/make-release.mjs --src dist-bundle --out "$STATE/releases/$1" \
    --version "$1" --key "$DRILL/keys/release-priv.pem" ${2:+--sabotage "$2"} >>"$EVIDENCE" 2>&1
}
mkrel 0.4.0
mkrel 0.4.1 tamper
mkrel 0.4.2 runtime-crash
mkrel 0.4.3 write-tamper
mkrel 0.4.4 cp-crash
check "five releases built into <state>/releases (0.4.0 good; 0.4.1 tampered; 0.4.2 crashy runtime; 0.4.3 write-tamper; 0.4.4 crashy control plane)" \
  bash -c 'test -f "'"$STATE"'/releases/0.4.0/manifest.sig" && test -f "'"$STATE"'/releases/0.4.4/manifest.sig"'

printf '%s' "$CANARY" | $PODMAN run --rm -i --userns=auto --network none \
  -v "$STATE:/state:U" --entrypoint /usr/bin/node gus-control:dev \
  main.js vault-admin add test-api - >>"$EVIDENCE" 2>&1
check "vault seeded via admin CLI (stdin)" grep -q 'stored secret under name "test-api"' "$EVIDENCE"

rm_containers() {
  local id
  for name in gus-control gus-sandbox; do
    id=$($PODMAN ps -aq --filter "name=^${name}$" 2>/dev/null | head -1)
    [ -n "$id" ] && $PODMAN rm -f "$id" >/dev/null 2>&1
  done
}
rm_containers

# Control container: drill3-entry keeps the egress test world alive
# across control-plane restarts and runs the slot launcher in the
# control role. Confirm window is shortened for the drill (the
# watchdog hang-guard); the crash path itself is immediate.
$PODMAN run -d --name gus-control --userns=auto --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:size=32m \
  -v "$STATE:/state:U" -v "$DRILL/comm:/comm" -v "$DRILL/run:/run/gus:U" \
  -v "$DRILL/apilog:/apilog:U" -v "$DRILL/install:/install" \
  -e GUS_CHANNEL=fake-file \
  -e GUS_FAKE_INBOUND=/run/gus/inbound.ndjson \
  -e GUS_FAKE_OUTBOUND=/run/gus/outbound.ndjson \
  -e GUS_EGRESS_POLICY=/state/egress-policy.json \
  -e GUS_INSTALL_DIR=/install \
  -e GUS_CONFIRM_WINDOW_MS=30000 \
  -e GUS_CANARY_HEALTH_TIMEOUT_MS=20000 \
  -e EXPECTED_KEY="$CANARY" -e API_LOG=/apilog/api.jsonl -e SINK_LOG=/apilog/sink.jsonl \
  --entrypoint /usr/bin/node gus-control:dev drill3-entry.mjs >>"$EVIDENCE" 2>&1
# Wait for the launcher to seed the install BEFORE the sandbox starts,
# so the sandbox's own seed step is a no-op (its install mount is :ro).
for i in $(seq 1 50); do [ -f "$DRILL/install/current.json" ] && break; sleep 0.2; done
$PODMAN run -d --name gus-sandbox --userns=auto --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:size=64m \
  -v "$DRILL/comm:/comm" -v "$DRILL/workspace:/workspace:U" -v "$DRILL/install:/install:ro" \
  -e GUS_INSTALL_DIR=/install -e GUS_COMM_DIR=/comm -e GUS_WORKSPACE=/workspace \
  -e GUS_CANARY_WORKSPACE=/workspace/.canary-ws \
  --entrypoint /usr/bin/node gus-agent:dev /app/launcher.mjs sandbox >>"$EVIDENCE" 2>&1

for i in $(seq 1 50); do [ -S "$DRILL/comm/gus.sock" ] && break; sleep 0.2; done
for i in $(seq 1 50); do
  $PODMAN logs gus-control 2>&1 | grep -q "test api listening" && break
  sleep 0.2
done
sleep 2

# --- harness helpers (Phase 2 set, plus Phase 3 pointer/store helpers) -------
UPD_ID=0
send_msg() {
  UPD_ID=$((UPD_ID+1))
  python3 - "$UPD_ID" "$1" >> "$DRILL/run/inbound.ndjson" <<'PYEOF'
import json,sys,time
uid=int(sys.argv[1]); text=sys.argv[2]
print(json.dumps({"update_id":uid,"message":{"message_id":uid,"date":int(time.time()),"text":text,"chat":{"id":4242},"from":{"id":777}}}))
PYEOF
}
send_callback() { # send_callback <callback-data>
  UPD_ID=$((UPD_ID+1))
  python3 - "$UPD_ID" "$1" >> "$DRILL/run/inbound.ndjson" <<'PYEOF'
import json,sys,time
uid=int(sys.argv[1]); data=sys.argv[2]
print(json.dumps({"update_id":uid,"callback_query":{"id":f"cb{uid}","data":data,"from":{"id":777},"message":{"chat":{"id":4242}}}}))
PYEOF
}
OUT="$DRILL/run/outbound.ndjson"
count_out() { grep -c "$1" "$OUT" 2>/dev/null || true; }
SNAP=0
snap_out() { SNAP=$(count_out "$1"); }
wait_out_new() {
  local pat="$1" secs="$2" i
  for i in $(seq 1 $((secs*5))); do
    [ "$(count_out "$pat")" -gt "$SNAP" ] && return 0
    sleep 0.2
  done
  return 1
}
count_parks() { grep -c "needs your approval" "$OUT" 2>/dev/null || true; }
PARK_SNAP=0
snap_parks() { PARK_SNAP=$(count_parks); }
wait_park_new() {
  local i
  for i in $(seq 1 100); do
    [ "$(count_parks)" -gt "$PARK_SNAP" ] && return 0
    sleep 0.2
  done
  return 1
}
press_latest() { # press_latest approve|deny — latest matching button in outbound
  python3 - "$1" "$OUT" "$DRILL/run/inbound.ndjson" <<'PYEOF'
import json,sys,time
action=sys.argv[1]; out_path=sys.argv[2]; in_path=sys.argv[3]
data=None
for l in open(out_path):
    if l.strip():
        r=json.loads(l)
        for b in r.get("buttons") or []:
            if str(b.get("id","")).startswith(action+":"):
                data=b["id"]
assert data, "no %s button found in outbound" % action
uid=int(time.time()*1000)%2000000000
with open(in_path,"a") as f:
    f.write(json.dumps({"update_id":uid,"callback_query":{"id":f"cb{uid}","data":data,"from":{"id":777},"message":{"chat":{"id":4242}}}})+"\n")
PYEOF
}
job_field() { # job_field <python-expr over latest-per-id dict>
  JOBS_FILE="$JOBS_FILE" python3 - "$1" <<'PYEOF'
import json,os,sys
latest={}; order=[]
for l in open(os.environ["JOBS_FILE"]):
    if l.strip():
        r=json.loads(l)
        if r["id"] not in latest: order.append(r["id"])
        latest[r["id"]]=r
print(eval(sys.argv[1]))
PYEOF
}
latest_job_state() { job_field "latest[order[-1]]['state']"; }
latest_job_id() { job_field "order[-1]"; }
job_state_by_id() { # job_state_by_id <id>
  JOBS_FILE="$JOBS_FILE" python3 - "$1" <<'PYEOF'
import json,os,sys
latest={}
for l in open(os.environ["JOBS_FILE"]):
    if l.strip():
        r=json.loads(l); latest[r["id"]]=r
print(latest.get(sys.argv[1],{}).get("state",""))
PYEOF
}
latest_update_state() { job_field "[latest[i] for i in order if latest[i]['kind']=='update'][-1]['state']"; }
latest_update_field() { job_field "[latest[i] for i in order if latest[i]['kind']=='update'][-1].get('$1','')"; }
update_note_has() { # update_note_has <substr> [substr2] — latest update job's outcome note
  local note; note="$(latest_update_field outcomeNote)"
  case "$note" in *"$1"*) ;; *) say "--- update note was: $note"; return 1;; esac
  if [ -n "${2:-}" ]; then case "$note" in *"$2"*) ;; *) say "--- update note was: $note"; return 1;; esac; fi
  return 0
}
pointer_is() { # pointer_is <slot> <version>
  [ "$(pointer_field slot)" = "$1" ] && [ "$(pointer_field version)" = "$2" ]
}
pointer_finalized() { [ "$(pointer_field confirmPending)" = "False" ]; }
update_still_waiting() { # update_still_waiting <expected 'did not happen' count>
  [ "$(count_out 'did not happen')" = "$1" ] && [ "$(latest_update_state)" = "running" ]
}
approval_job_state() { # state of the job tied to the most recent approval record
  JOBS_FILE="$JOBS_FILE" APPROVALS_FILE="$APPROVALS_FILE" python3 - <<'PYEOF'
import json,os
latest={}
for l in open(os.environ["JOBS_FILE"]):
    if l.strip():
        r=json.loads(l); latest[r["id"]]=r
apps=[json.loads(l) for l in open(os.environ["APPROVALS_FILE"]) if l.strip()]
print(latest[apps[-1]["jobId"]]["state"])
PYEOF
}
wait_state() { # wait_state <wanted> <secs> <getter-cmd...>
  local wanted="$1" secs="$2" i
  shift 2
  for i in $(seq 1 $((secs*5))); do
    [ "$("$@")" = "$wanted" ] && return 0
    sleep 0.2
  done
  return 1
}
seed_files() { for f in "$@"; do echo "seed content $f" > "$DRILL/workspace/$f"; done; }
pointer_field() { # pointer_field slot|version|confirmPending
  python3 - "$DRILL/install/current.json" "$1" <<'PYEOF'
import json,sys
p=json.load(open(sys.argv[1]))
print(p.get(sys.argv[2]))
PYEOF
}
update_record_field() { # update_record_field status|detail
  python3 - "$UPDATE_FILE" "$1" <<'PYEOF'
import json,sys
r=json.load(open(sys.argv[1]))
print(r.get(sys.argv[2]) or "")
PYEOF
}
store_stat() { # store_stat <path> → "<len> <sha256>" or "absent"
  python3 - "$1" <<'PYEOF'
import hashlib,os,sys
p=sys.argv[1]
if not os.path.exists(p):
    print("absent")
else:
    d=open(p,'rb').read()
    print(f"{len(d)} {hashlib.sha256(d).hexdigest()}")
PYEOF
}
prefix_intact() { # prefix_intact <path> <baseline-stat>
  python3 - "$1" "$2" <<'PYEOF'
import hashlib,os,sys
p,base=sys.argv[1],sys.argv[2]
if base=="absent":
    raise SystemExit(0)  # created since baseline = appended from nothing
if not os.path.exists(p):
    raise SystemExit(1)
n,h=base.split()
d=open(p,'rb').read()
if len(d)<int(n):
    raise SystemExit(1)
raise SystemExit(0 if hashlib.sha256(d[:int(n)]).hexdigest()==h else 1)
PYEOF
}

# --- S1: boot through the launchers + sanity + integrity baselines -----------
snap_out "slot A live"
send_msg "/version"
check "S1 /version reports the seeded slot layout (slot A live, v0.3.0)" wait_out_new "slot A live" 20
check "S1 install pointer names slot A / v0.3.0" pointer_is A 0.3.0
snap_out "GUS here"
send_msg "hello gus"
check "S1 chat round-trip on v0.3.0 (unversioned greeting)" wait_out_new "GUS here" 20
snap_out "Done — workspace_write"
send_msg "write file notes/pre.txt drill baseline write"
check "S1 warm-up write settles verified-done" wait_out_new "Done — workspace_write" 20
check "S1 warm-up job state is verified-done" test "$(latest_job_state)" = "verified-done"
# Baselines: stores by (len, sha256); config + vault also copied aside
# for byte-comparison at S7.
for f in ledger.jsonl jobs.jsonl approvals.jsonl receipts.jsonl egress.jsonl egress-receipts.jsonl vault.json; do
  echo "$f $(store_stat "$STATE/$f")" >> "$DRILL/baseline/stores.txt"
done
cp "$STATE/governor.json" "$STATE/policy.json" "$STATE/egress-policy.json" "$DRILL/baseline/"
say "--- baselines recorded: $(tr '\n' ' ' < "$DRILL/baseline/stores.txt")"

# --- S2: mid-job rule + happy path v0.3.0 → v0.4.0 ------------------------------
PREV_JOB="$(latest_job_id)"
send_msg "slow job"
for i in $(seq 1 50); do [ "$(latest_job_id)" != "$PREV_JOB" ] && break; sleep 0.2; done
SLOW_ID="$(latest_job_id)"
say "--- slow job $SLOW_ID running; requesting the update NOW (mid-job)"
snap_out "I'll verify the release"
send_msg "/update 0.4.0"
check "S2 the update is acknowledged with the verify-first promise" wait_out_new "I'll verify the release" 20
snap_out "Switching over now"
slow_settles_first() { # the running job must settle BEFORE any switch-over
  local i
  for i in $(seq 1 250); do
    [ "$(job_state_by_id "$SLOW_ID")" = "verified-done" ] && return 0
    [ "$(count_out 'Switching over now')" -gt "$SNAP" ] && return 1
    sleep 0.2
  done
  return 1
}
check "S2 MID-JOB: the running slow job settles verified-done BEFORE the update switches over (never interrupted)" slow_settles_first
check "S2 the pre-apply notice told the operator the replay was running" bash -c 'grep -q "the release verified and is staged. Now checking it against your recorded automations" "'"$OUT"'"'
snap_out "Update complete"
check "S2 the update lands and the operator is told (v0.4.0 live)" wait_out_new "Update complete" 120
check "S2 update job settles verified-done" test "$(latest_update_state)" = "verified-done"
check "S2 update job carries a receipt" test -n "$(latest_update_field receiptId)"
check "S2 pointer flipped to slot B / v0.4.0" pointer_is B 0.4.0
check "S2 pointer confirmation finalized (confirmPending cleared)" pointer_finalized
snap_out "slot B live (v0.4.0)"
send_msg "/version"
check "S2 /version now reports slot B live (v0.4.0), runtime v0.4.0" wait_out_new "slot B live (v0.4.0)" 20
snap_out "GUS 0.4.0 here"
send_msg "hello again"
check "S2 the NEW build answers chat (versioned greeting — the visible change)" wait_out_new "GUS 0.4.0 here" 20

# --- S3: approval gate, then case (a) — corrupt package -------------------------
seed_files q1.txt q2.txt
snap_parks
send_msg "delete files q1.txt q2.txt"
check "S3 setup: a delete parks for approval" wait_park_new
DID_NOT_HAPPEN_BEFORE="$(count_out 'did not happen')"
send_msg "/update 0.4.1"
sleep 6
check "S3 GATE: while an approval is parked the update WAITS — no failure notice, no settlement" update_still_waiting "$DID_NOT_HAPPEN_BEFORE"
check "S3 GATE: version is still 0.4.0 while the update waits" test "$(pointer_field version)" = "0.4.0"
press_latest deny
check "S3 the denied delete ends failed-loudly (park cleared)" wait_state failed-loudly 20 approval_job_state
snap_out "did not happen"
check "S3(a) once unblocked, the tampered bundle is refused and the operator told" wait_out_new "did not happen" 60
check "S3(a) refusal reason: rejected BEFORE staging on hash mismatch" update_note_has "rejected before staging" "hash mismatch"
check "S3(a) update job ends failed-loudly" test "$(latest_update_state)" = "failed-loudly"
check "S3(a) the running version was untouched (pointer still B / 0.4.0)" pointer_is B 0.4.0
check "S3(a) the denied files were never deleted" bash -c 'test -f "'"$DRILL"'/workspace/q1.txt" && test -f "'"$DRILL"'/workspace/q2.txt"'
snap_out "GUS 0.4.0 here"
send_msg "still there?"
check "S3(a) the old version still serves chat after the refusal" wait_out_new "GUS 0.4.0 here" 20

# --- S4: case (b) — crashy runtime ------------------------------------------------
T0=$SECONDS
snap_out "did NOT go live"
send_msg "/update 0.4.2"
check "S4(b) the crashy release never goes live; the operator is told it was rolled back" wait_out_new "did NOT go live" 60
ELAPSED=$((SECONDS-T0)); say "--- S4 failure-to-notice: ${ELAPSED}s (gate: <60s — the health check, not a hang, must catch it)"
check "S4(b) the failure surfaced in under 60s" test "$ELAPSED" -lt 60
check "S4(b) update job ends failed-loudly" test "$(latest_update_state)" = "failed-loudly"
check "S4(b) update record names the pre-promotion verification failure" grep -q "pre-promotion verification failed" "$UPDATE_FILE"
check "S4(b) pointer never moved (still B / 0.4.0)" pointer_is B 0.4.0
snap_out "GUS 0.4.0 here"
send_msg "roll call"
check "S4(b) the old version never stopped serving (chat answers on 0.4.0)" wait_out_new "GUS 0.4.0 here" 20

# --- S5: case (c) — subtly broken release (write path tampers content) -------------
snap_out "did NOT go live"
send_msg "/update 0.4.3"
check "S5(c) the subtly broken release is caught by the verification replay; operator notified" wait_out_new "did NOT go live" 90
check "S5(c) the failing check is the write-verify digest post-condition" grep -q "write-verify" "$UPDATE_FILE"
check "S5(c) update job ends failed-loudly" test "$(latest_update_state)" = "failed-loudly"
check "S5(c) pointer still B / 0.4.0 (never promoted)" pointer_is B 0.4.0
snap_out "Done — workspace_write"
send_msg "write file notes/after-rollback.txt restored and working"
check "S5(c) a normal write job succeeds on the restored version" wait_out_new "Done — workspace_write" 20
check "S5(c) the restored write path is byte-exact (no tamper in the live build)" bash -c 'test "$(cat "'"$DRILL"'/workspace/notes/after-rollback.txt")" = "restored and working"'
check "S5(c) that job settles verified-done" test "$(latest_job_state)" = "verified-done"

# --- S6: crashy control plane — promotion, watchdog rollback -------------------------
snap_out "the new version failed to start"
T0=$SECONDS
send_msg "/update 0.4.4"
check "S6 the crashy control plane is rolled back automatically; the operator is told" wait_out_new "the new version failed to start" 150
ELAPSED=$((SECONDS-T0)); say "--- S6 promotion-to-rollback-notice: ${ELAPSED}s"
check "S6 update record finalized as rolled-back" test "$(update_record_field status)" = "rolled-back"
check "S6 update job ends failed-loudly" test "$(latest_update_state)" = "failed-loudly"
check "S6 update job carries a receipt" test -n "$(latest_update_field receiptId)"
check "S6 the watchdog rollback is in the update event log" grep -q "update_watchdog_rollback" "$UPDATES_LOG"
check "S6 pointer restored to slot B / v0.4.0" pointer_is B 0.4.0
snap_out "slot B live (v0.4.0)"
send_msg "/version"
check "S6 /version answers on the restored control plane" wait_out_new "slot B live (v0.4.0)" 30
snap_out "GUS 0.4.0 here"
send_msg "back from the dead?"
check "S6 chat works on the restored version" wait_out_new "GUS 0.4.0 here" 20

# --- S7: integrity — nothing an update did can lose data ------------------------------
say "--- S7 integrity (baselines from S1, after five update attempts: 1 landed, 4 refused/rolled back):"
while IFS= read -r line; do
  fname="${line%% *}"; fstat="${line#* }"
  check "S7 append-only prefix intact: $fname" prefix_intact "$STATE/$fname" "$fstat"
done < "$DRILL/baseline/stores.txt"
vault_unchanged() {
  local base; base=$(grep '^vault.json' "$DRILL/baseline/stores.txt" | cut -d' ' -f2-)
  [ "$(store_stat "$STATE/vault.json")" = "$base" ]
}
check "S7 vault.json is BYTE-IDENTICAL (an update can never rewrite the vault)" vault_unchanged
config_unchanged() {
  cmp -s "$STATE/governor.json" "$DRILL/baseline/governor.json" &&
  cmp -s "$STATE/policy.json" "$DRILL/baseline/policy.json" &&
  cmp -s "$STATE/egress-policy.json" "$DRILL/baseline/egress-policy.json"
}
check "S7 operator config byte-identical (snapshot/restore round-trips exactly)" config_unchanged
check "S7 no KILLED file was ever created by an update" test ! -e "$STATE/KILLED"
check "S7 update event log holds the full history (confirmed + canary failures + watchdog rollback)" bash -c 'grep -q update_confirmed "'"$UPDATES_LOG"'" && grep -q update_canary_failed "'"$UPDATES_LOG"'" && grep -q update_watchdog_rollback "'"$UPDATES_LOG"'"'

# --- canary sweep (Phase 1 discipline, now over the install tree too) -------------------
say "--- canary sweep (install slots included):"
if grep -r "$CANARY" "$STATE" "$DRILL/workspace" "$DRILL/install" > /dev/null 2>&1 \
  || grep -q "$CANARY" "$OUT" \
  || grep -q "$CANARY" "$API_LOG" \
  || $PODMAN logs gus-control 2>&1 | grep -q "$CANARY" \
  || $PODMAN logs gus-sandbox 2>&1 | grep -q "$CANARY"; then
  fail "canary appears NOWHERE in GUS state, workspace, install, outbound, logs, or API records"
else
  pass "canary appears NOWHERE in GUS state, workspace, install, outbound, logs, or API records"
fi

# --- resource budget -----------------------------------------------------------------------
sleep 1
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
say "RSS control-plane (incl. drill test world): ${C_RSS} KB · sandbox: ${S_RSS} KB · total: ${TOTAL_KB} KB (budget: 1048576 KB)"
python3 -c "import json; json.dump({'controlRssKb': ${C_RSS:-0}, 'sandboxRssKb': ${S_RSS:-0}}, open('$DRILL/metrics.json','w'))"
check "steady-state RAM within 1 GB budget" test "$TOTAL_KB" -le 1048576

mkdir -p "$PWD/drill/phase3"
cp "$DRILL/metrics.json" "$PWD/drill/phase3/metrics.json" 2>/dev/null
cp "$EVIDENCE" "$PWD/drill/phase3/evidence.log" 2>/dev/null

say "=== drill complete: $FAILS failure(s) ==="
if [ "${KEEP:-0}" != "1" ]; then rm_containers; fi
exit "$FAILS"
