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
#   4. Verifies the loose app icon actually rode along in the
#      exported .ipa (v0.17.0) — the file present at the bundle
#      root, a plausible size for the photographic art, and the
#      CFBundleIconFiles wiring in the bundled Info.plist —
#      failing loudly otherwise. A placeholder icon never
#      ships silently again.
#   5. Emits the deterministic pair the publish tool requires —
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

# v0.40.0: preserve this attempt's archive log per version. The
# build command redirects this script's output to
# /tmp/gus-archive.log, and the NEXT attempt truncates that file
# on launch — which destroyed the v0.38.1 attempt's final error
# before it could be read. On exit (success or fail — the EXIT
# trap below runs either way, fail() included), copy the log to
# /tmp/gus-archive-$VERSION.log so each version's latest attempt
# survives later attempts. Best-effort and silent: the copy emits
# nothing and a failed copy changes nothing about the build.
ARCHIVE_LOG=/tmp/gus-archive.log
preserve_archive_log() {
  [ -f "$ARCHIVE_LOG" ] && cp "$ARCHIVE_LOG" "/tmp/gus-archive-$VERSION.log" 2>/dev/null || true
}

# v0.41.0: prune the preserved per-version logs — keep only
# the newest 6 gus-archive-<version>.log files in /tmp and
# delete the older ones, so a long run of build attempts
# doesn't grow an archive of archives. Newest by modification
# time (ls -t, newest first; tail -n +7 skips the six to
# keep). The preserve above runs first in the same EXIT trap,
# so this attempt's own log was just refreshed and is never
# the one pruned. The glob requires the -<version> segment,
# so the live /tmp/gus-archive.log itself never matches.
# Best-effort and silent, like the copy: a failed prune
# changes nothing about the build.
prune_archive_logs() {
  ls -t /tmp/gus-archive-*.log 2>/dev/null | tail -n +7 | while IFS= read -r old_log; do
    rm -f "$old_log" 2>/dev/null || true
  done || true
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; preserve_archive_log; prune_archive_logs' EXIT
ARCHIVE="$WORK/$SCHEME.xcarchive"
EXPORT_DIR="$WORK/export"

# --- 1.5 app icon (v0.14.5; loose files since v0.17.0) ------------------
# The icon master rides the repo as base64 text (the push path is
# text-only — the same pattern as the Mac app's .b64 assets).
# Decode it once, here. The asset catalog still gets its
# AppIcon-1024.png (its Contents.json names the file and actool
# fails without it, and the Avatar imageset needs the catalog),
# but the icon the PHONE renders no longer comes from the
# catalog: the catalog-compiled icon shipped as the system
# placeholder on the operator's phone even though the master,
# the Info.plist CFBundleIconName, and the rendition names all
# checked out (v0.16.3 — the root cause inside actool was not
# worth more time). Instead the app ships loose icon PNGs, the
# classic pre-catalog wiring and the same shape as the Mac's
# .icns path: the app Info.plist (apps/ios/Info.plist) names them in CFBundleIconFiles,
# the synchronized App group copies them to the bundle root,
# and section 4 below verifies they landed in the .ipa.
# Every decoded/generated PNG is a build artifact (gitignored),
# never a source.
ICON_B64="$PROJECT_DIR/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png.b64"
if [ -f "$ICON_B64" ]; then
  ICON_MASTER="$WORK/icon-1024.png"
  base64 -d < "$ICON_B64" > "$ICON_MASTER" \
    || fail "decoding the app icon from $ICON_B64 failed."
  cp "$ICON_MASTER" "$PROJECT_DIR/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png" \
    || fail "staging the catalog icon from the decoded master failed."
  for spec in "180:AppIcon60x60@3x.png" "120:AppIcon60x60@2x.png" "167:AppIcon83.5x83.5@2x.png" "152:AppIcon76x76@2x.png"; do
    px="${spec%%:*}"; name="${spec##*:}"
    sips -z "$px" "$px" "$ICON_MASTER" --out "$PROJECT_DIR/App/$name" >/dev/null \
      || fail "sips failed building the loose icon $name"
  done
  cp "$ICON_MASTER" "$PROJECT_DIR/App/AppIcon1024.png" \
    || fail "staging the loose AppIcon1024.png failed."
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
# v0.20.0: the second stock avatar (the girl) rides the same
# way, in her own imageset — Settings picks between the pair
# (gus.avatar.stock); the boy above is the default.
AVATAR_GIRL_B64="$PROJECT_DIR/App/Assets.xcassets/AvatarGirl.imageset/AvatarGirl.png.b64"
if [ -f "$AVATAR_GIRL_B64" ]; then
  base64 -d < "$AVATAR_GIRL_B64" > "$PROJECT_DIR/App/Assets.xcassets/AvatarGirl.imageset/AvatarGirl.png" \
    || fail "decoding the second call-screen avatar from $AVATAR_GIRL_B64 failed."
fi
# v0.31.0: the per-persona portraits ride the same way, each in
# its own imageset (PersonaFace in LocalBrain.swift names them:
# the active persona's face is what the call screen and the
# picker show). One loop, the established pattern per face.
# v0.32.0: the roster consolidated — the Email and Shield faces
# retired with their starters (folded into the one Gus persona,
# who wears the stock boy above); five persona portraits remain.
# v0.46.0: a NEW Shield face joins them — the restored Agent
# Shield persona's own portrait (not the retired v0.31.0 art).
for PERSONA_FACE in Priest Devil Therapist Debbie Doctor Shield; do
  PERSONA_B64="$PROJECT_DIR/App/Assets.xcassets/Avatar$PERSONA_FACE.imageset/Avatar$PERSONA_FACE.png.b64"
  if [ -f "$PERSONA_B64" ]; then
    base64 -d < "$PERSONA_B64" > "$PROJECT_DIR/App/Assets.xcassets/Avatar$PERSONA_FACE.imageset/Avatar$PERSONA_FACE.png" \
      || fail "decoding the $PERSONA_FACE persona avatar from $PERSONA_B64 failed."
  fi
done

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

# --- 4. verify the loose icon rode along (v0.17.0) -----------------------
# The failure this guards against is silent: a build that
# compiles, signs, and installs — with a placeholder where the
# icon belongs. Unzip the exported .ipa and demand the phone's
# icon file at a plausible size for photographic art, plus the
# CFBundleIconFiles wiring in the bundled Info.plist. Anything
# less fails the build here, by name, before the pair is
# emitted — a bad build leaves nothing publishable behind.
VERIFY_DIR="$WORK/verify"
mkdir -p "$VERIFY_DIR"
unzip -o -q "$1" -d "$VERIFY_DIR" \
  || fail "could not unzip the exported .ipa to verify the icon — refusing to emit an unverified pair."
APP_IN_IPA="$VERIFY_DIR/Payload/$SCHEME.app"
ICON_IN_IPA="$APP_IN_IPA/AppIcon60x60@3x.png"
[ -f "$ICON_IN_IPA" ] || fail "the exported app has no AppIcon60x60@3x.png at its root — the loose-icon wiring (Info.plist CFBundleIconFiles + the PNGs generated in step 1.5) did not reach the bundle. Refusing to ship a placeholder icon."
ICON_BYTES=$(stat -f %z "$ICON_IN_IPA")
[ "$ICON_BYTES" -ge 20480 ] || fail "AppIcon60x60@3x.png in the exported app is $ICON_BYTES bytes — implausibly small for the photographic icon art (a placeholder is not); refusing to ship it."
plutil -extract CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconFiles xml1 -o - "$APP_IN_IPA/Info.plist" 2>/dev/null | grep -q "AppIcon60x60" \
  || fail "the exported app's Info.plist does not name AppIcon60x60 in CFBundleIconFiles — the physical Info.plist wiring did not reach the bundle."
echo "build-ipa: icon verified in the exported .ipa — AppIcon60x60@3x.png ($ICON_BYTES bytes) + CFBundleIconFiles wiring."

# --- 5. emit the pair ---------------------------------------------------
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
