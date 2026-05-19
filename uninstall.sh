#!/usr/bin/env bash
# Atlas uninstaller — stops LaunchAgents and removes installed files.
set -eu

LAUNCH_DIR="${HOME}/Library/LaunchAgents"
CLAUDE_DIR="${HOME}/.claude"

for label in com.atlas.response-viewer com.atlas.agentation-mcp; do
  plist="$LAUNCH_DIR/$label.plist"
  if [ -f "$plist" ]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    echo "removed $plist"
  fi
done

rm -rf "$CLAUDE_DIR/tools/response-viewer"
rm -f "$CLAUDE_DIR/tools/statusline.sh"
rm -f "$CLAUDE_DIR/tools/agentation-watcher.sh"
rm -f "$CLAUDE_DIR/commands/atlas.md"
rm -f "$CLAUDE_DIR/commands/review-annotations.md"
rm -f "$CLAUDE_DIR/hooks/k8s-guard.sh"

echo ""
echo "Atlas uninstalled. settings.json is untouched — remove the statusLine block manually if needed."
