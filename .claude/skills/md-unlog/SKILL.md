---
name: md-unlog
description: Stop mirroring this session to a markdown note.
disable-model-invocation: true
allowed-tools: Bash(node *md-log.ts*)
---

!`node "${CLAUDE_PROJECT_DIR}/.claude/hooks/md-log.ts" unlink`

Tell the user the result above in one line.
