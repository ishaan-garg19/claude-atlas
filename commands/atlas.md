---
description: Open Atlas (the session viewer at localhost:4850) for the CURRENT Claude Code session in Google Chrome
allowed-tools: Bash(open:*)
---

Run exactly this command to open Atlas focused on the current session:

```
open -a "Google Chrome" "http://localhost:4850/?cc_session=${CLAUDE_CODE_SESSION_ID}"
```

The shell substitutes `$CLAUDE_CODE_SESSION_ID` with this session's UUID, so Atlas lands on this conversation instead of whatever was last viewed. Confirm with a one-line acknowledgement -- nothing else.
