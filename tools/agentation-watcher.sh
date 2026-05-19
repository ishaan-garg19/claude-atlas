#!/usr/bin/env bash
# Poll agentation MCP (localhost:4747) and fire macOS notifications when
# the pending-annotation count increases. Designed to run via launchd.

set -u
STATE_FILE="$HOME/.claude/cache/agentation-last-count"
LOG_FILE="$HOME/.claude/cache/agentation-watcher.log"
URL="http://localhost:4747/pending"
INTERVAL=5

mkdir -p "$(dirname "$STATE_FILE")"
[ -f "$STATE_FILE" ] || echo "0" > "$STATE_FILE"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"; }

log "watcher started (pid=$$, interval=${INTERVAL}s)"

while true; do
  resp=$(curl -sS --max-time 2 "$URL" 2>/dev/null || true)
  if [ -n "$resp" ]; then
    current=$(printf '%s' "$resp" | jq -r '.count // 0' 2>/dev/null || echo "0")
    last=$(cat "$STATE_FILE" 2>/dev/null || echo "0")
    if [ "$current" -gt "$last" ] 2>/dev/null; then
      delta=$((current - last))
      noun="annotation"; [ "$delta" -ne 1 ] && noun="annotations"
      osascript -e "display notification \"${delta} new ${noun} pending (total ${current})\" with title \"Claude · Annotations\" sound name \"Glass\"" >/dev/null 2>&1
      log "notify: +${delta} (now ${current})"
    fi
    echo "$current" > "$STATE_FILE"
  fi
  sleep "$INTERVAL"
done
