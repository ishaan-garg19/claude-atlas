---
description: Produce a context handoff doc summarizing what we've built/decided/are working on, AND copy it to the clipboard so a new Claude Code session can paste it directly. Pass optional focus areas as args.
argument-hint: [focus areas — comma-separated, e.g. "atlas, k8s guard"]
allowed-tools: Write, Bash(pbcopy:*), Bash(cat:*), Bash(date:*)
---

You are creating a **session handoff document** for the user. The current context window is filling up. Your job: condense everything important from this conversation into a structured markdown block the user can paste as the opening message of a fresh Claude Code session, so the new chat can resume work without losing context.

User-specified focus areas (deep-dive on these if non-empty): `$ARGUMENTS`

## Rules

- Work from this conversation's context only. Do NOT run tools, fetch files, or invent details you can't recall.
- Be concrete: real file paths, real port numbers, real commit hashes/branches, real decisions made — not generic descriptions.
- Skip anything already documented in the user's global `~/.claude/CLAUDE.md` (modes, baseline preferences, k8s contexts). The new session will have that loaded already.
- Skip social filler. No "we had a great session" preambles.
- Total output target: **400–800 lines of markdown**. Compact but loaded. Use tables where they help.
- If `$ARGUMENTS` is non-empty, give those topics 2-3× the depth of other sections.

## Required structure

Output the document as a single fenced markdown block (so the user can copy-paste cleanly), with these top-level sections in this order:

````markdown
# Session handoff — <YYYY-MM-DD> — <one-line topic>

## Mission
2-4 sentences. What are we building/improving? What's the big picture.

## What's running on this machine
Bullet list of services/daemons we set up: name, port, where it lives, LaunchAgent label, status.
Example: "- Atlas response-viewer · port 4850 · `~/.claude/tools/response-viewer/server.js` · LaunchAgent `com.example.response-viewer` · auto-starts on login"

## Key files modified or created
Table: | Path | Purpose | Notes |
Include exact paths under `~/.claude/`, `~/Library/LaunchAgents/`, `~/Code/`, etc.

## Decisions locked in
Numbered list. For each: the choice + the reason. Cover:
- Naming choices (the viewer is called "Atlas", user display name, etc.)
- Architecture choices (one SSE per tab, file-watcher uses fs.watchFile not fs.watch, etc.)
- UX choices (default pagination size, when to fold thinking blocks, etc.)
- Anything we deliberately did NOT do (and why)

## Open / unfinished
Numbered list of things pending. For each:
- What
- Why it's pending (waiting on user input? known but deferred?)
- Where in the code/files it would live when picked up

## Known issues / gotchas
Bullets. Each is one-liner with the workaround if any.

## How to pick up from here
- Commands to run to verify things are healthy
- URLs/ports to hit
- What "good state" looks like

## Recent activity (last ~10 things)
Reverse-chronological one-liners. Tight. Reader is the future-Claude who needs to know
the trajectory but not every detail.

## Focus areas (if user passed any)
For each focus area in `$ARGUMENTS`: a dedicated subsection with deeper detail —
relevant files, recent changes, current state, what to ask the user next.

## User context worth re-loading
- Name: (already in memory)
- Stack: (whatever ecosystem the user works in)
- macOS, default browser: Google Chrome
- Tools installed: brew formulae list (only the relevant ones), pipx tools, coursier installs
- Any quirks established in this session (e.g. "prefers Cmd+click links over slash commands", "wants terse summaries", etc.)

## Suggested first prompt for the new session
A single line the user can literally retype/paste to restart productively. Example:
> "Continue work on Atlas. Last thing we did was X. Next is Y. Read the handoff above for full context."
````

## After composing the document — copy it to the clipboard

Once you've composed the document, **before printing it inline**, do this:

1. Write the markdown content (the part that goes INSIDE the fenced block — NOT the fence itself, NOT this command's prose around it) to a temp file:
   `/tmp/claude-handoff-<YYYY-MM-DD-HHMMSS>.md`
   using the `Write` tool.

2. Pipe it to the macOS clipboard with `Bash`:
   `cat /tmp/claude-handoff-<file>.md | pbcopy`

3. Then print the full document inline in chat (with the fenced block) so the user can see it.

4. Below the fenced block, add this footer (outside the fence):

```
📋 Copied to your clipboard — paste it as the first message in your new Claude Code session.
💾 Also saved to /tmp/claude-handoff-<file>.md (temp file; rename to keep it).
```

If `pbcopy` fails for any reason (e.g. running outside macOS), fall back to just printing the document and tell the user "clipboard copy unavailable — copy manually from above."

Do NOT save to `~/.claude/handoffs/` automatically — the user might want to edit first. Temp file is fine.
