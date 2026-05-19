#!/usr/bin/env bash
# Claude Code status line:
#   model | context % [bar] | pending annotations (if any) | 🌐 atlas
# The "🌐 atlas" link uses OSC 8 hyperlinks (supported by iTerm2, Terminal.app,
# Warp, Ghostty) — Cmd+click opens Atlas pinned to *this* session's ID, so
# each window's link goes to its own session (not the last-viewed one).

input=$(cat)
model=$(echo "$input" | jq -r '.model.display_name')
usage=$(echo "$input" | jq '.context_window.current_usage')

if [ "$usage" != "null" ]; then
  current=$(echo "$usage" | jq '.input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens')
  size=$(echo "$input" | jq '.context_window.context_window_size')
  pct=$((current * 100 / size))
  filled=$((pct / 5))
  empty=$((20 - filled))
  bar=""
  for ((i=0; i<filled; i++)); do bar="${bar}█"; done
  for ((i=0; i<empty; i++)); do bar="${bar}░"; done
  base=$(printf "%s | %3d%% [%s]" "$model" "$pct" "$bar")
else
  base=$(printf "%s | context: --" "$model")
fi

# Extract the current Claude Code session ID. Status-line input usually exposes
# `session_id` directly; if not, derive from `transcript_path` (.jsonl filename).
session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
if [ -z "$session_id" ]; then
  tpath=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
  if [ -n "$tpath" ]; then
    session_id=$(basename "$tpath" .jsonl)
  fi
fi

# Build the Atlas URL, pinned to this session if we have an ID.
if [ -n "$session_id" ]; then
  atlas_url="http://localhost:4850/?session=${session_id}"
else
  atlas_url="http://localhost:4850/"
fi

# Pending-annotation count from agentation MCP (port 4747).
pending=$(curl -sS --max-time 0.3 http://localhost:4747/pending 2>/dev/null | jq -r '.count // 0' 2>/dev/null)

# OSC 8 hyperlink: makes "🌐 atlas" clickable. Falls back to plain text in
# terminals that don't support OSC 8.
viewer=$(printf '\033]8;;%s\033\\🌐 atlas\033]8;;\033\\' "$atlas_url")

if [ -n "$pending" ] && [ "$pending" -gt 0 ] 2>/dev/null; then
  printf "%s | 📝 %d | %s" "$base" "$pending" "$viewer"
else
  printf "%s | %s" "$base" "$viewer"
fi
