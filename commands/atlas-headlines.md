---
description: Regenerate Atlas session headlines using AI (Claude haiku). Targets auto-extracted ones by default.
allowed-tools: Bash(curl:*)
---

Run the AI batch headline generator against the local Atlas server. It streams SSE progress; we just need the final summary line.

Use this command. Default filter is `auto` (only regenerates currently auto-extracted headlines — leaves user/asana/llm ones alone). Pass `all` as an argument to regenerate everything except user-set ones.

```
filter="${1:-auto}"
curl -sS -N -X POST "http://localhost:4850/headlines/llm/batch?filter=${filter}" \
  | grep -E '^(event:|data:)' \
  | awk '/^event: complete/{getline; sub(/^data: /,""); print "✓", $0; exit}
         /^event: progress/{getline; sub(/^data: /,""); print "  •", $0}
         /^event: start/{getline; sub(/^data: /,""); print "▶", $0}'
```

After it finishes, tell the user how many headlines were generated and ask whether they want to re-run with `filter=all` to refresh non-auto ones too (skipped: user-set).

The Atlas UI also has a `✨` button in the Sessions rail (top-right of the filter row) that does the same thing with live progress in-browser.
