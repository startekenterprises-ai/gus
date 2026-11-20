#!/bin/sh
# GUS — build GUS-<version>.ipa (v0.15.0). RUNS ON A MAC.
#
#   sh hosts/ios-app/build-ipa.sh
#
# The scripted equivalent of the operator's Organizer flow
# (Archive → Distribute App → Release Testing → Export → AirDrop):
#
#   1. Verifies the toolchain (full Xcode: xcodebuild) and
#      Node >= 22 — failing loudly, by name, when something is
#      missing. Nothing is half-built silently.
#   2. Archives the iOS app (xcodebuild archive, Release
#      configuration, generic iOS destination, automatic signing
#      with provisioning updates allowed — the CLI form of the
#      Organizer's automatic-signing archive).
#   3. Exports the .ipa with xcodebuild -exportArchive against
#      the project's ExportOptions.plist (method release-testing:
#      an ad-hoc build for the operator's registered devices —
#      NOT an App Store / TestFlight upload).
#   4. Emits the deterministic pair the publish tool requires —
#      <project>/dist/GUS-<version>.ipa and its .sha256 sibling —
#      ready for github_publish_release {tag, ipaPath, shaPath}.
#
# Parameterized on purpose (the plumbing must survive the app):
# the defaults point at apps/ios, the unified R4 app (v0.15.0,
# "the front door"). The old companion (apps/companion) is
# RETIRED — do not build it. To build a different app, point the
# three variables below at its project — this script does not
# change:
#
#   GUS_IOS_PROJECT_DIR    the app project directory
#                          (default: <repo>/apps/ios)
#   GUS_IOS_PROJECT_PATH   the .xcodeproj to build
#                          (default: $GUS_IOS_PROJECT_DIR/GUS.xcodeproj)
#   GUS_IOS_SCHEME         the shared scheme to archive
#                          (default: GUS)
#   GUS_IOS_EXPORT_OPTIONS the export options plist
#                          (default: $GUS_IOS_PROJECT_DIR/ExportOptions.plist)
#   GUS_IOS_OUT_DIR        where the .ipa pair lands
#                          (default: $GUS_IOS_PROJECT_DIR/dist)
#   GUS_IOS_CONFIGURATION  build configuration (default: Release)
#
# First-run note: this script was written Nova-side and gets its
# first real run on the operator's iMac. Expected first-run
# friction, all of it loud rather than silent: the shared scheme
# (committed with v0.14.2) must be visible to xcodebuild, and
# automatic signing may ask for the signing keychain's "Always
# Allow" once. Neither is worked around here — a build that
# cannot sign says so and stops.
set -eu

fail() { echo "build-ipa: $1" >&2; exit 1; }

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)

PROJECT_DIR="${GUS_IOS_PROJECT_DIR:-$REPO_DIR/apps/ios}"
PROJECT_PATH="${GUS_IOS_PROJECT_PATH:-$PROJECT_DIR/GUS.xcodeproj}"
SCHEME="${GUS_IOS_SCHEME:-GUS}"
EXPORT_OPTIONS="${GUS_IOS_EXPORT_OPTIONS:-$PROJECT_DIR/ExportOptions.plist}"
OUT_DIR="${GUS_IOS_OUT_DIR:-$PROJECT_DIR/dist}"
CONFIGURATION="${GUS_IOS_CONFIGURATION:-Release}"

# --- 1. toolchain -------------------------------------------------
[ "$(uname)" = "Darwin" ] || fail "this script builds an iOS app and must run on a Mac (this is $(uname)). The .ipa is built in the install sitting."
command -v xcodebuild >/dev/null 2>&1 || fail "xcodebuild was not found. Install Xcode (the full app — the Command Line Tools alone cannot archive an iOS app)."
[ -d "$PROJECT_PATH" ] || fail "the Xcode project was not found at $PROJECT_PATH — set GUS_IOS_PROJECT_PATH if the app has moved."
[ -f "$EXPORT_OPTIONS" ] || fail "the export options plist was not found at $EXPORT_OPTIONS — set GUS_IOS_EXPORT_OPTIONS if it has moved."
NODE_BIN=$(command -v node || true)
[ -n "$NODE_BIN" ] || fail "Node.js >= 22 is required to read the release version and was not found on PATH."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js >= 22 is required (found $(node --version))."

VERSION=$(node -p "require('$REPO_DIR/package.json').version")
BUILD=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d)
echo "build-ipa: GUS $VERSION (build $BUILD) — scheme $SCHEME, $CONFIGURATION"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
ARCHIVE="$WORK/$SCHEME.xcarchive"
EXPORT_DIR="$WORK/export"

# --- 1.5 app icon (v0.14.5) -------------------------------------------
# The icon master rides the repo as base64 text (the push path is
# text-only — the same pattern as the Mac app's .b64 assets);
# decode it into the appiconset the asset catalog compiles. The
# decoded PNG is a build artifact (gitignored), never a source.
ICON_B64="$PROJECT_DIR/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png.b64"
if [ -f "$ICON_B64" ]; then
  base64 -d < "$ICON_B64" > "$PROJECT_DIR/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png" \
    || fail "decoding the app icon from $ICON_B64 failed."
fi

# --- 1.6 call-screen avatar (v0.15.5) ----------------------------------
# The animated avatar on the call screen is the same master art
# as the icon, riding the repo the same way: its own .b64 in its
# own imageset, decoded by the same step into the PNG the asset
# catalog compiles. Same rule: the decoded PNG is a build
# artifact (gitignored), never a source.
AVATAR_B64="$PROJECT_DIR/App/Assets.xcassets/Avatar.imageset/Avatar.png.b64"
if [ -f "$AVATAR_B64" ]; then
  base64 -d < "$AVATAR_B64" > "$PROJECT_DIR/App/Assets.xcassets/Avatar.imageset/Avatar.png" \
    || fail "decoding the call-screen avatar from $AVATAR_B64 failed."
fi

# --- 2. archive -----------------------------------------------------
echo "build-ipa: archiving $SCHEME ($CONFIGURATION)…"
# -skipMacroValidation: LLM.swift ships a swift-syntax macro target
# (LLMMacrosImplementation). Xcode's macro trust gate refuses CLI
# builds with "Macro … must be enabled before it can be used" unless
# the plugin was enabled once in the GUI; this flag is Apple's CLI
# bypass (first hit 2026-11-19, chunk 2's first archive).
xcodebuild archive \
  -project "$PROJECT_PATH" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  -skipMacroValidation \
  || fail "xcodebuild archive failed — the output above names the failing step; nothing was exported."
[ -d "$ARCHIVE" ] || fail "xcodebuild reported success but no archive exists at $ARCHIVE — refusing to export air."

# --- 3. export --------------------------------------------------------
echo "build-ipa: exporting the .ipa (release-testing)…"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates \
  || fail "xcodebuild -exportArchive failed — the output above names the failing step; nothing was emitted."
set -- "$EXPORT_DIR"/*.ipa
[ -f "$1" ] || fail "the export produced no .ipa in $EXPORT_DIR — refusing to emit an empty pair."
[ "$#" -eq 1 ] || fail "the export produced $# .ipa files — expected exactly one; refusing to guess which is the release."

# --- 4. emit the pair ---------------------------------------------------
mkdir -p "$OUT_DIR"
IPA="$OUT_DIR/GUS-$VERSION.ipa"
cp "$1" "$IPA"

echo
# The publish tool requires the .ipa's sha256 as a sibling asset
# (any name ending .ipa.sha256; it reads the first token and the
# file it names) — the same pair discipline as the Mac DMG.
shasum -a 256 "$IPA" > "$IPA.sha256"
echo "build-ipa: done — $IPA"
echo "build-ipa: checksum — $IPA.sha256 (attach BOTH files to the GitHub release — github_publish_release {ipaPath, shaPath} does exactly that)"
echo "build-ipa: this is a release-testing (ad-hoc) build for registered devices: AirDrop it to the phone and install. It is not an App Store or TestFlight upload."
