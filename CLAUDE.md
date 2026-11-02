# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal AI learning system. Claude Code is the interface to the teacher agent, where the user reads prompts and answers questions. Obsidian is where the user reads lessons and views visuals, so the repo is expected to sit inside a vault.

It was ported from a [pi](https://github.com/earendil-works/pi) configuration. The working code lives in `.claude/` and `mcp/`.

## Commands

There is no build, lint, or test setup. Node runs the TypeScript directly (type stripping, Node 22.18+). The only install step is:

```bash
cd mcp && PUPPETEER_SKIP_DOWNLOAD=1 npm install
```

## Architecture

The pieces depend on each other through tool names and file conventions rather than imports:

- **`.claude/skills/teach/`** is the core of the system: the probe → plan → teach process and the two teaching principles.
- **`.claude/skills/visualize/`** has the main agent brief `mermaid-maker` or `svg-maker` through the `Agent` tool, then embed the returned filename as `![[viz-<slug>-<timestamp>.png|500]]`.
- **`.claude/skills/exam-material/`** extracts uploaded files in `material/<subject>/` (gitignored) to markdown in its `extracted/` folder. `scripts/inventory.mjs` converts Office files to PDF with `soffice` and decides what's left. `material-classifier` records each upload as study material or exam in `extracted/_catalog.json`, grouping images of one exam and group. One `material-extractor` then runs per PDF chunk or exam, writing to `extracted/study/` or `extracted/exams/`. Page markers (`<!-- page: N -->`) and embedded figures drive its completeness check. Figures are cropped from the source through `mcp/figure-server.ts`, never redrawn, because fidelity to the original is the point.
  `scripts/contents.mjs` generates `extracted/_contents.md` from those files, and `material-researcher` answers only from `extracted/`, citing file and page.
- **`.claude/agents/`** defines `researcher`, `material-researcher`, `material-classifier`, `material-extractor`, `svg-maker` and `mermaid-maker`.
- **`mcp/quiz-server.ts`** is the `learn` server from `.mcp.json`, providing `mcp__learn__quiz`.
- **`mcp/visual-server.ts`** provides the `write_*`/`edit_*`/`render_*` tools. Each maker declares it in its own frontmatter.
- **`.claude/hooks/md-log.ts`** mirrors the session into a linked note. `/md-log [filepath]` (a menu of recent vault notes when no path is given) and `/md-unlog` call it, and hooks in `.claude/settings.json` run its `sync`.
- **`.claude/hooks/safe-bash.mjs`** blocks dangerous Bash commands for `researcher` through a frontmatter hook.

`AskUserQuestion` is built in and replaces pi's `ask_user_question`.

### Non-obvious constraints

- **Quiz logging lives in the server.** The tool-call args hold the author's option order, not the shuffled order, so `quiz-server.ts` writes its own question and answer blocks and `sync` ignores quiz tool calls.
- **The md-log question block is read live.** It must never contain the correct answer or explanation before the user has answered.
- **`sync` reads the transcript, not `last_assistant_message`.** Lesson text often comes before a tool call in the same turn, so `Stop` alone would lose it. Byte offsets per session live in the gitignored `.claude/md-log.state.json`.
- **Linked notes must already exist.** `/md-log` never creates a note, and linking appends rather than overwriting. Subagent events are skipped, so only the lesson reaches the note.
- **Makers need separate `visual` server processes.** Authoring state is module-level, which is why the server is declared per agent and not in `.mcp.json`. Subagents can't use `AskUserQuestion` or elicitation, so only the main agent can quiz.
- **Tool renames span files.** MCP tool names appear in agent `tools:` lists, in agent bodies, in the skills, in `.claude/settings.json`, and in the `sync` logic.
- **Published PNGs need unique filenames.** Obsidian resolves `![[...]]` embeds by filename across the whole vault, which is why `publish()` appends a timestamp. Previews stay in the OS temp dir, and `viz/` is gitignored.
- **Rendering dependencies.** SVG needs `rsvg-convert` or `magick`. Mermaid needs Chrome or Chromium at one of the `CHROME_CANDIDATES` paths in `mcp/common.ts`, because puppeteer's own download is skipped.

## Writing conventions

- `.claude/skills/teach/SKILL.md` is written for one learner and addresses that learner as "him". Keep that voice when editing it.
- All lesson output renders in Obsidian: use LaTeX for math (`$...$`, `$$` fences), and mermaid fences for the plan's dependency map.
