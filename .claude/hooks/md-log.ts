/**
 * md-log — mirror the session to a markdown file for reading in Obsidian.
 *
 * Claude Code hooks call `sync`, which reads new lines from the session
 * transcript and appends the reading-relevant content: user prompts, assistant
 * text, and AskUserQuestion Q&A blocks.
 *
 * The quiz tool writes its own question and answer blocks (see logQuiz*), since
 * only the server knows the shuffled order. A question block must NEVER contain
 * the correct answer or explanation: the user reads this file live.
 *
 * Commands:
 *   node md-log.ts link <filepath>  — Link an existing markdown file. With no
 *                                     path, lists recent notes in the vault.
 *   node md-log.ts unlink           — Stop logging.
 *   node md-log.ts sync             — Hook entry point (JSON on stdin).
 *
 * Linking backfills the session on the next sync. Append-only.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const PROJECT_DIR =
  process.env.CLAUDE_PROJECT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const STATE_PATH = path.join(PROJECT_DIR, ".claude", "md-log.state.json")
const LOCK_PATH = `${STATE_PATH}.lock`
const LOCK_TIMEOUT_MS = 3000
const NOTE_MENU_SIZE = 4 // AskUserQuestion shows at most four options

interface State {
  file: string | null
  offsets: Record<string, number> // session id → transcript bytes already logged
  pendingAsks: string[] // AskUserQuestion tool_use ids awaiting their result
}

function readState(): State {
  try {
    return { file: null, offsets: {}, pendingAsks: [], ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) }
  } catch {
    return { file: null, offsets: {}, pendingAsks: [] }
  }
}

function writeState(state: State): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8")
}

// Hooks can fire close together; keep each sync's read-append-save atomic.
function withLock(fn: () => void): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      fs.mkdirSync(LOCK_PATH)
      break
    } catch {
      if (Date.now() > deadline) {
        fs.rmSync(LOCK_PATH, { recursive: true, force: true }) // stale lock from a killed hook
        continue
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    fn()
  } finally {
    fs.rmSync(LOCK_PATH, { recursive: true, force: true })
  }
}

function appendToFile(file: string, text: string): void {
  try {
    const empty = !fs.existsSync(file) || fs.readFileSync(file, "utf8").trim().length === 0
    fs.appendFileSync(file, (empty ? "" : "\n\n") + text + "\n", "utf8")
  } catch {
    // File may have been deleted externally; ignore.
  }
}

// --- Formatting ---

function callout(type: string, title: string, bodyLines: string[]): string {
  const lines = [`> [!${type}] ${title}`]
  for (const line of bodyLines) lines.push(line.length === 0 ? ">" : `> ${line}`)
  return lines.join("\n")
}

function questionCallout(label: string, question: string, context: string | undefined, options: string[]): string {
  const body = question.split("\n")
  if (context) body.push("", ...context.split("\n"))
  if (options.length > 0) body.push("", ...options.map((o, i) => `${i + 1}. ${o}`))
  return callout("question", label, body)
}

/** The prompt text of a user entry, or "" for tool results and injected context. */
function userText(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n")
        : ""
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()
  return /^<(command-|local-command|task-notification|bash-)/.test(cleaned) ? "" : cleaned
}

function askAnswerLines(entry: any, block: any): string[] {
  const answers = entry.toolUseResult?.answers
  if (answers && typeof answers === "object") {
    return Object.entries(answers).map(([question, answer]) => `${question}: ${answer}`)
  }
  const content = block.content
  const text = typeof content === "string" ? content : (content ?? []).map((c: any) => c.text ?? "").join("\n")
  return text.trim().split("\n")
}

function entryBlocks(entry: any, state: State): string[] {
  if ((entry.type !== "user" && entry.type !== "assistant") || entry.isSidechain || entry.isMeta) return []
  const content = entry.message?.content
  const blocks: string[] = []

  if (entry.type === "assistant") {
    for (const c of Array.isArray(content) ? content : []) {
      if (c.type === "text" && c.text.trim()) blocks.push(`> [!abstract] CLAUDE\n\n${c.text.trim()}`)
      if (c.type === "tool_use" && c.name === "AskUserQuestion") {
        state.pendingAsks.push(c.id)
        for (const q of c.input?.questions ?? []) {
          const options = (q.options ?? []).map((o: any) => o.label)
          blocks.push(questionCallout("Question", q.question ?? "", undefined, options))
        }
      }
    }
    return blocks
  }

  for (const c of Array.isArray(content) ? content : []) {
    if (c.type === "tool_result" && state.pendingAsks.includes(c.tool_use_id)) {
      state.pendingAsks = state.pendingAsks.filter((id) => id !== c.tool_use_id)
      blocks.push(callout("example", "Answer", askAnswerLines(entry, c)))
    }
  }
  const text = userText(content)
  if (text) blocks.push(`> [!quote] YOU\n\n${text}`)
  return blocks
}

// --- Quiz blocks, written by the quiz MCP server ---

export function logQuizQuestion(question: string, context: string | undefined, options: string[]): void {
  const { file } = readState()
  if (file) appendToFile(file, questionCallout("Quiz", question, context, options))
}

export interface QuizLogResult {
  status: "answered" | "cancelled" | "unavailable"
  message?: string
  dontKnow?: boolean
  correct?: boolean
  selected?: string[]
  correctIndices?: number[]
  note?: string
  explanation?: string
}

export function logQuizAnswer(r: QuizLogResult): void {
  const { file } = readState()
  if (!file) return
  if (r.status === "cancelled") return appendToFile(file, callout("warning", "Quiz — cancelled", ["(user skipped)"]))
  if (r.status === "unavailable") {
    return appendToFile(file, callout("warning", "Quiz — unavailable", [r.message ?? ""]))
  }
  // "I don't know" is neither correct nor incorrect, so it never renders as a red ✗.
  const type = r.dontKnow ? "question" : r.correct ? "success" : "failure"
  const title = r.dontKnow ? "Quiz — I don't know" : r.correct ? "Quiz — correct ✓" : "Quiz — incorrect ✗"
  const body = [
    r.dontKnow ? "Your answer: I don't know" : `Your answer: ${(r.selected ?? []).join(", ") || "(none)"}`,
    `Correct answer: ${(r.correctIndices ?? []).join(", ")}`,
  ]
  if (r.note) body.push("", ...`Note: ${r.note}`.split("\n"))
  if (r.explanation) body.push("", ...r.explanation.split("\n"))
  appendToFile(file, callout(type, title, body))
}

// --- Commands ---

/** The Obsidian vault containing the project, or the project if there is none. */
function vaultRoot(): string {
  for (let dir = PROJECT_DIR; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".obsidian"))) return dir
  }
  return PROJECT_DIR
}

function recentNotes(limit: number): string[] {
  const notes: Array<{ file: string; mtime: number }> = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".md") && !["README.md", "CLAUDE.md"].includes(entry.name)) {
        notes.push({ file: full, mtime: fs.statSync(full).mtimeMs })
      }
    }
  }
  walk(vaultRoot())
  return notes
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((n) => n.file)
}

function link(input: string): void {
  const filepath = input.replace(/^@/, "").replace(/^"(.*)"$/, "$1")
  if (!filepath) {
    const notes = recentNotes(NOTE_MENU_SIZE)
    return console.log(notes.length ? `Choose a note:\n${notes.join("\n")}` : "No markdown notes found.")
  }
  const resolved = path.resolve(PROJECT_DIR, filepath)
  // /md-log links into an existing note, it never creates one, so a typo'd path
  // can't scatter new files around the vault.
  if (!fs.existsSync(resolved)) return console.log(`File does not exist: ${resolved}`)
  if (!fs.statSync(resolved).isFile()) return console.log(`Not a file: ${resolved}`)
  withLock(() => writeState({ file: resolved, offsets: {}, pendingAsks: [] }))
  console.log(`Linked: ${resolved}`)
}

function unlink(): void {
  const { file } = readState()
  if (!file) return console.log("No file linked")
  withLock(() => writeState({ file: null, offsets: {}, pendingAsks: [] }))
  console.log(`Unlinked: ${path.basename(file)}`)
}

function sync(): void {
  const hook = JSON.parse(fs.readFileSync(0, "utf8"))
  if (hook.agent_id || !hook.transcript_path || !hook.session_id) return // subagents stay out of the lesson
  withLock(() => {
    const state = readState()
    if (!state.file || !fs.existsSync(hook.transcript_path)) return
    const bytes = fs.readFileSync(hook.transcript_path)
    const offset = state.offsets[hook.session_id] ?? 0
    const end = bytes.lastIndexOf(0x0a) + 1 // only whole lines; the rest waits for the next sync
    if (end <= offset) return
    const blocks: string[] = []
    for (const line of bytes.subarray(offset, end).toString("utf8").split("\n")) {
      if (line.trim()) blocks.push(...entryBlocks(JSON.parse(line), state))
    }
    if (blocks.length > 0) appendToFile(state.file, blocks.join("\n\n"))
    state.offsets[hook.session_id] = end
    writeState(state)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === "link") link(rest.join(" ").trim())
  else if (command === "unlink") unlink()
  else if (command === "sync") sync()
  else console.log("Usage: md-log.ts link <filepath> | unlink | sync")
}
