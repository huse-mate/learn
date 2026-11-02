/**
 * Authoring loops for the mermaid-maker and svg-maker subagents, as an MCP
 * server.
 *
 *   write_<kind>   — write the full source to the session's managed file
 *   edit_<kind>    — exact-match old_text→new_text on that file
 *   render_<kind>  — render whatever is in the file → PNG, returned inline; with
 *                    `save_as`, also publish it into <project>/viz
 *
 * Each maker declares this server in its own frontmatter, so it gets a separate
 * process: module-level session state is naturally isolated from parallel makers.
 *
 * Mermaid shells out to the bundled @mermaid-js/mermaid-cli (`mmdc`) with a
 * puppeteer config pointing at an installed Chrome. SVG shells out to
 * rsvg-convert, falling back to ImageMagick's `magick`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { fileURLToPath } from "node:url"
import {
  applyEdit,
  dirname,
  existsSync,
  findChrome,
  join,
  mkdirSync,
  publish,
  readFileSync,
  run,
  type Session,
  snippetAround,
  writeBody,
  writeFileSync,
} from "./common.ts"

const MMDC_BIN = join(dirname(fileURLToPath(import.meta.url)), "node_modules", ".bin", "mmdc")

type Render = { ok: boolean; detail: string; timedOut: boolean }

async function renderMermaid(bodyPath: string, outPath: string, workDir: string): Promise<Render> {
  const chrome = findChrome()
  const cfgPath = join(workDir, "puppeteer.json")
  writeFileSync(
    cfgPath,
    JSON.stringify(chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] }),
    "utf8",
  )
  const res = await run(MMDC_BIN, ["-i", bodyPath, "-o", outPath, "-p", cfgPath, "-s", "2", "-b", "white"], {
    cwd: workDir,
    timeoutMs: 120_000,
    env: { PUPPETEER_SKIP_DOWNLOAD: "1" },
  })
  return { ok: res.code === 0 && existsSync(outPath), detail: res.stderr || res.stdout, timedOut: res.timedOut }
}

async function renderSvg(bodyPath: string, outPath: string, workDir: string): Promise<Render> {
  const timeoutMs = 60_000
  // rsvg-convert renders at the SVG's intrinsic size; -z 2 doubles it for crispness.
  const res = await run("rsvg-convert", ["-z", "2", bodyPath, "-o", outPath], { cwd: workDir, timeoutMs })
  if (res.code === 0 && existsSync(outPath)) return { ok: true, detail: "", timedOut: false }
  // Fallback: ImageMagick. -density 192 (~2x of 96dpi) for a crisp raster.
  const magick = await run("magick", ["-density", "192", "-background", "white", bodyPath, outPath], {
    cwd: workDir,
    timeoutMs,
  })
  if (magick.code === 0 && existsSync(outPath)) return { ok: true, detail: "", timedOut: false }
  const failed = res.code !== null ? res : magick
  return { ok: false, detail: failed.stderr || failed.stdout, timedOut: failed.timedOut }
}

const server = new McpServer({ name: "visual", version: "0.1.0" })

function text(value: string) {
  return { type: "text" as const, text: value }
}

function registerAuthoringTools(opts: {
  kind: "mermaid" | "svg"
  label: string
  bodyFile: string
  sourceHint: string
  validate?: (source: string) => void
  render: (bodyPath: string, outPath: string, workDir: string) => Promise<Render>
}) {
  const { kind, label, bodyFile } = opts
  let session: Session | null = null

  server.registerTool(
    `write_${kind}`,
    {
      title: `Write ${label}`,
      description:
        `Write the FULL ${label} source to this session's managed file (your first draft or a complete rewrite). ` +
        `You do NOT name the file: edit_${kind} and render_${kind} act on the same one. ${opts.sourceHint} ` +
        `Writing does NOT render. For a small fix, prefer edit_${kind}.`,
      inputSchema: { source: z.string().describe(`The complete ${label} source.`) },
    },
    async ({ source }) => {
      const trimmed = source.trim()
      if (!trimmed) throw new Error(`write_${kind} requires a non-empty source.`)
      opts.validate?.(trimmed)
      session = writeBody(kind, bodyFile, trimmed)
      const lines = trimmed.split("\n").length
      return { content: [text(`Wrote ${lines}-line ${label} source.\nCall render_${kind} to render it, or edit_${kind} to tweak it.`)] }
    },
  )

  server.registerTool(
    `edit_${kind}`,
    {
      title: `Edit ${label}`,
      description:
        `Make a single exact-match replacement in this session's ${label} source. old_text must appear EXACTLY ONCE ` +
        `(include surrounding context for uniqueness); on 0 or >1 matches the call fails and nothing changes. ` +
        `Call write_${kind} first. Editing does NOT render.`,
      inputSchema: {
        old_text: z.string().describe("Exact substring of the current source to replace (must match once)."),
        new_text: z.string().describe("Replacement text for old_text."),
      },
    },
    async ({ old_text, new_text }) => {
      if (!session || !existsSync(session.bodyPath)) {
        throw new Error(`edit_${kind}: no source yet, call write_${kind} first.`)
      }
      const { updated, index } = applyEdit(readFileSync(session.bodyPath, "utf8"), old_text, new_text)
      writeFileSync(session.bodyPath, updated, "utf8")
      return {
        content: [text("Applied edit. Updated region:\n```\n" + snippetAround(updated, index) + `\n\`\`\`\nCall render_${kind} to see it.`)],
      }
    },
  )

  server.registerTool(
    `render_${kind}`,
    {
      title: `Render ${label}`,
      description:
        `Render the CURRENT session ${label} source to a PNG and return it inline so you can SEE it and iterate. ` +
        `Iterate with no save_as (preview only). When it is correct and clean, call once more with save_as set to a ` +
        `short kebab-case topic slug: that publishes the PNG into <project>/viz with a unique filename and returns the ` +
        `filename to embed. On a render error this returns the error text instead of an image.`,
      inputSchema: {
        save_as: z
          .string()
          .optional()
          .describe("Short kebab-case topic slug. Publishes viz-<slug>-<timestamp>.png. Omit for a preview-only render."),
      },
    },
    async ({ save_as }) => {
      if (!session || !existsSync(session.bodyPath)) {
        throw new Error(`render_${kind}: no source yet, call write_${kind} first.`)
      }
      const { workDir, bodyPath } = session
      mkdirSync(workDir, { recursive: true })
      const outPath = join(workDir, `render-${Date.now()}.png`)
      const result = await opts.render(bodyPath, outPath, workDir)

      if (!result.ok) {
        const detail = (result.detail || "unknown error").split("\n").slice(-30).join("\n")
        const note = result.timedOut ? "Render timed out.\n\n" : ""
        return {
          content: [text(`${note}${label} render FAILED, no image produced. Fix the source with edit_${kind} and call render_${kind} again.\n\nError:\n${detail}`)],
        }
      }

      const image = { type: "image" as const, data: readFileSync(outPath).toString("base64"), mimeType: "image/png" }
      if (save_as) {
        const { filename, path } = publish(outPath, save_as)
        return {
          content: [text(`Published to viz/.\nfilename: ${filename}\npath: ${path}\n\nLOOK at the image below to confirm it is correct before returning it.`), image],
        }
      }
      return {
        content: [text(`Preview render (not yet saved). LOOK: is everything correct and readable? Fix with edit_${kind}, or re-render with save_as to publish.`), image],
      }
    },
  )
}

registerAuthoringTools({
  kind: "mermaid",
  label: "Mermaid",
  bodyFile: "diagram.mmd",
  sourceHint: "source is a complete Mermaid diagram (graph TD/LR, sequenceDiagram, stateDiagram-v2, erDiagram, classDiagram, mindmap, or timeline).",
  render: renderMermaid,
})

registerAuthoringTools({
  kind: "svg",
  label: "SVG",
  bodyFile: "diagram.svg",
  sourceHint: "source is a complete <svg>…</svg> document with an explicit width/height (or viewBox), readable font sizes, and a light or transparent background.",
  validate: (source) => {
    if (!source.includes("<svg")) throw new Error("write_svg: source must be a complete <svg>…</svg> document.")
  },
  render: renderSvg,
})

await server.connect(new StdioServerTransport())
