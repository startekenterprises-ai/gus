#!/bin/sh
# GUS — build GUS-<version>.dmg (Phase 8). RUNS ON A MAC.
#
#   sh hosts/mac-app/build-dmg.sh
#
# What it does:
#   1. Verifies the toolchain (Xcode Command Line Tools: swift,
#      codesign, hdiutil) and Node >= 22 — failing loudly, by name,
#      when something is missing. Nothing is half-built silently.
#   2. Builds the GUS control plane + runtime (npm run build) and
#      the Swift app + helper (swift build -c release).
#   3. Assembles GUS.app (bundle id com.startekenterprises.gus):
#        Contents/MacOS/GUS              the menu-bar app
#        Contents/Helpers/GusMacHost     the native host helper
#        Contents/Resources/gus/         the Node payload: every
#          package's dist/, node_modules/@gus/* as relative symlinks
#          back into it (all GUS dependencies are workspace-internal
#          — there is nothing third-party to bundle), the Nova policy
#          template, and the launchd plist templates.
#   4. Ad-hoc codesigns the bundle (codesign --sign -) and builds
#      dist/GUS-<version>.dmg with hdiutil (app + /Applications
#      symlink, drag-to-install).
#
# Honest v1 signing note: ad-hoc is NOT notarization. First launch
# on another Mac is right-click → Open (Gatekeeper), and the helper
# inherits that trust decision. Notarized distribution needs an
# Apple Developer account — a later, deliberate step
# (docs/mac-app.md).
set -eu

fail() { echo "build-dmg: $1" >&2; exit 1; }

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)
OUT_DIR="$SCRIPT_DIR/dist"

# --- 1. toolchain -------------------------------------------------
[ "$(uname)" = "Darwin" ] || fail "this script builds a macOS app and must run on a Mac (this is $(uname)). The DMG is built in the install sitting — docs/mac-app.md."
command -v swift >/dev/null 2>&1 || fail "swift was not found. Install the Xcode Command Line Tools:  xcode-select --install"
command -v codesign >/dev/null 2>&1 || fail "codesign was not found. Install the Xcode Command Line Tools:  xcode-select --install"
command -v hdiutil >/dev/null 2>&1 || fail "hdiutil was not found — it ships with macOS; this environment cannot package a DMG."
NODE_BIN=$(command -v node || true)
[ -n "$NODE_BIN" ] || fail "Node.js >= 22 is required to build the GUS control plane and was not found on PATH."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js >= 22 is required (found $(node --version))."

VERSION=$(node -p "require('$REPO_DIR/package.json').version")
BUILD=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d)
echo "build-dmg: GUS $VERSION (build $BUILD)"

# --- 2. builds ------------------------------------------------------
echo "build-dmg: building the control plane + runtime (npm run build)…"
(cd "$REPO_DIR" && npm run build)

echo "build-dmg: building the Swift app + helper (swift build -c release)…"
(cd "$SCRIPT_DIR" && swift build -c release)
BIN_DIR=$(cd "$SCRIPT_DIR" && swift build -c release --show-bin-path)
[ -x "$BIN_DIR/GUS" ] || fail "swift build did not produce the GUS app binary at $BIN_DIR/GUS"
[ -x "$BIN_DIR/GusMacHost" ] || fail "swift build did not produce the GusMacHost helper at $BIN_DIR/GusMacHost"

# --- 3. assemble GUS.app ---------------------------------------------
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/GUS.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources/gus"

cp "$BIN_DIR/GUS" "$APP/Contents/MacOS/GUS"
cp "$BIN_DIR/GusMacHost" "$APP/Contents/Helpers/GusMacHost"

sed -e "s/__VERSION__/$VERSION/g" -e "s/__BUILD__/$BUILD/g" \
  "$SCRIPT_DIR/Resources/Info.plist" > "$APP/Contents/Info.plist"

PAYLOAD="$APP/Contents/Resources/gus"
cp "$REPO_DIR/package.json" "$PAYLOAD/package.json"
for pkg in shared gate vault egress panel control-plane runtime; do
  mkdir -p "$PAYLOAD/packages/$pkg"
  cp -R "$REPO_DIR/packages/$pkg/dist" "$PAYLOAD/packages/$pkg/dist"
  cp "$REPO_DIR/packages/$pkg/package.json" "$PAYLOAD/packages/$pkg/package.json"
done
mkdir -p "$PAYLOAD/packages/channels/telegram"
cp -R "$REPO_DIR/packages/channels/telegram/dist" "$PAYLOAD/packages/channels/telegram/dist"
cp "$REPO_DIR/packages/channels/telegram/package.json" "$PAYLOAD/packages/channels/telegram/package.json"

# Workspace-internal module resolution inside the bundle: Node finds
# @gus/* through these relative symlinks, exactly like the repo's
# npm-workspaces layout.
mkdir -p "$PAYLOAD/node_modules/@gus"
for pkg in shared gate vault egress panel control-plane runtime; do
  ln -s "../../packages/$pkg" "$PAYLOAD/node_modules/@gus/$pkg"
done
ln -s "../../packages/channels/telegram" "$PAYLOAD/node_modules/@gus/telegram"

mkdir -p "$PAYLOAD/docs" "$PAYLOAD/hosts/mac-resident"
cp "$REPO_DIR/docs/mac-policy-template.json" "$PAYLOAD/docs/mac-policy-template.json"
cp "$REPO_DIR"/hosts/mac-resident/com.startekenterprises.gus.*.plist "$PAYLOAD/hosts/mac-resident/"

# --- 4. sign + package -------------------------------------------------
echo "build-dmg: ad-hoc codesigning GUS.app…"
codesign --force --deep --sign - "$APP"
codesign --verify --verbose "$APP" || fail "codesign verification failed — the bundle is not signed; not packaging a broken app."

mkdir -p "$OUT_DIR"
DMG_STAGE="$STAGE/dmg"
mkdir -p "$DMG_STAGE"
cp -R "$APP" "$DMG_STAGE/GUS.app"
ln -s /Applications "$DMG_STAGE/Applications"

DMG="$OUT_DIR/GUS-$VERSION.dmg"
rm -f "$DMG"
echo "build-dmg: creating ${DMG} ..."
hdiutil create -volname "GUS $VERSION" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG"

echo
echo "build-dmg: done — $DMG"
echo "build-dmg: first launch on a new Mac is right-click → Open (ad-hoc"
echo "build-dmg: signing, not notarization). Then grant Accessibility in"
echo "build-dmg: System Settings and run the setup window's checklist."
