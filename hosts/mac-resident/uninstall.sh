#!/bin/sh
# GUS — Mac resident uninstall (Phase 7).
#
# Stops and unloads both launchd agents and removes their plists.
# State is deliberately LEFT in place: the vault, the Governor
# ledger, the approval history, and the policy file are the
# operator's records. Deleting them is one explicit command, printed
# below, and it is yours to run — not this script's.
set -eu

GUS_HOME=${GUS_HOME:-"$HOME/.gus"}
AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

for label in control-plane runtime; do
  launchctl bootout "$DOMAIN/com.startekenterprises.gus.$label" 2>/dev/null || true
  rm -f "$AGENTS_DIR/com.startekenterprises.gus.$label.plist"
  echo "uninstall: com.startekenterprises.gus.$label stopped and unloaded"
done

echo
echo "uninstall: GUS no longer starts at login. State kept at:"
echo "  $GUS_HOME"
echo "To erase it (vault, ledger, approvals, policy — gone for good):"
echo "  rm -rf \"$GUS_HOME\""
