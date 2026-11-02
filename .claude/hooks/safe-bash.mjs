// Blocks dangerous Bash commands for the researcher subagent (PreToolUse hook).
// Claude Code port of safe_bash from pi-interactive-subagents (MIT, HazAT).

import { readFileSync } from "node:fs"

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
  />\s*\/dev\/[sh]d[a-z]/,
  /\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
  /\bchown\s+(-[a-zA-Z]+\s+)?root/,
  /\bcurl\s.*\|\s*(ba)?sh/,
  /\bwget\s.*\|\s*(ba)?sh/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+0\b/,
  /\bkill\s+-9\s+1\b/,
  /\bkillall\b/,
]

const input = JSON.parse(readFileSync(0, "utf8"))
const command = String(input.tool_input?.command ?? "").replace(/\\\n/g, " ")

for (const pattern of DANGEROUS_PATTERNS) {
  if (pattern.test(command)) {
    console.error(`Command blocked by safe-bash: matches dangerous pattern ${pattern}`)
    process.exit(2) // exit 2 blocks the tool call and shows stderr to Claude
  }
}
