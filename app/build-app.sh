#!/usr/bin/env bash
# Builds Threadbear.app and stages it in ~/Applications (or THREADBEAR_APP_DIR).
#
# THREADBEAR_BUILD_CONFIGURATION  release (default) or debug
# THREADBEAR_SCRATCH_PATH         swift build's scratch path, instead of
#                                 the package's own .build (the app's
#                                 self-update builds in its own one)
# THREADBEAR_SOURCE_CHECKOUT      the checkout recorded in the bundle's
#                                 build.json, whose main the installed app
#                                 follows (default: this script's repo)
set -euo pipefail

# THREADBARE_* was the old name for these variables: each stands in for its new name.
for v in $(compgen -e | grep '^THREADBARE_' || true); do n="THREADBEAR_${v#THREADBARE_}"; [ -n "${!n+x}" ] || export "$n=${!v}"; done
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_CONFIGURATION="${THREADBEAR_BUILD_CONFIGURATION:-release}"
APP_NAME="Threadbear"
BUNDLE_ID="com.mikerosoft.threadbear"
FINAL_DIR="${THREADBEAR_APP_DIR:-$HOME/Applications/$APP_NAME.app}"
STAGE_DIR="$(dirname "$FINAL_DIR")/.$APP_NAME.app.staging"
OLD_DIR="$(dirname "$FINAL_DIR")/.$APP_NAME.app.old"
ICON_SOURCE="$SCRIPT_DIR/icons/threadbear.png"

if ! command -v swift >/dev/null 2>&1; then
  echo "ERROR: swift is not on PATH. Install Xcode or Command Line Tools first."
  exit 1
fi

SCRATCH_ARGS=()
if [[ -n "${THREADBEAR_SCRATCH_PATH:-}" ]]; then
  SCRATCH_ARGS=(--scratch-path "$THREADBEAR_SCRATCH_PATH")
fi
echo "Building Threadbear ($BUILD_CONFIGURATION)..."
# Every dependency is a public download: never ask the keychain for GitHub
# credentials (a background or scripted setup can't answer that prompt, and
# SwiftPM then fails with "status -128").
swift build --disable-keychain --package-path "$SCRIPT_DIR" ${SCRATCH_ARGS[@]+"${SCRATCH_ARGS[@]}"} -c "$BUILD_CONFIGURATION" --product Threadbear
BIN_DIR="$(swift build --package-path "$SCRIPT_DIR" ${SCRATCH_ARGS[@]+"${SCRATCH_ARGS[@]}"} -c "$BUILD_CONFIGURATION" --show-bin-path)"
BINARY="$BIN_DIR/Threadbear"
if [[ ! -x "$BINARY" ]]; then
  echo "ERROR: built binary not found at $BINARY"
  exit 1
fi

echo "Staging $FINAL_DIR..."
mkdir -p "$(dirname "$FINAL_DIR")"
rm -rf "$STAGE_DIR" "$OLD_DIR"
mkdir -p "$STAGE_DIR/Contents/MacOS" "$STAGE_DIR/Contents/Resources"
cp "$BINARY" "$STAGE_DIR/Contents/MacOS/Threadbear"
cp "$SCRIPT_DIR/Resources/Info.plist" "$STAGE_DIR/Contents/Info.plist"
chmod +x "$STAGE_DIR/Contents/MacOS/Threadbear"
# Packages' resource bundles (Highlightr's highlight.js and themes), where
# SwiftPM's Bundle.module looks in an app: Contents/Resources.
for b in "$BIN_DIR"/*.bundle; do if [[ -d "$b" ]]; then cp -R "$b" "$STAGE_DIR/Contents/Resources/"; fi; done

# What this bundle was built from, for the app's self-update
# (AppUpdate.swift): the commit, the tree hash of app/ at it (only a change
# under app/ changes what runs) and the checkout whose main to follow. The
# update script goes in too, so the app runs the copy it was built with.
SOURCE_CHECKOUT="${THREADBEAR_SOURCE_CHECKOUT:-$(cd "$SCRIPT_DIR/.." && pwd -P)}"
COMMIT="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || true)"
SHORT="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || true)"
# app/ and dock/ (BearDock, which the app builds in): a change to either
# changes what runs. The updater reads main's the same way (AppUpdate.swift).
APP_TREE="$(git -C "$SCRIPT_DIR" rev-parse HEAD:app HEAD:dock 2>/dev/null | paste -sd+ - || true)"
# The checkout's origin too: only a build of Mike's own repo reports to his
# Sentry (CrashReporting.swift), never someone's fork.
ORIGIN="$(git -C "$SOURCE_CHECKOUT" remote get-url origin 2>/dev/null || true)"
python3 - "$STAGE_DIR/Contents/Resources/build.json" "$COMMIT" "$SHORT" "$APP_TREE" "$SOURCE_CHECKOUT" "$BUILD_CONFIGURATION" "$ORIGIN" <<'PY'
import json, sys, datetime
path, commit, short, tree, checkout, configuration, origin = sys.argv[1:]
json.dump({
    "commit": commit, "short": short, "appTree": tree, "checkout": checkout,
    "configuration": configuration, "origin": origin,
    "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
}, open(path, "w"), indent=2)
PY
cp "$SCRIPT_DIR/stage-update.sh" "$STAGE_DIR/Contents/Resources/stage-update.sh"
chmod +x "$STAGE_DIR/Contents/Resources/stage-update.sh"

if [[ -f "$ICON_SOURCE" ]]; then
  ICONSET="$(mktemp -d)/threadbear.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$ICON_SOURCE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$ICON_SOURCE" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$STAGE_DIR/Contents/Resources/threadbear.icns"
  rm -rf "$(dirname "$ICONSET")"
fi

# Sign with the first Apple Development identity so the app keeps the same
# identity across rebuilds (notification and other privacy permissions
# stick). Falls back to ad hoc; then the designated requirement is pinned to
# the bundle id, because an ad hoc one is the binary's hash and changes on
# every build.
SIGN_IDENTITY="${THREADBEAR_SIGN_IDENTITY:-$({
  security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' \
    | head -n 1
} || true)}"
SIGNING_REQUIREMENTS=()
if [[ -z "$SIGN_IDENTITY" ]]; then
  SIGN_IDENTITY="-"
  SIGNING_REQUIREMENTS=(--requirements "=designated => identifier \"$BUNDLE_ID\"")
fi
codesign --force --timestamp=none --sign "$SIGN_IDENTITY" \
  ${SIGNING_REQUIREMENTS[@]+"${SIGNING_REQUIREMENTS[@]}"} "$STAGE_DIR" >/dev/null

# Two renames: the old bundle is gone for an instant, never half there.
if [[ -e "$FINAL_DIR" ]]; then mv "$FINAL_DIR" "$OLD_DIR"; fi
mv "$STAGE_DIR" "$FINAL_DIR"
rm -rf "$OLD_DIR"
echo "Built $FINAL_DIR (signed: $SIGN_IDENTITY)"

# Sentry needs the debug symbols to show function names in crash reports.
# Only the release app Mike runs reports (CrashReporting.swift), so only the
# builds that become it upload them: setup_mac.sh's install and the
# self-update's staged bundle (stage-update.sh), not debug, perf or
# screenshot builds. This never fails the build: no sentry-cli or token
# skips it, a failed upload warns.
upload_debug_symbols() {
  local cli token
  cli="$(command -v sentry-cli || true)"
  if [[ -z "$cli" && -x "$HOME/.local/bin/sentry-cli" ]]; then cli="$HOME/.local/bin/sentry-cli"; fi
  token="${SENTRY_AUTH_TOKEN:-}"
  if [[ -z "$token" && -r "$HOME/.config/sentry/token" ]]; then token="$(tr -d '[:space:]' < "$HOME/.config/sentry/token")"; fi
  if [[ -z "$cli" || -z "$token" ]]; then
    echo "Debug symbols not uploaded to Sentry (no sentry-cli or no token)."
    return 0
  fi
  # SwiftPM release builds don't make a dSYM; dsymutil gathers one from the
  # object files the binary points at.
  if ! dsymutil "$BINARY" -o "$BINARY.dSYM" \
    || ! SENTRY_AUTH_TOKEN="$token" "$cli" debug-files upload --org mikec --project threadbear "$BINARY.dSYM"; then
    echo "WARNING: debug symbols weren't uploaded to Sentry; crash reports from this build won't show function names."
  fi
}
# Only a build of Mike's own repo, like CrashReporting.swift: a fork's
# machine might have a sentry-cli and token of its own, and its symbols
# don't belong in Mike's project.
is_mikes_repo() {
  local key
  key="$(printf '%s' "$ORIGIN" | tr '[:upper:]' '[:lower:]')"
  key="${key#*://}"; key="${key#*@}"; key="${key/://}"; key="${key%/}"; key="${key%.git}"
  [[ "$key" == "github.com/mikecann/threadbear" ]]
}
if [[ "$BUILD_CONFIGURATION" == "release" ]] && is_mikes_repo \
  && [[ ( "$FINAL_DIR" == "$HOME/Applications/$APP_NAME.app" || "$FINAL_DIR" == "$HOME/Applications/.$APP_NAME.app.next" ) ]]; then
  upload_debug_symbols || true
fi
