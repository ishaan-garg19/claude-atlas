#!/usr/bin/env bash
# Atlas installer — copies files into ~/.claude/ and registers LaunchAgents.
# Idempotent: safe to re-run.
set -eu

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
TOOLS_DIR="${CLAUDE_DIR}/tools"
COMMANDS_DIR="${CLAUDE_DIR}/commands"
HOOKS_DIR="${CLAUDE_DIR}/hooks"
CACHE_DIR="${CLAUDE_DIR}/cache"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"

say()  { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[err]\033[0m %s\n" "$*" >&2; }

# Detect platform
if [ "$(uname)" != "Darwin" ]; then
  warn "This installer targets macOS. LaunchAgents won't work on Linux/Windows."
  warn "You can still copy files manually; auto-start setup will be skipped."
fi

# Find node
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  err "Node.js not found in PATH. Install Node (https://nodejs.org) and re-run."
  exit 1
fi
say "Node:  $NODE_BIN ($($NODE_BIN --version))"

# Check jq (used by statusline.sh)
if ! command -v jq >/dev/null 2>&1; then
  warn "jq not installed — required by statusline.sh. Install: brew install jq"
fi

# Install agentation-mcp if not already present
say "Locating agentation-mcp (annotation round-trip backend)..."
AGENTATION_CLI=""
# Try npm global, then npx cache, then npm prefix
for candidate in \
  "$(npm root -g 2>/dev/null)/agentation-mcp/dist/cli.js" \
  "$HOME/.npm/_npx/cef9b194a47a5767/node_modules/agentation-mcp/dist/cli.js" \
  ; do
  if [ -f "$candidate" ]; then AGENTATION_CLI="$candidate"; break; fi
done

if [ -z "$AGENTATION_CLI" ]; then
  say "agentation-mcp not found. Installing via npm (global)..."
  if npm install -g agentation-mcp >/dev/null 2>&1; then
    AGENTATION_CLI="$(npm root -g)/agentation-mcp/dist/cli.js"
  else
    warn "Global install failed. Atlas core (viewer) will still install, but the"
    warn "annotation 'Send to Claude' round-trip needs agentation-mcp running on :4747."
    warn "Install it later with: npm install -g agentation-mcp"
  fi
fi
[ -n "$AGENTATION_CLI" ] && say "agentation-mcp: $AGENTATION_CLI"

# Make the directories
mkdir -p "$TOOLS_DIR" "$COMMANDS_DIR" "$HOOKS_DIR" "$CACHE_DIR" "$LAUNCH_DIR"

# Copy files
say "Copying files into $CLAUDE_DIR ..."
mkdir -p "$TOOLS_DIR/response-viewer"
cp "$REPO/tools/response-viewer"/* "$TOOLS_DIR/response-viewer/"
cp "$REPO/tools/statusline.sh"        "$TOOLS_DIR/statusline.sh"
cp "$REPO/tools/agentation-watcher.sh" "$TOOLS_DIR/agentation-watcher.sh"
cp "$REPO/commands/atlas.md"          "$COMMANDS_DIR/atlas.md"
cp "$REPO/commands/review-annotations.md" "$COMMANDS_DIR/review-annotations.md"
if [ -f "$REPO/hooks/k8s-guard.sh" ]; then
  cp "$REPO/hooks/k8s-guard.sh" "$HOOKS_DIR/k8s-guard.sh"
fi
chmod +x "$TOOLS_DIR/statusline.sh" "$TOOLS_DIR/agentation-watcher.sh" "$HOOKS_DIR/k8s-guard.sh" 2>/dev/null || true

# Render + install LaunchAgents (macOS only)
if [ "$(uname)" = "Darwin" ]; then
  say "Setting up LaunchAgents (auto-start on login) ..."
  render_plist() {
    local src="$1" dest="$2"
    sed \
      -e "s|__HOME__|${HOME}|g" \
      -e "s|__NODE_BIN__|${NODE_BIN}|g" \
      -e "s|__AGENTATION_CLI__|${AGENTATION_CLI}|g" \
      "$src" > "$dest"
  }

  render_plist "$REPO/launchagents/com.atlas.response-viewer.plist.template" \
               "$LAUNCH_DIR/com.atlas.response-viewer.plist"
  launchctl unload "$LAUNCH_DIR/com.atlas.response-viewer.plist" 2>/dev/null || true
  launchctl load   "$LAUNCH_DIR/com.atlas.response-viewer.plist"
  say "  response-viewer loaded (port 4850)"

  if [ -n "$AGENTATION_CLI" ]; then
    render_plist "$REPO/launchagents/com.atlas.agentation-mcp.plist.template" \
                 "$LAUNCH_DIR/com.atlas.agentation-mcp.plist"
    launchctl unload "$LAUNCH_DIR/com.atlas.agentation-mcp.plist" 2>/dev/null || true
    launchctl load   "$LAUNCH_DIR/com.atlas.agentation-mcp.plist"
    say "  agentation-mcp loaded (port 4747)"
  fi
fi

# Wire the status line if settings.json doesn't already reference our script
SETTINGS="$CLAUDE_DIR/settings.json"
if [ -f "$SETTINGS" ] && ! grep -q "statusline.sh" "$SETTINGS"; then
  warn "Your $SETTINGS doesn't reference statusline.sh."
  warn "Add this manually to the top-level object to enable the Atlas link:"
  cat <<EOF

  "statusLine": {
    "type": "command",
    "command": "bash $TOOLS_DIR/statusline.sh"
  }

EOF
fi

# Print success
say "Installed."
say ""
say "Open Atlas in your browser:  http://localhost:4850/"
say "Or type /atlas in any Claude Code session to launch it in Chrome."
say ""
say "To uninstall: bash $REPO/uninstall.sh"
