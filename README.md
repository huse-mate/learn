# learn

A personal AI learning system for Claude Code, forked from [amosblomqvist/learn](https://github.com/amosblomqvist/learn), which was built for the pi coding agent. You talk to the teacher and answer quizzes in Claude Code, and read the lessons and figures in Obsidian.

## What's in it

- `.claude/skills/teach/` — the philosophy and the process
- `.claude/skills/visualize/` — adds a correct, minimal diagram to a lesson when an idea is clearer as a picture
- `.claude/skills/md-log/`, `.claude/skills/md-unlog/` — `/md-log` links an Obsidian note to the session, and `/md-unlog` stops logging
- `.claude/agents/` — `researcher`, `svg-maker`, `mermaid-maker`: the subagents the system delegates to
- `.claude/hooks/` — mirrors the session into the linked note and blocks dangerous commands for `researcher`
- `mcp/` — the graded `quiz` tool and the rendering tools for the visual subagents

## Install

Copy this folder into your Obsidian vault, run `npm install` once in `mcp/`, and start `claude` in the folder.

## Requirements

- [Claude Code](https://claude.com/claude-code), run from a normal terminal (the quiz popup didn't open in the VS Code session)
- [Obsidian](https://obsidian.md)
- Node.js 22.18 or newer
- `rsvg-convert` or ImageMagick for SVG figures
- Chrome or Chromium for Mermaid figures (add its path to `CHROME_CANDIDATES` in `mcp/common.ts` if it isn't found)
