#!/bin/sh
# GUS — build GUS-<version>.dmg (Phase 8). RUNS ON A MAC.
#
#   sh hosts/mac-app/build-dmg.sh
#
# What it does:
#   1. Verifies the toolchain (Xcode Command Line Tools: swift,
#      codesign, hdiutil) and Node >= 22 — failing loudly, by name,
#      when something is missing. Nothing is half-built silently.
#   2. Installs workspace deps (npm install — a release that adds a
#      workspace package needs its node_modules/@gus/* symlink created
#      before tsc can resolve it), builds the GUS control plane +
#      runtime (npm run build) and the Swift app + helper
#      (swift build -c release).
#   3. Assembles GUS.app (bundle id com.startekenterprises.gus):
#        Contents/MacOS/GUS              the menu-bar app
#        Contents/Helpers/GusMacHost     the native host helper
#        Contents/Resources/gus/         the Node payload: every
#          package's dist/, node_modules/@gus/* as relative symlinks
#          back into it (GUS dependencies are workspace-internal —
#          the one exception is the bundled Kokoro voice engine,
#          whose third-party runtime deps are installed into its
#          own payload directory by a scoped step below), the Nova
#          policy template, and the launchd plist templates.
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
echo "build-dmg: installing workspace dependencies (npm install)…"
(cd "$REPO_DIR" && npm install)

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

# App icon (v0.14.7): icon candidate #8 — a bold white G
# in the same font and look as Muse's M: rounded geometric
# letterform on deep navy, the operator's explicit call
# (an homage: GUS is currently configured with Meta Muse
# Spark). Generated for this build and replaced pre-release
# along the way: a raven (#4), a falcon (#5), the scanner
# ring (#6, from the Nth Degree direction), and a G built
# from spears (#7, his idea, generated and admired — the
# Muse G superseded it the same evening). History: the
# v0.11.1 icon (Logo B, a geometric G) was rejected in the
# dock for reading as another product's G and rendering
# square; v0.12.0 shipped the Avatar A character on a tile;
# v0.14.0 brought the lifelike portrait forward; v0.14.5
# shipped the steel owl emblem (candidate #2); v0.14.6 the
# eagle shield (candidate #3); the rotation rule (a new
# candidate every build until one looks great) brings the
# scanner ring. v0.17.0 replaced the master: the previous one
# was the full-bleed Nova avatar art itself, so the Dock icon
# read square (an older note here claimed rounded corners
# were baked into it — they were not; the art ran edge to
# edge with opaque corners). The current master is that same
# avatar art composited onto Apple's icon template — an
# 824px rounded tile centered in the 1024px canvas,
# transparent outside the tile — so the shipped icon reads
# rounded everywhere. The master rides in the repo as base64
# text (the push path is text-only); decode it, resize with
# sips, and let iconutil build the .icns.
ICONSET=$(mktemp -d)/AppIcon.iconset
mkdir -p "$ICONSET"
base64 -d < "$SCRIPT_DIR/Resources/AppIcon-1024.png.b64" > "$(dirname "$ICONSET")/icon-1024.png"
for spec in "16:icon_16x16.png" "32:icon_16x16@2x.png" "32:icon_32x32.png" "64:icon_32x32@2x.png" "128:icon_128x128.png" "256:icon_128x128@2x.png" "256:icon_256x256.png" "512:icon_256x256@2x.png" "512:icon_512x512.png" "1024:icon_512x512@2x.png"; do
  px="${spec%%:*}"; name="${spec##*:}"
  sips -z "$px" "$px" "$(dirname "$ICONSET")/icon-1024.png" --out "$ICONSET/$name" >/dev/null || fail "sips failed building $name"
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" || fail "iconutil failed building AppIcon.icns"

# Default avatar (v0.14.7): avatar candidate #6 — the
# operator's own Nova avatar, used exactly. It is his
# design: a mustard-yellow plush character with eight arms
# holding envelopes, a stamp, a tag, paper, a stamp tool,
# and a binder clip — the many-armed mail handler, which
# turned out to be the very concept he reached for twice
# (the Men-in-Black sorting-machine alien, and "use my
# Nova avatar"). The twins consideration (GUS and Nova
# sharing a face) was raised and he chose exactly anyway.
# The rotation that led here: lifelike portrait → owl #1
# → phoenix #2 → raven #3 → falcon #4 → the Nth Degree
# operator #5 (generated with thinking still + idle loop;
# that direction still owns the Watch view's chair scene
# and the persona framing — see
# files/gus-avatar-nth-degree-direction-2026-11-19.md in
# the goal workspace) → this, his own character.
# Avatar A (v0.11.1, the Commons poll's pick) rides along as
# the bundled fallback asset (DefaultAvatarA.png) in case the
# portrait ever fails to load.
# Both ride as base64 text like the icon master; the app loads
# them from Contents/Resources via Bundle.main
# (DesktopModel.defaultAvatarImage / fallbackAvatarImage).
base64 -d < "$SCRIPT_DIR/Resources/DefaultAvatar.png.b64" > "$APP/Contents/Resources/DefaultAvatar.png" || fail "decoding the bundled default avatar failed"
base64 -d < "$SCRIPT_DIR/Resources/DefaultAvatarA.png.b64" > "$APP/Contents/Resources/DefaultAvatarA.png" || fail "decoding the bundled fallback avatar failed"

PAYLOAD="$APP/Contents/Resources/gus"
cp "$REPO_DIR/package.json" "$PAYLOAD/package.json"
for pkg in shared gate vault egress panel control-plane runtime kokoro-local; do
  mkdir -p "$PAYLOAD/packages/$pkg"
  cp -R "$REPO_DIR/packages/$pkg/dist" "$PAYLOAD/packages/$pkg/dist"
  cp "$REPO_DIR/packages/$pkg/package.json" "$PAYLOAD/packages/$pkg/package.json"
done
mkdir -p "$PAYLOAD/packages/channels/telegram"
cp -R "$REPO_DIR/packages/channels/telegram/dist" "$PAYLOAD/packages/channels/telegram/dist"
cp "$REPO_DIR/packages/channels/telegram/package.json" "$PAYLOAD/packages/channels/telegram/package.json"
mkdir -p "$PAYLOAD/packages/channels/voice"
cp -R "$REPO_DIR/packages/channels/voice/dist" "$PAYLOAD/packages/channels/voice/dist"
cp "$REPO_DIR/packages/channels/voice/package.json" "$PAYLOAD/packages/channels/voice/package.json"

# Workspace-internal module resolution inside the bundle: Node finds
# @gus/* through these relative symlinks, exactly like the repo's
# npm-workspaces layout.
mkdir -p "$PAYLOAD/node_modules/@gus"
for pkg in shared gate vault egress panel control-plane runtime kokoro-local; do
  ln -s "../../packages/$pkg" "$PAYLOAD/node_modules/@gus/$pkg"
done
ln -s "../../packages/channels/telegram" "$PAYLOAD/node_modules/@gus/telegram"
ln -s "../../packages/channels/voice" "$PAYLOAD/node_modules/@gus/voice"

# Bundled Kokoro engine deps (v0.17.2): @gus/kokoro-local is the
# one package with third-party runtime dependencies (kokoro-js →
# @huggingface/transformers → onnxruntime-node, whose platform
# binaries ship inside its npm tarball — no install-time download
# on darwin; its postinstall only fetches CUDA binaries on Linux,
# so --ignore-scripts loses nothing and matches the verified
# install). Install them STANDALONE in a scratch dir — running
# npm inside the payload would read the payload root's workspaces
# field and try to install the whole workspace tree — then copy
# the resulting node_modules into the package's payload dir,
# where the spawned server resolves them. The model itself is
# NOT bundled: it downloads on first enable into ~/.gus/models.
echo "build-dmg: installing the bundled Kokoro engine's dependencies…"
KOKORO_DEPS=$(mktemp -d)
cp "$REPO_DIR/packages/kokoro-local/package.json" "$KOKORO_DEPS/package.json"
(cd "$KOKORO_DEPS" && npm install --omit=dev --ignore-scripts --no-audit --no-fund) \
  || fail "installing @gus/kokoro-local's dependencies failed — the bundled voice engine would ship broken; failing the build instead."
mkdir -p "$PAYLOAD/packages/kokoro-local/node_modules"
cp -R "$KOKORO_DEPS/node_modules/." "$PAYLOAD/packages/kokoro-local/node_modules/"
rm -rf "$KOKORO_DEPS"
# Prune the onnxruntime binaries for platforms this DMG can never
# run on (each is ~35 MB); darwin x64 + arm64 both stay.
find "$PAYLOAD/packages/kokoro-local/node_modules" -type d -path "*onnxruntime-node/bin/napi-v3/win32" -exec rm -rf {} + 2>/dev/null || true
find "$PAYLOAD/packages/kokoro-local/node_modules" -type d -path "*onnxruntime-node/bin/napi-v3/linux" -exec rm -rf {} + 2>/dev/null || true

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
# The in-app updater requires the DMG's sha256 as a sibling release
# asset (any name ending .dmg.sha256; it reads the first token).
shasum -a 256 "$DMG" > "$DMG.sha256"
echo "build-dmg: done — $DMG"
echo "build-dmg: checksum — $DMG.sha256 (attach BOTH files to the GitHub release; the updater refuses a DMG without its checksum)"
echo "build-dmg: first launch on a new Mac is right-click → Open (ad-hoc"
echo "build-dmg: signing, not notarization). Then grant Accessibility in"
echo "build-dmg: System Settings and run the setup window's checklist."
