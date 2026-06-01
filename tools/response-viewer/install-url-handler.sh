#!/usr/bin/env bash
# Installs AtlasUrlHandler.app — a tiny AppleScript-based app that owns the
# atlas:// URL scheme and routes every click to Google Chrome.
#
# After install, OSC 8 hyperlinks like atlas://localhost:4850/?session=…
# (emitted by the statusline) will open in Chrome regardless of the system
# default browser.
#
# Idempotent: safe to re-run; rebuilds the app in place.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SRC="${SCRIPT_DIR}/atlas-url-handler.applescript"
APP_DIR="${HOME}/Applications"
APP="${APP_DIR}/AtlasUrlHandler.app"

if [ ! -f "$SRC" ]; then
  echo "✗ AppleScript source not found at $SRC" >&2
  exit 1
fi

mkdir -p "$APP_DIR"

# Wipe any previous build so plutil keys don't accumulate.
rm -rf "$APP"

# Compile the AppleScript into a .app bundle (the "stay-open" flag is NOT
# needed — open-location is fired on demand and the app exits afterwards).
osacompile -o "$APP" "$SRC"

PLIST="${APP}/Contents/Info.plist"
if [ ! -f "$PLIST" ]; then
  echo "✗ osacompile didn't produce $PLIST" >&2
  exit 1
fi

# Inject the URL scheme registration. plutil's -insert errors if the key
# already exists, so first remove (no-op if absent) then insert fresh.
plutil -remove CFBundleURLTypes "$PLIST" 2>/dev/null || true
plutil -insert CFBundleURLTypes -xml \
'<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>Atlas viewer link</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>atlas</string>
      <string>atlass</string>
    </array>
  </dict>
</array>' "$PLIST"

# Give the bundle a stable identifier so LaunchServices doesn't confuse it
# with rebuild copies.
plutil -replace CFBundleIdentifier -string "com.ishaangarg.atlas-url-handler" "$PLIST" 2>/dev/null \
  || plutil -insert CFBundleIdentifier -string "com.ishaangarg.atlas-url-handler" "$PLIST"

# Hint to Finder that the app is a background utility (no Dock icon).
plutil -replace LSUIElement -bool true "$PLIST" 2>/dev/null \
  || plutil -insert LSUIElement -bool true "$PLIST"

# Re-register so LaunchServices picks up the new scheme.
LSR="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSR" ]; then
  "$LSR" -f "$APP"
else
  echo "⚠ lsregister not at expected path; LaunchServices may need a relaunch (logout/login) to pick up the new handler." >&2
fi

echo "✓ Installed: $APP"
echo "✓ Handles:   atlas:// atlass://"
echo
echo "Try it:  open 'atlas://localhost:4850/'"
