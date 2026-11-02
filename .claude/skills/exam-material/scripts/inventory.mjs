// Lists what exam-material still has to classify and extract for one subject.
// A task is pending until its output exists, is newer than its sources, and has
// a page marker for every page and every embedded figure on disk, so an
// interrupted run resumes where it stopped.
//
// Files are unclassified until extracted/_catalog.json has an entry for them.
//
// Usage: node inventory.mjs [subject]   (no subject lists the subjects)

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const MATERIAL_DIR = path.join(PROJECT_DIR, "material")
const OUTPUT_DIRNAME = "extracted"
const CATALOG_FILE = "_catalog.json"
const FOLDERS = { study: "study", exam: "exams" }
const PDF_CHUNK_PAGES = 40 // keeps one extractor's context small
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"])
const OFFICE_EXTENSIONS = new Set([".docx", ".doc", ".odt", ".pptx", ".ppt", ".odp"])
const CONVERTED_DIRNAME = ".converted"
const CONVERT_TIMEOUT_MS = 180_000

function subjects() {
  if (!fs.existsSync(MATERIAL_DIR)) return []
  return fs
    .readdirSync(MATERIAL_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === OUTPUT_DIRNAME) return []
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? sourceFiles(full) : [full]
  })
}

function pdfPages(file) {
  const info = execFileSync("pdfinfo", [file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  return Number(/^Pages:\s+(\d+)/m.exec(info)?.[1])
}

// LibreOffice can only write <name>.pdf, so it converts in a scratch folder and
// the result is moved to a name that keeps the extension: lecture.docx.pdf can't
// collide with a lecture.pdf uploaded next to it. A private profile lets this run
// while LibreOffice is open.
function convertToPdf(source, stem, subjectDir) {
  const convertedDir = path.join(subjectDir, OUTPUT_DIRNAME, CONVERTED_DIRNAME)
  const pdf = path.join(convertedDir, `${stem}.pdf`)
  if (fs.existsSync(pdf) && fs.statSync(pdf).mtimeMs >= fs.statSync(source).mtimeMs) return pdf
  fs.mkdirSync(convertedDir, { recursive: true })
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "exam-material-"))
  try {
    execFileSync(
      "soffice",
      [`-env:UserInstallation=file://${workDir}/profile`, "--headless", "--convert-to", "pdf", "--outdir", workDir, source],
      { stdio: "ignore", timeout: CONVERT_TIMEOUT_MS },
    )
    const name = `${path.basename(source, path.extname(source))}.pdf`
    fs.copyFileSync(path.join(workDir, name), pdf)
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
  return pdf
}

function status(task) {
  if (!fs.existsSync(task.output)) return "pending"
  const outputTime = fs.statSync(task.output).mtimeMs
  if (task.sources.some((source) => outputTime < fs.statSync(source).mtimeMs)) return "pending"
  const text = fs.readFileSync(task.output, "utf8")
  const seen = new Set([...text.matchAll(/<!-- page: (\d+) -->/g)].map((m) => Number(m[1])))
  for (let page = task.firstPage; page <= task.lastPage; page++) {
    if (!seen.has(page)) return "incomplete"
  }
  const figuresDir = path.join(path.dirname(task.output), "figures")
  for (const [, figure] of text.matchAll(/!\[\[([^\]|]+\.png)/g)) {
    if (!fs.existsSync(path.join(figuresDir, path.basename(figure)))) return "incomplete"
  }
  return "done"
}

function readCatalog(subjectDir) {
  try {
    const { files } = JSON.parse(fs.readFileSync(path.join(subjectDir, OUTPUT_DIRNAME, CATALOG_FILE), "utf8"))
    return new Map(files.map((entry) => [entry.source, entry]))
  } catch {
    return new Map()
  }
}

function isClassified(entry) {
  return entry?.category === "study" || (entry?.category === "exam" && Boolean(entry.exam))
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
}

function outputPath(subjectDir, category, name) {
  return path.join(subjectDir, OUTPUT_DIRNAME, FOLDERS[category], `${name}.md`)
}

function pdfTasks(file, subjectDir) {
  const { entry, stem, read, pages } = file
  const tasks = []
  for (let first = 1; first <= pages; first += PDF_CHUNK_PAGES) {
    const last = Math.min(first + PDF_CHUNK_PAGES - 1, pages)
    const suffix = pages > PDF_CHUNK_PAGES ? `.p${String(first).padStart(4, "0")}` : ""
    tasks.push({
      kind: "pdf",
      category: entry.category,
      title: entry.title || stem,
      sources: [read],
      firstPage: first,
      lastPage: last,
      output: outputPath(subjectDir, entry.category, `${stem}${suffix}`),
    })
  }
  return tasks
}

function imageTask(files, name, subjectDir) {
  const { entry } = files[0]
  return {
    kind: "image",
    category: entry.category,
    title: entry.title || name,
    sources: files.map((f) => f.read),
    firstPage: 1,
    lastPage: files.length,
    output: outputPath(subjectDir, entry.category, name),
  }
}

// Images of one exam become one task, in page order. A PDF is always its own task.
function buildTasks(files, subjectDir) {
  const tasks = files.filter((f) => f.kind === "pdf").flatMap((f) => pdfTasks(f, subjectDir))
  const exams = new Map()
  for (const file of files.filter((f) => f.kind === "image")) {
    if (file.entry.category === "study") {
      tasks.push(imageTask([file], file.stem, subjectDir))
      continue
    }
    exams.set(file.entry.exam, [...(exams.get(file.entry.exam) ?? []), file])
  }
  for (const [exam, pages] of exams) {
    pages.sort((a, b) => (a.entry.order ?? 0) - (b.entry.order ?? 0))
    tasks.push(imageTask(pages, slug(exam), subjectDir))
  }
  return tasks
}

const subject = process.argv[2]?.trim()
if (!subject) {
  console.log(JSON.stringify({ materialDir: MATERIAL_DIR, subjects: subjects() }, null, 2))
  process.exit(0)
}

const subjectDir = path.resolve(MATERIAL_DIR, subject)
if (path.dirname(subjectDir) !== MATERIAL_DIR || !fs.existsSync(subjectDir)) {
  console.log(JSON.stringify({ error: `No subject folder: ${subjectDir}`, subjects: subjects() }, null, 2))
  process.exit(0)
}

const catalog = readCatalog(subjectDir)
const unsupported = []
const unreadable = []
const unclassified = []
const classified = []
for (const source of sourceFiles(subjectDir)) {
  const ext = path.extname(source).toLowerCase()
  const image = IMAGE_EXTENSIONS.has(ext)
  const office = OFFICE_EXTENSIONS.has(ext)
  if (ext !== ".pdf" && !image && !office) {
    unsupported.push(source)
    continue
  }
  const relative = path.relative(subjectDir, source)
  const stem = (office ? relative : relative.slice(0, -path.extname(relative).length)).replaceAll(path.sep, "__")
  try {
    const read = office ? convertToPdf(source, stem, subjectDir) : source
    const file = { relative, stem, read, kind: image ? "image" : "pdf", pages: image ? 1 : pdfPages(read) }
    const entry = catalog.get(relative)
    if (isClassified(entry)) classified.push({ ...file, entry })
    else unclassified.push({ source: relative, read, kind: file.kind, pages: file.pages })
  } catch {
    unreadable.push(source)
  }
}

const tasks = buildTasks(classified, subjectDir).map((task) => ({ ...task, status: status(task) }))
const count = (name) => tasks.filter((t) => t.status === name).length
console.log(
  JSON.stringify(
    {
      subject,
      catalog: path.join(subjectDir, OUTPUT_DIRNAME, CATALOG_FILE),
      summary: {
        unclassified: unclassified.length,
        done: count("done"),
        pending: count("pending"),
        incomplete: count("incomplete"),
      },
      unclassified,
      todo: tasks.filter((t) => t.status !== "done"),
      unsupported,
      unreadable,
    },
    null,
    2,
  ),
)
