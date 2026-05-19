#!/usr/bin/env bash
# PreToolUse hook for Bash: guard against destructive kubectl ops on
# non-dev contexts (prophecy-staging, prophecy-regression, prophecy-poccluster).
# Dev contexts (*-dev-k3s, ishaan-*, ash-*, rashmin-*) are always allowed.
#
# Exit codes:
#   0 = allow (silent)
#   2 = block + emit stderr; Claude will re-think

set -u

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

# Split on shell separators (; & | ) and find the first segment that is an
# active `kubectl ...` invocation (after optional VAR=val env prefixes).
# This prevents false positives when `kubectl ... delete ...` only appears
# as text inside an `echo` or a quoted argument.
active=""
while IFS= read -r seg; do
  stripped=$(printf '%s' "$seg" | sed -E 's/^[[:space:]]*//; s/^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*//')
  case "$stripped" in
    kubectl[[:space:]]*|kubectl)
      active="$stripped"
      break ;;
  esac
done < <(printf '%s\n' "$cmd" | tr ';&|' '\n')

[ -z "$active" ] && exit 0

# Find a destructive verb as a standalone token in the active kubectl command.
destructive_verbs="delete apply replace patch scale drain taint cordon uncordon expose rollout label annotate debug edit set exec cp run attach"
verb=""
padded=" $active "
for v in $destructive_verbs; do
  case "$padded" in
    *" $v "*) verb="$v"; break ;;
  esac
done

[ -z "$verb" ] && exit 0

# Determine target context: --context=X, --context X, then fall back to current
ctx=$(printf '%s' "$active" | grep -oE '(--context[= ][^[:space:]]+)' | head -1 | sed -E 's/^--context[= ]//')
if [ -z "$ctx" ]; then
  ctx=$(kubectl config current-context 2>/dev/null || echo "unknown")
fi

# Dev contexts always allowed
case "$ctx" in
  *-dev-k3s|*-dev|ishaan-*|ash-*|rashmin-*)
    exit 0 ;;
esac

# Sensitive contexts: warn + block (unless bypass env var set)
case "$ctx" in
  prophecy-staging|prophecy-regression|prophecy-poccluster|unknown)
    if [ "${CLAUDE_K8S_GUARD_OFF:-0}" = "1" ]; then exit 0; fi
    cat >&2 <<EOF
🛑 k8s-guard: blocked a destructive kubectl operation.

  context: $ctx
  verb:    $verb
  command: $active

This context is non-dev. Destructive verbs (delete/apply/patch/scale/drain/edit/exec/rollout/etc.)
are blocked here by default. If genuinely intended:
  - Confirm with the user explicitly before re-attempting
  - Or scope the command to a specific resource and rerun with --dry-run=client first
  - Or switch context to a dev cluster (ishaan-dev-k3s, ash-dev-k3s, rashmin-dev-k3s)
  - Or set CLAUDE_K8S_GUARD_OFF=1 in the env for this turn to bypass intentionally
EOF
    exit 2
    ;;
esac

# Unknown context — allow but silent
exit 0
