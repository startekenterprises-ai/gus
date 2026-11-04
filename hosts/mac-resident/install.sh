#!/bin/sh
# GUS — Mac resident install (Phase 7).
#
# Run ON the Mac that will host GUS, as the user GUS should live as:
#
#   sh hosts/mac-resident/install.sh
#
# What it does:
#   1. Checks Node >= 22 and builds the repo (npm install + build).
#   2. Creates the GUS home: state (vault, ledger, policy, approvals),
#      logs, the comm dir for the CP<->runtime socket, the workspace.
#   3. Seeds <state>/policy.json from docs/mac-policy-template.json
#      ONLY if none exists — then stops to make you edit mac.workDirs
#      to your real project paths before it loads anything. An
#      existing policy file is never overwritten.
#   4. Renders the two launchd agents (control plane + runtime) into
#      ~/Library/LaunchAgents and loads them: GUS starts at login.
#
# What it does NOT do: create the Telegram bot (BotFather — the token
# goes in the vault via the panel wizard, never in a plist), enable
# Time Machine (verify it's ON before residency — docs/mac-resident.md),
# or touch any existing GUS state.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)
GUS_HOME=${GUS_HOME:-"$HOME/.gus"}
STATE_DIR="$GUS_HOME/state"
COMM_DIR="$GUS_HOME/comm"
WORKSPACE_DIR="$GUS_HOME/workspace"
AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  echo "install: Node.js >= 22 is required and was not found on PATH." >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "install: Node.js >= 22 is required (found $(node --version))." >&2
  exit 1
fi

echo "install: building GUS in $REPO_DIR (npm install + build)…"
(cd "$REPO_DIR" && npm install --no-audit --no-fund && npm run build)

mkdir -p "$STATE_DIR/logs" "$COMM_DIR" "$WORKSPACE_DIR" "$AGENTS_DIR"
chmod 700 "$GUS_HOME" "$STATE_DIR" "$COMM_DIR"

SEEDED=0
if [ ! -f "$STATE_DIR/policy.json" ]; then
  cp "$REPO_DIR/docs/mac-policy-template.json" "$STATE_DIR/policy.json"
  chmod 600 "$STATE_DIR/policy.json"
  SEEDED=1
  echo
  echo "install: seeded $STATE_DIR/policy.json from the Nova template."
  echo "install: BEFORE GUS can touch files or run shell on this Mac,"
  echo "install: edit \"mac.workDirs\" in that file — replace the"
  echo "install: placeholder \"/Users/you/Projects\" with the real"
  echo "install: project directories GUS may work in. Until then the"
  echo "install: template approves no file or shell access at all."
fi

render() {
  sed \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__STATE_DIR__|$STATE_DIR|g" \
    -e "s|__COMM_DIR__|$COMM_DIR|g" \
    -e "s|__WORKSPACE_DIR__|$WORKSPACE_DIR|g" \
    "$SCRIPT_DIR/$1" > "$AGENTS_DIR/$1"
}

for label in control-plane runtime; do
  plist="com.startekenterprises.gus.$label.plist"
  render "$plist"
  # Reload cleanly if an earlier install is already loaded.
  launchctl bootout "$DOMAIN/com.startekenterprises.gus.$label" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$AGENTS_DIR/$plist"
  echo "install: loaded com.startekenterprises.gus.$label (starts at login)"
done

echo
echo "install: GUS is resident. Remaining first-run steps (docs/mac-resident.md):"
echo "  1. Open the panel at http://127.0.0.1:8731 and run the setup wizard:"
echo "     store the Telegram bot token + provision the Agent-Shield gate."
echo "     Panel token: $STATE_DIR/panel-token"
echo "  2. Confirm Time Machine is ON for this Mac before trusting it"
echo "     with real work (tmutil status)."
echo "  3. Optional log rotation: render hosts/mac-resident/newsyslog-gus.conf"
echo "     with STATE_DIR=$STATE_DIR into /etc/newsyslog.d/gus.conf (sudo)."
if [ "$SEEDED" -eq 1 ]; then
  echo "  4. You seeded a fresh policy — edit mac.workDirs (above), then restart:"
  echo "     launchctl kickstart -k $DOMAIN/com.startekenterprises.gus.control-plane"
fi
