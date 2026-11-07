#!/bin/zsh
# Archive a Release build of Threadbear for iOS, export it for App Store Connect and (with UPLOAD=1)
# upload it. Signing is automatic and cloud-managed, through the App Store Connect API key in
# ~/.config/poddle (no Xcode account or local distribution certificate needed).
#
#   ios/scripts/appstore-upload.sh            archive, export and validate a signed .ipa; no upload
#   UPLOAD=1 ios/scripts/appstore-upload.sh   archive, export, then upload it to App Store Connect
#   UPLOAD=1 BUILD_NUMBER=<b> ios/scripts/appstore-upload.sh
#                                             upload a build already archived in OUT, without
#                                             archiving it again
#
# Each run gets a new build number, the UTC time as YYMMDDHHMM (always increasing), unless
# BUILD_NUMBER is set, like Walkies' and Quick Ask's (this script is theirs, copied). The version
# (MARKETING_VERSION, 1.0.0) comes from the project. Everything lands in OUT (default
# /tmp/threadbear-appstore/<build>); if OUT already has Threadbear.xcarchive, that archive is used.
#
# `altool --validate-app` runs without UPLOAD=1 (VALIDATE=0 skips it) and is skipped with it, as
# the upload validates the build anyway: on 7 Nov it sat silent for 8+ minutes while the upload on
# its own took two and came back VALID. VALIDATE=1 runs it before an upload too. It gets
# VALIDATE_TIMEOUT seconds (default 300); running out is a warning, not a failure.
# The API key is Poddle's team-wide one (same team), read from ~/.config/poddle and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

ASC_KEY_ID=${ASC_KEY_ID:-7SS6J9F98P}
ASC_ISSUER_ID=${ASC_ISSUER_ID:-69a6de6f-a06e-47e3-e053-5b8c7c11a4d1}
KEY_DIR=${KEY_DIR:-$HOME/.config/poddle}
ASC_KEY="$KEY_DIR/AuthKey_$ASC_KEY_ID.p8"
TEAM_ID=4DTAZSZL6B
BUILD=${BUILD_NUMBER:-$(date -u +%y%m%d%H%M)}
OUT=${OUT:-/tmp/threadbear-appstore/$BUILD}
DD=${DD:-/tmp/threadbear-dd-appstore}
ARCHIVE="$OUT/Threadbear.xcarchive"

[[ -f "$ASC_KEY" ]] || { echo "No App Store Connect API key at $ASC_KEY" >&2; exit 1; }
auth=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY"
  -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
mkdir -p "$OUT"

# The export options: App Store Connect distribution, Xcode-managed (cloud) signing.
export_options() {
  cat > "$OUT/ExportOptions-$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$1</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
  echo "$OUT/ExportOptions-$1.plist"
}

if [[ -f "$ARCHIVE/Info.plist" ]]; then
  # A build archived by an earlier run (say its validate step hung): upload that, not a rebuild.
  echo "Using the archive already at $ARCHIVE"
else
  rm -rf "$ARCHIVE"
  echo "Archiving Release for iOS, build number $BUILD…"
  xcodebuild archive -project Threadbear.xcodeproj -scheme Threadbear -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -derivedDataPath "$DD" \
    CURRENT_PROJECT_VERSION="$BUILD" THREADBEAR_APS_ENVIRONMENT=production "${auth[@]}" > "$OUT/archive.log" 2>&1 \
    || { grep -E " error:|ARCHIVE FAILED" "$OUT/archive.log" >&2; echo "Archive failed, see $OUT/archive.log" >&2; exit 1; }
fi
VERSION=$(/usr/libexec/PlistBuddy -c "Print :ApplicationProperties:CFBundleShortVersionString" "$ARCHIVE/Info.plist")
# A reused archive carries its own build number, whatever BUILD_NUMBER said.
BUILD=$(/usr/libexec/PlistBuddy -c "Print :ApplicationProperties:CFBundleVersion" "$ARCHIVE/Info.plist")
echo "Archived Threadbear $VERSION ($BUILD)"
# The App Store build knows no deployment of Mike's (it only has what it's paired with), has none
# of the Debug-only launch arguments in it (the sample threads and -ThreadbearFake stay: they're
# the demo App Review uses), pushes through production APNs, and has its privacy manifest.
APPDIR="$ARCHIVE/Products/Applications/Threadbear.app"
BINARY="$APPDIR/Threadbear"
if strings "$BINARY" | grep -qE "[a-z]+-[a-z]+-[0-9]{3}\.convex\.(cloud|site)"; then
  echo "The archive mentions a Convex deployment. Pairing should be the only way it learns one." >&2; exit 1
fi
if strings "$BINARY" | grep -qE "ThreadbearPair|ThreadbearOpen|ThreadbearCompose"; then
  echo "The archive has the Debug-only launch arguments in it. Is it a Release build?" >&2; exit 1
fi
APS=$(/usr/libexec/PlistBuddy -c "Print :ThreadbearAPSEnvironment" "$APPDIR/Info.plist")
[[ "$APS" == production ]] || { echo "ThreadbearAPSEnvironment is $APS, not production" >&2; exit 1; }
[[ -f "$APPDIR/PrivacyInfo.xcprivacy" ]] || { echo "No privacy manifest in the app" >&2; exit 1; }

echo "Exporting for App Store Connect…"
rm -rf "$OUT/export"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$OUT/export" \
  -exportOptionsPlist "$(export_options export)" "${auth[@]}" > "$OUT/export.log" 2>&1 \
  || { grep -E "error|EXPORT FAILED" "$OUT/export.log" >&2; echo "Export failed, see $OUT/export.log" >&2; exit 1; }
IPA="$OUT/export/Threadbear.ipa"
echo "Signed: $IPA"
# What it's signed with: an Apple Distribution certificate and an App Store profile.
CHECK="$OUT/ipa-check"
rm -rf "$CHECK" && mkdir -p "$CHECK" && unzip -q "$IPA" -d "$CHECK"
codesign -dvv "$CHECK/Payload/Threadbear.app" 2>&1 | grep -E "^Authority=" | head -1 || true
security cms -D -i "$CHECK/Payload/Threadbear.app/embedded.mobileprovision" 2>/dev/null \
  | plutil -extract Name raw -o - - 2>/dev/null | sed 's/^/Profile: /' || true

if [[ "${UPLOAD:-0}" == 1 ]]; then VALIDATE=${VALIDATE:-0}; else VALIDATE=${VALIDATE:-1}; fi
if [[ "$VALIDATE" == 1 ]]; then
  limit=${VALIDATE_TIMEOUT:-300}
  echo "Validating with App Store Connect (up to ${limit}s)…"
  # altool can go quiet for many minutes, and macOS has no `timeout`: run it in the background
  # into its log and kill it (and anything it started) when the time's up. altool finds
  # AuthKey_<id>.p8 in API_PRIVATE_KEYS_DIR.
  API_PRIVATE_KEYS_DIR="$KEY_DIR" xcrun altool --validate-app -f "$IPA" -t ios \
    --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" > "$OUT/validate.log" 2>&1 &
  pid=$!
  waited=0
  while kill -0 $pid 2>/dev/null && (( waited < limit )); do sleep 1; (( waited += 1 )); done
  if kill -0 $pid 2>/dev/null; then
    pkill -TERM -P $pid 2>/dev/null || true
    kill -TERM $pid 2>/dev/null || true
    wait $pid 2>/dev/null || true
    echo "WARNING: validation gave no answer in ${limit}s and was stopped (see $OUT/validate.log)."
    [[ "${UPLOAD:-0}" == 1 ]] && echo "Carrying on to the upload, which validates the build itself."
  else
    rc=0; wait $pid || rc=$?
    grep -vE "^\s*$" "$OUT/validate.log" | tail -5
    (( rc == 0 )) || { echo "Validation failed, see $OUT/validate.log" >&2; exit 1; }
  fi
fi

if [[ "${UPLOAD:-0}" != 1 ]]; then
  echo "Stopping before the upload (UPLOAD=1 uploads). Build $BUILD is at $IPA"
  exit 0
fi

echo "Uploading build $BUILD to App Store Connect…"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$OUT/upload" \
  -exportOptionsPlist "$(export_options upload)" "${auth[@]}" 2>&1 | tee "$OUT/upload.log" \
  | grep -E "error|Upload succeeded|EXPORT SUCCEEDED|EXPORT FAILED|Uploaded"
echo "Uploaded Threadbear $VERSION ($BUILD). It shows up under TestFlight once App Store Connect has processed it."

# Sentry needs the archive's dSYMs to show function names in the App Store build's crash reports.
# Only an uploaded build ships, so only then. Never fails the script: no sentry-cli or token skips
# it, a failed upload warns.
SENTRY_CLI=$(command -v sentry-cli || true)
[[ -z "$SENTRY_CLI" && -x "$HOME/.local/bin/sentry-cli" ]] && SENTRY_CLI="$HOME/.local/bin/sentry-cli"
SENTRY_TOKEN=${SENTRY_AUTH_TOKEN:-}
[[ -z "$SENTRY_TOKEN" && -r "$HOME/.config/sentry/token" ]] && SENTRY_TOKEN=$(tr -d '[:space:]' < "$HOME/.config/sentry/token")
if [[ -z "$SENTRY_CLI" || -z "$SENTRY_TOKEN" ]]; then
  echo "Debug symbols not uploaded to Sentry (no sentry-cli or no token)."
elif ! SENTRY_AUTH_TOKEN="$SENTRY_TOKEN" "$SENTRY_CLI" debug-files upload --org mikec --project threadbear "$ARCHIVE/dSYMs"; then
  echo "WARNING: debug symbols weren't uploaded to Sentry; crash reports from build $BUILD won't show function names."
fi
