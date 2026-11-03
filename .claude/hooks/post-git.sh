#!/usr/bin/env bash
# Runs after a git commit/push made through Claude Code:
# refreshes the graphify knowledge graph, then asks the user to run /compact.
cd "$CLAUDE_PROJECT_DIR" || exit 0

GRAPHIFY="$(command -v graphify || true)"
fallback="$LOCALAPPDATA/Programs/Python/Python312/Scripts/graphify.exe"
[ -z "$GRAPHIFY" ] && [ -x "$fallback" ] && GRAPHIFY="$fallback"

if [ -n "$GRAPHIFY" ]; then
  if "$GRAPHIFY" update . >/dev/null 2>&1; then
    status="graphify graph updated."
  else
    status="graphify update FAILED - run 'graphify update .' manually."
  fi
else
  status="graphify not installed - graph not updated."
fi

printf '{"systemMessage":"%s Run /compact now to compact the conversation.","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Git commit/push finished. %s Remind the user to run /compact."}}\n' "$status" "$status"
