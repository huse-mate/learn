---
name: md-log
description: Mirror this session to an existing markdown note for reading in Obsidian.
argument-hint: "[filepath]"
disable-model-invocation: true
allowed-tools: Bash(node *md-log.ts*)
---

!`node "${CLAUDE_PROJECT_DIR}/.claude/hooks/md-log.ts" link "$ARGUMENTS"`

If the output above starts with "Choose a note:", ask with `AskUserQuestion` which note to link, with one option per listed path. Use the filename as the label and the path as the description. If only one path is listed, add a "Cancel" option, and link nothing if the user picks it. The user can type another path through "Other". Then run this with their choice and use its output:

`node "${CLAUDE_PROJECT_DIR}/.claude/hooks/md-log.ts" link "<chosen path>"`

Tell the user the final result in one line.
