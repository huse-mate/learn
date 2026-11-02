/**
 * crop_figure for the material-extractor subagent, as an MCP server: cuts a
 * figure out of a source PDF page or image, so the lesson shows the original
 * pixels instead of a redrawing.
 *
 * The crop is returned inline so the agent can look at it. Calling again with
 * the same name overwrites the file, so it can adjust the box until it fits.
 * PDF pages are rendered with pdftoppm, and cropping uses ImageMagick.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { existsSync, mkdirSync, readFileSync, run } from "./common.ts"

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const MATERIAL_DIR = path.join(PROJECT_DIR, "material")
const PDF_DPI = "300"
const TIMEOUT_MS = 60_000

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "figure"
  )
}

async function mustRun(cmd: string, args: string[], cwd: string): Promise<string> {
  const res = await run(cmd, args, { cwd, timeoutMs: TIMEOUT_MS })
  if (res.code !== 0) throw new Error(`${cmd} failed: ${(res.stderr || res.stdout).trim().slice(-500)}`)
  return res.stdout
}

const server = new McpServer({ name: "figures", version: "0.1.0" })

server.registerTool(
  "crop_figure",
  {
    title: "Crop figure",
    description:
      "Crop one figure out of a source page and save it next to the extracted markdown as a PNG, returned inline so " +
      "you can SEE it. The box is in percent of the page, measured from the top-left corner. Call again with the same " +
      "name and a corrected box to overwrite it. Embed the returned filename in the markdown.",
    inputSchema: {
      source: z.string().describe("Absolute path of the source PDF or image."),
      page: z.number().int().min(1).describe("Page number. For an image, its page position in the markdown file."),
      left: z.number().min(0).max(100).describe("Left edge, percent of page width."),
      top: z.number().min(0).max(100).describe("Top edge, percent of page height."),
      right: z.number().min(0).max(100).describe("Right edge, percent of page width."),
      bottom: z.number().min(0).max(100).describe("Bottom edge, percent of page height."),
      output: z.string().describe("Absolute path of the markdown file this figure belongs to."),
      name: z.string().describe("Short kebab-case name, unique within the page, e.g. 'figure-3'."),
    },
  },
  async ({ source, page, left, top, right, bottom, output, name }) => {
    const figuresDir = path.join(path.dirname(path.resolve(output)), "figures")
    const relative = path.relative(MATERIAL_DIR, figuresDir)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`output must be inside ${MATERIAL_DIR}`)
    }
    if (!existsSync(source)) throw new Error(`Source not found: ${source}`)
    if (right <= left || bottom <= top) throw new Error("The box needs right > left and bottom > top.")

    const subject = relative.split(path.sep)[0]
    const stem = path.basename(output, ".md")
    // Obsidian resolves embeds by filename across the vault, so the name has to be unique there.
    const filename = `${slug(subject)}-${slug(stem)}-p${page}-${slug(name)}.png`
    const dest = path.join(figuresDir, filename)
    mkdirSync(figuresDir, { recursive: true })

    const workDir = mkdtempSync(path.join(tmpdir(), "learn-figure-"))
    try {
      let raster = source
      if (path.extname(source).toLowerCase() === ".pdf") {
        const prefix = path.join(workDir, "page")
        await mustRun(
          "pdftoppm",
          ["-f", String(page), "-l", String(page), "-r", PDF_DPI, "-png", "-singlefile", source, prefix],
          workDir,
        )
        raster = `${prefix}.png`
      }
      const size = await mustRun("magick", ["identify", "-format", "%w %h", `${raster}[0]`], workDir)
      const [width, height] = size.trim().split(" ").map(Number)
      const x = Math.round((left / 100) * width)
      const y = Math.round((top / 100) * height)
      const w = Math.round(((right - left) / 100) * width)
      const h = Math.round(((bottom - top) / 100) * height)
      await mustRun("magick", [`${raster}[0]`, "-crop", `${w}x${h}+${x}+${y}`, "+repage", dest], workDir)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }

    return {
      content: [
        {
          type: "text",
          text: `Saved figures/${filename}\n\nLOOK at the crop below: the whole figure, its labels and its caption area must be inside, with nothing cut off.`,
        },
        { type: "image", data: readFileSync(dest).toString("base64"), mimeType: "image/png" },
      ],
    }
  },
)

await server.connect(new StdioServerTransport())
