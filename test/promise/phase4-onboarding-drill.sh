#!/usr/bin/env bash
# GUS Phase 4 onboarding drill — the five-minute first run (foundation
# spec §1.6, Phase 4 gate): a non-technical operator goes from a fresh
# install to a verified first job using ONLY the panel wizard — no
# terminal beyond the single install command (the container boot,
# which the harness performs), and no hand-edited config files: every
# value below reaches the system through the wizard's own endpoints,
# driven by the in-container panel driver (podman exec is unavailable
# in this VM; the driver is the operator's hands — see panel-driver.mjs).
#
# MODE DISCLOSURES (same vehicle rules as the gate drill):
#   - Shield provisioning runs the zero-form signup against the
#     recorded-replay stand-in: the signup response was captured from
#     the LIVE API at host level minutes earlier (record-shield.mjs,
#     --signup-only). The key flows response → vault exactly as in
#     production.
#   - The provider step chooses the bundled GATEWAY class with a
#     drill key, pointed at a local OpenAI-compatible stand-in. The
#     vehicle has no egress to a real provider and no real provider
#     key may be spent by a drill; what is exercised is the real code
#     path — wizard → vault → provider class → Governor metering →
#     verified settlement — not a real model's prose.
#
# The walk (5 user actions, target ≤6 steps and <5 min of user action):
#   1. shield   — provision the gate (fail-closed), one click.
#   2. telegram — paste a bot token (goes to the vault, nowhere else).
#   3. provider — gateway + model + key (key to the vault).
#   4. caps     — accept the pre-filled suggested ceilings.
#   5. firstJob — run the daily digest; it must settle verified-done.
# Timing is measured from the panel driver's own timestamps, from the
# first wizard action to the first-job response; the job's settle
# wait is reported separately (it is the system's time, not the user's).
#
# Env: PODMAN (default "podman"), KEEP=1 keeps containers + drill dir.
set -u
cd "$(dirname "$0")/../.."
PODMAN=${PODMAN:-podman}
DRILL="${DRILL_DIR:-$PWD/drill/phase4-onboarding}"
STATE="$DRILL/state"
JOBS_FILE="$STATE/jobs.jsonl"
LEDGER_FILE="$STATE/ledger.jsonl"
MODEL_LOG_FILE="$DRILL/apilog/model.jsonl"
OUT="$DRILL/run/outbound.ndjson"
RESULTS="$DRILL/run/panel-results.jsonl"
EVIDENCE="$DRILL/evidence.log"
FAILS=0
rm -rf "$DRILL"
mkdir -p "$DRILL"/{comm,workspace,state,run,apilog,recordings}
: > "$EVIDENCE"
touch "$DRILL/run/inbound.ndjson" "$OUT" "$DRILL/run/panel-script.jsonl" "$RESULTS"
chmod 666 "$DRILL/run/inbound.ndjson" "$OUT" "$DRILL/run/panel-script.jsonl" "$RESULTS"
chmod 777 "$DRILL/comm"

say() { echo "$@" | tee -a "$EVIDENCE"; }
pass() { say "PASS  $1"; }
fail() { say "FAIL  $1"; FAILS=$((FAILS+1)); }
check() { # check <name> <cmd...>
  local name="$1"; shift
  if "$@" >>"$EVIDENCE" 2>&1; then pass "$name"; else fail "$name"; fi
}

RUN_TMP="$(mktemp -d)"
KEY_FILE="$RUN_TMP/shield.key"
rm_containers() {
  local id
  for name in gus-control gus-sandbox; do
    id=$($PODMAN ps -aq --filter "name=^${name}$" 2>/dev/null | head -1)
    [ -n "$id" ] && $PODMAN rm -f "$id" >/dev/null 2>&1
  done
}
cleanup() {
  rm -f "$DRILL/recordings/shield-recordings.json" "$KEY_FILE" "$DRILL/run/panel-script.jsonl"
  rmdir "$RUN_TMP" 2>/dev/null
  if [ "${KEEP:-0}" != "1" ]; then rm_containers; fi
}
trap cleanup EXIT

MODEL_KEY="gus-drill-gateway-key-0001"
TELEGRAM_TOKEN="1109876543:AAHphase4DrillTokenNotReal0000x"

say "=== GUS Phase 4 onboarding drill (five-minute first run) — $(date -u +%FT%TZ) ==="
say "MODE: fresh install; wizard-only configuration via the panel driver; Shield signup"
say "replayed from a live capture; gateway provider class against a local model stand-in."

# --- record the live signup (the only live response this drill needs).
node test/fixtures/record-shield.mjs --signup-only \
  --out "$DRILL/recordings/shield-recordings.json" --key-out "$KEY_FILE" >>"$EVIDENCE" 2>&1
check "live Shield signup recorded at host level" grep -q "signup recorded" "$EVIDENCE"
SHIELD_KEY="$(cat "$KEY_FILE")"

# --- the ONLY pre-boot state: an egress policy that allows nothing
# (the digest fetches nothing; onboarding itself must create the rest).
cat > "$STATE/egress-policy.json" <<'JSON'
{ "allow": [], "injections": [] }
JSON

rm_containers
$PODMAN run -d --name gus-control --userns=auto --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:size=32m \
  --add-host gus-drill:127.0.0.1 \
  -v "$STATE:/state:U" -v "$DRILL/comm:/comm" -v "$DRILL/run:/run/gus:U" \
  -v "$DRILL/apilog:/apilog:U" -v "$DRILL/recordings:/recordings:U" \
  -e GUS_CHANNEL=fake-file \
  -e GUS_FAKE_INBOUND=/run/gus/inbound.ndjson \
  -e GUS_FAKE_OUTBOUND=/run/gus/outbound.ndjson \
  -e GUS_EGRESS_POLICY=/state/egress-policy.json \
  -e GUS_SHIELD_BASE_URL=http://127.0.0.1:8910 \
  -e GUS_SHIELD_RECORDINGS=/recordings/shield-recordings.json \
  -e GUS_SHIELD_DOWN_FLAG=/run/gus/shield-down \
  -e EXPECTED_KEY="unused-in-this-drill" -e API_LOG=/apilog/api.jsonl -e SINK_LOG=/apilog/sink.jsonl \
  -e SHIELD_LOG=/apilog/shield.jsonl -e ARTICLE_LOG=/apilog/article.jsonl -e MODEL_LOG=/apilog/model.jsonl \
  -e MODEL_EXPECTED_KEY="$MODEL_KEY" \
  --entrypoint /usr/bin/node gus-control:dev drill4-entry.mjs >>"$EVIDENCE" 2>&1
$PODMAN run -d --name gus-sandbox --userns=auto --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:size=64m \
  -v "$DRILL/comm:/comm" -v "$DRILL/workspace:/workspace:U" \
  gus-agent:dev >>"$EVIDENCE" 2>&1

for i in $(seq 1 50); do [ -S "$DRILL/comm/gus.sock" ] && break; sleep 0.2; done
for i in $(seq 1 75); do grep -q '"__ready"' "$RESULTS" 2>/dev/null && break; sleep 0.2; done
sleep 2
check "fresh install booted; panel driver ready (the 'install command' is done — everything after this is the wizard)" \
  grep -q '"__ready"' "$RESULTS"

# --- panel driver helpers (same as the gate drill) -------------------
panel_step() { # panel_step <id> <method> <path> [json-body]
  python3 - "$1" "$2" "$3" "${4:-}" >> "$DRILL/run/panel-script.jsonl" <<'PYEOF'
import json,sys
step={"id":sys.argv[1],"method":sys.argv[2],"path":sys.argv[3]}
if sys.argv[4]: step["body"]=json.loads(sys.argv[4])
print(json.dumps(step))
PYEOF
}
panel_result() {
  local id="$1" i
  for i in $(seq 1 150); do
    if grep -q "\"id\":\"$id\"" "$RESULTS" 2>/dev/null; then
      grep "\"id\":\"$id\"" "$RESULTS" | tail -1
      return 0
    fi
    sleep 0.2
  done
  return 1
}
panel_check() { # panel_check <name> <id> <python-expr over result dict r>
  local name="$1" id="$2" expr="$3" line
  line=$(panel_result "$id") || { fail "$name (no panel result for step $id)"; return; }
  if PANEL_LINE="$line" python3 -c "import json,os,sys; r=json.loads(os.environ['PANEL_LINE']); sys.exit(0 if ($expr) else 1)" >>"$EVIDENCE" 2>&1; then
    pass "$name"
  else
    fail "$name"
    echo "  panel result was: $line" >>"$EVIDENCE"
  fi
}

say "--- the walk: five wizard actions, nothing else"
panel_step ob-status0 GET /api/status
panel_check "fresh install: gate NOT provisioned yet (the wizard is what provisions it)" ob-status0 \
  "r['body']['shield']['provisioned'] is False"
panel_step ob-view0 GET /api/onboarding
panel_check "wizard opens with all five steps undone" ob-view0 \
  "all(not s['done'] for s in r['body']['steps'].values())"
CAPS_BODY="$(RESULTS="$RESULTS" python3 - <<'PYEOF'
import json,os
for l in open(os.environ["RESULTS"]):
    if l.strip():
        r=json.loads(l)
        if r.get("id")=="ob-view0":
            print(json.dumps(r["body"]["suggestedCaps"]))
PYEOF
)"
say "suggested caps offered by the wizard: $CAPS_BODY"

panel_step ob-shield POST /api/onboarding/shield '{"onUnavailable":"closed"}'
panel_check "step 1/5 shield: gate provisioned, fail-closed recorded" ob-shield "r['body'].get('ok') is True"
panel_step ob-telegram POST /api/onboarding/telegram "{\"token\":\"$TELEGRAM_TOKEN\"}"
panel_check "step 2/5 telegram: bot token accepted into the vault" ob-telegram "r['body'].get('ok') is True"
panel_step ob-provider POST /api/onboarding/provider \
  "{\"provider\":\"gateway\",\"model\":\"llama3.1:8b\",\"baseUrl\":\"http://127.0.0.1:8905/v1\",\"apiKey\":\"$MODEL_KEY\"}"
panel_check "step 3/5 provider: gateway + model saved, key to the vault" ob-provider "r['body'].get('ok') is True"
panel_step ob-caps POST /api/onboarding/caps "$CAPS_BODY"
panel_check "step 4/5 caps: suggested ceilings accepted as-is" ob-caps "r['body'].get('ok') is True"
panel_step ob-first POST /api/onboarding/first-job '{}'
panel_check "step 5/5 first job: the digest is created through the live pipeline" ob-first \
  "r['body'].get('ok') is True and bool(r['body'].get('jobId'))"
DIGEST_JOB="$(RESULTS="$RESULTS" python3 - <<'PYEOF'
import json,os
for l in open(os.environ["RESULTS"]):
    if l.strip():
        r=json.loads(l)
        if r.get("id")=="ob-first":
            print(r["body"].get("jobId",""))
PYEOF
)"
say "digest job: $DIGEST_JOB"

# --- step count + user-action wall-clock, from the driver's stamps.
RESULTS="$RESULTS" python3 - >>"$EVIDENCE" 2>&1 <<'PYEOF'
import json,os,sys
steps={}
for l in open(os.environ["RESULTS"]):
    if l.strip():
        r=json.loads(l); steps[r.get("id")]=r
actions=["ob-shield","ob-telegram","ob-provider","ob-caps","ob-first"]
missing=[a for a in actions if a not in steps]
assert not missing, f"missing steps: {missing}"
t0=min(steps[a]["startedAt"] for a in actions)
t1=max(steps[a]["endedAt"] for a in actions)
wall=(t1-t0)/1000.0
print(f"USER ACTIONS: {len(actions)} (target <= 6)")
print(f"USER-ACTION WALL-CLOCK: {wall:.1f}s (target < 300s)")
sys.exit(0 if len(actions)<=6 and wall<300 else 1)
PYEOF
check "step count ≤6 and user-action wall-clock <5 minutes (actuals in evidence above)" test "$?" = "0"

# --- the first job must settle verified-done (system time, reported).
DIGEST_STATE=""
for i in $(seq 1 150); do
  DIGEST_STATE="$(JOBS_FILE="$JOBS_FILE" python3 -c "
import json,os
latest={}
for l in open(os.environ['JOBS_FILE']):
    if l.strip():
        r=json.loads(l); latest[r['id']]=r
print(latest.get('$DIGEST_JOB',{}).get('state',''))" 2>/dev/null)"
  case "$DIGEST_STATE" in verified-done|failed-loudly) break;; esac
  sleep 0.2
done
check "first guided job settles verified-done" bash -c "test '$DIGEST_STATE' = 'verified-done'"
check "the digest reply was delivered to the operator" grep -q "daily digest" "$OUT"
check "the model stand-in received the call WITH the vault key in flight (keyOk)" \
  grep -q '"keyOk":true' "$MODEL_LOG_FILE"
check "the Governor metered the digest job (ledger settle entries exist for it)" \
  bash -c "grep -q '$DIGEST_JOB' '$LEDGER_FILE'"

say "--- what the wizard wrote (and what it must never write)"
check "onboarding.json records all five steps done" \
  python3 -c "import json; s=json.load(open('$STATE/onboarding.json'))['steps']; assert all(k in s for k in ('shield','telegram','provider','caps','firstJob')), s"
check "provider.json names the gateway + model — and contains no key" \
  bash -c "grep -q '\"gateway\"' '$STATE/provider.json' && ! grep -qF '$MODEL_KEY' '$STATE/provider.json'"
check "governor.json carries the accepted caps" \
  python3 -c "import json; g=json.load(open('$STATE/governor.json')); assert g['maxUsdPerTask']==2 and g['maxUsdPerDay']==10 and g['maxUsdPerMonth']==100, g"
check "policy.json records the shield requirement" \
  python3 -c "import json; s=json.load(open('$STATE/policy.json'))['shield']; assert s['required'] is True, s"
panel_step ob-vault GET /api/vault
panel_check "vault holds all three wizard secrets, by name only" ob-vault \
  "all(n in r['body']['names'] for n in ('agent-shield','telegram-bot','starter-gateway'))"
panel_step ob-view1 GET /api/onboarding
panel_check "wizard now shows every step done" ob-view1 \
  "all(s['done'] for s in r['body']['steps'].values())"

say "--- hygiene: wizard secrets live only in the vault's ciphertext"
rm -f "$DRILL/recordings/shield-recordings.json" "$DRILL/run/panel-script.jsonl"
for SECRET in "$MODEL_KEY" "$TELEGRAM_TOKEN" "$SHIELD_KEY"; do
  if grep -rqF "$SECRET" "$STATE" "$DRILL/workspace" "$OUT" 2>/dev/null; then
    fail "a wizard secret appears in state/workspace/outbound in plaintext"
  fi
done
pass "gateway key, telegram token, and Shield key appear nowhere in state/workspace/outbound in plaintext"
if $PODMAN logs gus-control 2>&1 | grep -qF "$MODEL_KEY" || $PODMAN logs gus-sandbox 2>&1 | grep -qF "$MODEL_KEY"; then
  fail "the gateway key appears in no container log"
else
  pass "the gateway key appears in no container log"
fi
say "(scope note: the harness's own panel-script file held the typed values — the"
say " operator's side of the glass, like a typed password — and was deleted above;"
say " GUS's duty, proven here, is that they never land in its state or output.)"

# --- resource budget (same topology as the gate drill) ---------------
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
say "RSS control-plane (incl. panel + drill world): ${C_RSS} KB · sandbox: ${S_RSS} KB · total: ${TOTAL_KB} KB (budget: 1048576 KB)"
python3 -c "import json; json.dump({'controlRssKb': ${C_RSS:-0}, 'sandboxRssKb': ${S_RSS:-0}}, open('$DRILL/metrics.json','w'))"
check "steady-state RAM within 1 GB budget" test "$TOTAL_KB" -le 1048576

mkdir -p "$PWD/drill/phase4-onboarding"
cp "$DRILL/metrics.json" "$PWD/drill/phase4-onboarding/metrics.json" 2>/dev/null
cp "$EVIDENCE" "$PWD/drill/phase4-onboarding/evidence.log" 2>/dev/null

say "=== drill complete: $FAILS failure(s) ==="
exit "$FAILS"
