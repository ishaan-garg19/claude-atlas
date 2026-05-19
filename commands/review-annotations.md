---
description: Fetch and process pending annotations created for THIS Claude Code session via the response viewer (localhost:4850). Responds inline in chat with a numbered answer per annotation.
---

You are processing annotations submitted from the response viewer browser UI (localhost:4850). These annotations were tagged for **this specific Claude Code session** and are waiting in the agentation MCP store.

The user expects to see your responses **inline in this chat, point-by-point** — one numbered answer per annotation, addressed substantively. The agentation MCP calls are secondary bookkeeping; the chat output is the primary deliverable.

## Steps

1. **Read your session ID** from the environment / transcript path. You'll filter pending annotations to only those tagged with `cc_session=<your-session-id>`.

2. **Fetch all pending annotations** by calling `mcp__agentation__agentation_get_all_pending`. The result is a list of agentation sessions, each with their pending annotations.

3. **Filter to this session only**. For each agentation session, inspect its `url` field. Keep only sessions whose URL contains `cc_session=<your-session-id>`. Other sessions' annotations are NOT for you — leave them untouched. If the filter result is empty, tell the user `No pending annotations for this session.` and stop.

4. **For each matching annotation, in the order they appear:**
   a. Call `mcp__agentation__agentation_acknowledge` with the annotation ID (silent bookkeeping).
   b. Look up the original quoted passage. The `element` field is the exact quoted text. `nearbyText` / metadata `prefix` and `suffix` give surrounding context to disambiguate when the same string appears multiple times.
   c. Compose a substantive answer based on the comment type:
      - **👎 Wrong** → verify the original statement; if incorrect, state the correction clearly and explain what's actually true.
      - **❓ Confusing** → re-explain the original passage with different phrasing or a concrete example.
      - **✨ Good** → acknowledge briefly (1 line).
      - **🤔 Question** → answer the question directly, drawing on the conversation context.
      - **Any other comment** → treat as direct feedback; address what the user is actually asking.
   d. Send the same answer to agentation via `mcp__agentation__agentation_reply` (so it shows up in the viewer too).
   e. Resolve with `mcp__agentation__agentation_resolve` and a one-line summary.

5. **Output format in chat — REQUIRED.** Render your responses to the user as a numbered list, one section per annotation:

   ```
   ## Annotation 1 of N

   > **Quote** (msg #<idx>, <role>): "<quoted text, up to ~200 chars>"
   > **Comment:** <user's comment verbatim>

   <Your substantive response — 1-3 paragraphs. Direct. No padding. No "Great question!" preambles.>

   ---

   ## Annotation 2 of N

   ...
   ```

   After the last annotation, add a one-line summary:
   ```
   ✓ Resolved N annotation(s) — replies also posted to agentation for the viewer.
   ```

## Rules

- **Session scoping is critical.** Do NOT process annotations from other Claude Code sessions even if they're in the global pending list. Match `cc_session=<your-session-id>` in the agentation session URL.
- If `mcp__agentation__agentation_get_all_pending` is unavailable, report the failure clearly — do not fall back to other tools or invent data.
- Each response goes BOTH in chat (primary) AND to `agentation_reply` (so the user sees it in Atlas annotations panel too). They must be the same text.
- Do not write code, edit files, or run commands unless an annotation explicitly asks for them. Textual answers only by default.
- If multiple annotations point to the same passage, **still answer them individually** — the user wants point-by-point coverage. You can cross-reference (e.g. "see also Annotation 2") but don't merge them into one block.
- Be direct. The user wants substance, not "Thanks for the feedback" filler. Lead with the answer.
