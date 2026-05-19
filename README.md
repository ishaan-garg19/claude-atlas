# Atlas — a local session viewer for Claude Code

A self-hosted browser dashboard that mirrors every Claude Code session you've ever run, with:

- **Multi-session picker** with live grouping by recency (Today / Yesterday / This week / …), project chips, and project-name pills per card
- **Live transcript** rendering with markdown, syntax-highlighted code blocks (copy-on-click), and diffs for `Edit` / `MultiEdit` / `Write` tool calls
- **Cross-session search** (`⌘K`) across every session you've ever had — snippets with hits highlighted, click to jump
- **Token usage popover** with context-window gauge, cost estimate (Opus pricing), turn-by-turn sparkline, cache hit rate, session duration
- **Inline annotation** — highlight any passage, leave a comment, click "Send to Claude" and a round-trip slash command in the CLI processes them
- **Resume button** per session — copies `cd "<cwd>" && claude --resume <id>` to your clipboard
- **Status-line link** — adds a Cmd+clickable `🌐 atlas` to the Claude Code status line, pointing to *this* tab's session

Runs entirely on `localhost`. No data leaves your machine.

## Screenshots

(Add your own — `localhost:4850` after install)

## Requirements

- **macOS** (LaunchAgents are macOS-specific; the viewer itself works on Linux/WSL with manual systemd/service setup)
- **Node.js** 18+
- **`jq`** for the status-line script (`brew install jq`)
- **`agentation-mcp`** npm package (auto-installed by `install.sh`) — powers the "Send to Claude" annotation round-trip
- **Claude Code** itself — Atlas reads JSONL transcripts from `~/.claude/projects/`

## Install

```sh
git clone https://github.com/ishaan-garg19/claude-atlas.git
cd claude-atlas
bash install.sh
```

The script:
1. Copies viewer + scripts + commands into `~/.claude/`
2. Renders LaunchAgent plists with your paths and loads them
3. Tells you what (if anything) to add to `settings.json` manually

After install, open `http://localhost:4850/` in your browser. Bookmark it.

To uninstall: `bash uninstall.sh`.

## Configuration

### Customize your display name

Edit `~/.claude/tools/response-viewer/page.html`:

```js
const USER_NAME = "You";       // ← change to your first name if you want
const ASSISTANT_NAME = "Claude";
```

Reload the page.

### Status line link

If your `~/.claude/settings.json` doesn't already have a `statusLine` block, add:

```json
"statusLine": {
  "type": "command",
  "command": "bash /Users/<you>/.claude/tools/statusline.sh"
}
```

The script shows `model | context% [bar] | 📝 N pending | 🌐 atlas` where `🌐 atlas` is an OSC 8 hyperlink — Cmd+click in iTerm2 / Terminal.app / Warp to open the viewer pinned to your current session.

### Slash commands

After install you get:

| Command | What it does |
|---|---|
| `/atlas` | Opens Atlas in Chrome, pinned to your current session |
| `/review-annotations` | Pulls pending annotations from agentation, replies inline in chat |

## How the annotation round-trip works

1. In Atlas, highlight any text in any response → comment in the popup → "Add"
2. Repeat for any number of annotations
3. Click "Send to Claude" — annotations get POSTed to `agentation-mcp` on localhost:4747, tagged with `cc_session=<your-Claude-Code-session-id>`
4. In the matching CLI session, run `/review-annotations` — Claude fetches them, replies inline in chat, and posts the same replies back to agentation
5. The "Sent" tab in Atlas shows your annotations alongside Claude's replies

Multi-session safe: each annotation is tagged with the source session ID, so running `/review-annotations` in window A doesn't process window B's annotations.

## Architecture

```
┌──────────────────┐
│  Browser tab     │
│  localhost:4850  │
└────────┬─────────┘
         │ HTTP + SSE
         ▼
┌──────────────────┐    fs.watchFile     ┌─────────────────────┐
│  response-viewer │ ◄────────────────── │  ~/.claude/projects │
│  Node :4850      │                     │  *.jsonl transcripts│
└────────┬─────────┘                     └─────────────────────┘
         │ HTTP proxy (for sent annotations)
         ▼
┌──────────────────┐
│  agentation-mcp  │
│  Node :4747      │
│  ~/.agentation/  │
│  store.db        │
└──────────────────┘
```

- **response-viewer/server.js** — HTTP server on :4850. Serves the SPA, lists sessions (cached by mtime), fetches per-session transcripts, watches files with `fs.watchFile`, fans out SSE events.
- **page.html** — single-file SPA. Vendored `marked`, `highlight.js`, `jsdiff`.
- **agentation-mcp** — third-party MCP server (annotation database). Atlas talks to its HTTP API; Claude Code talks to its MCP stdio API.
- **statusline.sh** — bash script Claude Code invokes for the status line.
- **commands/*.md** — slash command definitions.

## Files installed by `install.sh`

```
~/.claude/
├── tools/
│   ├── response-viewer/      # Node server + SPA
│   ├── statusline.sh
│   └── agentation-watcher.sh # macOS desktop notifications on new annotations
├── commands/
│   ├── atlas.md
│   └── review-annotations.md
└── hooks/
    └── k8s-guard.sh          # optional: blocks destructive kubectl on non-dev contexts

~/Library/LaunchAgents/
├── com.atlas.response-viewer.plist  # auto-start viewer
└── com.atlas.agentation-mcp.plist   # auto-start agentation
```

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

- [marked.js](https://github.com/markedjs/marked) — markdown rendering
- [highlight.js](https://github.com/highlightjs/highlight.js) — syntax highlighting
- [jsdiff](https://github.com/kpdecker/jsdiff) — diff visualization
- [agentation-mcp](https://www.npmjs.com/package/agentation-mcp) — annotation MCP backend
