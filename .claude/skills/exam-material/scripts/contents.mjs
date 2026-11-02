// Builds extracted/_contents.md for one subject: study material and exams in
// separate sections, each source with its headings and pages, links into the
// extracted markdown, and each figure rendered inline. Generated from the files
// themselves, so it can't drift from them or invent an entry.
//
// Usage: node contents.mjs <subject>

import * as fs from "node:fs"
import * as path from "node:path"

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const CONTENTS_FILE = "_contents.md"
const SECTIONS = [
  { title: "Study material", folder: "study" },
  { title: "Exams", folder: "exams" },
]
const PAGE_MARKER = /^<!-- page: (\d+) -->$/
const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/
const FIGURE = /^> \[!figure\]\s*(.*)$/
const EMBED = /^> !\[\[([^\]|]+)/
const FIGURE_WIDTH = 300

function frontmatterValue(text, key) {
  const end = text.indexOf("\n---", 3)
  const front = text.startsWith("---") && end > 0 ? text.slice(0, end) : ""
  return new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1].trim()
}

function outline(text) {
  const entries = []
  let page = null
  let inFence = false
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd()
    if (line.startsWith("```")) inFence = !inFence
    if (inFence) continue
    const marker = PAGE_MARKER.exec(line)
    if (marker) page = Number(marker[1])
    if (page === null) continue // still in the frontmatter
    const heading = HEADING.exec(line)
    if (heading) entries.push({ kind: "heading", level: heading[1].length, title: heading[2], page })
    const figure = FIGURE.exec(line)
    if (figure) entries.push({ kind: "figure", title: figure[1] || "Figure", page })
    const embed = EMBED.exec(line)
    if (embed && entries.at(-1)?.kind === "figure") entries.at(-1).image = embed[1]
  }
  return entries
}

function label(text) {
  return text.replace(/[[\]]/g, "")
}

// Obsidian leaves these characters out of heading links.
function headingLink(file, title) {
  const anchor = title.replace(/[#|^:%[\]]/g, " ").replace(/\s+/g, " ").trim()
  return `${encodeURI(file)}#${encodeURI(anchor)}`
}

function readParts(extractedDir, folder) {
  const dir = path.join(extractedDir, folder)
  if (!fs.existsSync(dir)) return new Map()
  const byTitle = new Map()
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".md")) continue
    const text = fs.readFileSync(path.join(dir, file), "utf8")
    const title = frontmatterValue(text, "title") ?? file
    const [first, last] = (frontmatterValue(text, "pages") ?? "1-1").split("-").map(Number)
    if (!byTitle.has(title)) byTitle.set(title, [])
    byTitle.get(title).push({ link: `${folder}/${file}`, name: file, first, last, entries: outline(text) })
  }
  return byTitle
}

const subject = process.argv[2]?.trim()
if (!subject) {
  console.log("Usage: contents.mjs <subject>")
  process.exit(1)
}
const extractedDir = path.join(PROJECT_DIR, "material", subject, "extracted")
if (!fs.existsSync(extractedDir)) {
  console.log(`Nothing extracted yet: ${extractedDir}`)
  process.exit(1)
}

const lines = [`# Contents: ${subject}`, ""]
let sources = 0
let headings = 0
let figures = 0
for (const section of SECTIONS) {
  const byTitle = readParts(extractedDir, section.folder)
  if (byTitle.size === 0) continue
  lines.push(`## ${section.title}`, "")
  for (const [title, parts] of byTitle) {
    sources++
    parts.sort((a, b) => a.first - b.first)
    const lastPage = Math.max(...parts.map((p) => p.last))
    lines.push(`### ${title} (${lastPage === 1 ? "1 page" : `${lastPage} pages`})`, "")
    for (const part of parts) {
      const span = part.first === part.last ? `p. ${part.first}` : `pp. ${part.first}-${part.last}`
      lines.push(`- [${part.name}](${encodeURI(part.link)}) (${span})`)
      const minLevel = Math.min(6, ...part.entries.filter((e) => e.kind === "heading").map((e) => e.level))
      for (const entry of part.entries) {
        if (entry.kind === "heading") {
          headings++
          const indent = "  ".repeat(entry.level - minLevel + 1)
          lines.push(`${indent}- [${label(entry.title)}](${headingLink(part.link, entry.title)}) (p. ${entry.page})`)
        } else {
          figures++
          lines.push(`  - ${entry.title} (p. ${entry.page})`)
          if (entry.image) lines.push("", `    ![[${path.basename(entry.image)}|${FIGURE_WIDTH}]]`, "")
        }
      }
    }
    lines.push("")
  }
}

fs.writeFileSync(path.join(extractedDir, CONTENTS_FILE), lines.join("\n").trimEnd() + "\n", "utf8")
console.log(`Wrote ${path.join(extractedDir, CONTENTS_FILE)}: ${sources} sources, ${headings} headings, ${figures} figures`)
