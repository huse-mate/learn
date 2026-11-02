/**
 * quiz — a GRADED sibling of AskUserQuestion, as an MCP server.
 *
 * Poses a question that HAS a correct answer through an MCP elicitation form,
 * grades the selection here (not in the model), and returns tight feedback
 * (✓/✗ + correct answer + explanation).
 *
 * Options-only: single-select or multi-select. An "I don't know" choice and a
 * free-text note are always added.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { logQuizAnswer, logQuizQuestion, type QuizLogResult } from "../.claude/hooks/md-log.ts"

const DONT_KNOW_LABEL = "I don't know"
// The SDK fails an elicitation after 60s by default, and he may step away mid-question.
const ANSWER_TIMEOUT_MS = 24 * 60 * 60 * 1000

interface QuizOption {
  label: string
  value: string
}

// Fisher-Yates shuffle over a copy. Safe to reorder for display because the
// correct answer is referenced by value, not position.
function shuffleOptions(options: QuizOption[]): QuizOption[] {
  const out = [...options]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function normalizeOptions(options: Array<{ label: string; value?: string }>): QuizOption[] {
  const seen = new Set<string>()
  return options
    .map((o) => ({ label: o.label.trim(), value: o.value?.trim() || o.label.trim() }))
    .filter((o) => {
      if (o.label.length === 0) return false
      if (seen.has(o.value)) throw new Error(`duplicate option value "${o.value}"`)
      seen.add(o.value)
      return true
    })
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

const server = new McpServer({ name: "learn", version: "0.1.0" })

server.registerTool(
  "quiz",
  {
    title: "Quiz",
    description: [
      "Ask the user one GRADED question with instant feedback. If the question has a correct answer, use quiz. If you just need a preference, decision, or open-ended input, use AskUserQuestion.",
      "An 'I don't know' choice and a free-text note are ALWAYS added automatically: provide ONLY the real, gradable options (at least two).",
      "dontKnow means the user honestly did not know and did NOT guess: treat it as a knowledge gap to teach into, not a wrong answer. A note reflects what they were thinking; let it steer your follow-up.",
      "Treat each distractor as a diagnostic probe: a specific, believable mistake, so WHICH wrong answer they pick reveals WHICH nuance is off. Every distractor must be unambiguously wrong on the intended reading, not a trick.",
      "Keep options similar in length, specificity, and phrasing so the correct answer can't be picked from shape alone.",
      "Multi-select is graded as an exact-set match. To probe nuance, ask several quick questions and adapt each to the previous answers rather than writing one giant question.",
    ].join("\n"),
    inputSchema: {
      question: z.string().describe("The single quiz question to ask. Ask exactly one question per tool call."),
      details: z.string().optional().describe("Optional extra context or instructions shown under the question."),
      options: z
        .array(
          z.object({
            label: z.string().describe("Display label for the answer option."),
            value: z.string().optional().describe("Stable value used by correctAnswer. Defaults to the label."),
          }),
        )
        .min(2)
        .describe("The answer options (2 or more). Options only, there is no free-text mode."),
      multiSelect: z
        .boolean()
        .optional()
        .describe("Set to true when more than one option is correct and the user must select all of them."),
      correctAnswer: z
        .union([z.string(), z.array(z.string())])
        .describe("The correct option value(s), not a position number. A string, or an array for multi-select."),
      explanation: z.string().describe("Revealed AFTER the user answers. Say why the correct answer is correct."),
      shuffle: z
        .boolean()
        .optional()
        .describe("Defaults to true. Set to false only when option order is meaningful."),
    },
  },
  async (params) => {
    let options: QuizOption[]
    try {
      options = normalizeOptions(params.options)
    } catch (e) {
      return textResult(`status: unavailable\nquiz ${(e as Error).message}`)
    }
    if (options.length < 2) return textResult("status: unavailable\nquiz requires at least two options")

    // Shuffle BEFORE resolving correct indices, so grading matches the display order.
    if (params.shuffle !== false) options = shuffleOptions(options)

    const correctValues = [params.correctAnswer].flat()
    const correctIndices = correctValues.map((v) => options.findIndex((o) => o.value === v) + 1)
    if (correctIndices.includes(0)) {
      return textResult(`status: unavailable\nquiz correctAnswer matches no option value: ${correctValues.join(", ")}`)
    }

    const details = params.details?.trim() || undefined
    const explanation = params.explanation.trim()
    const labels = options.map((o, i) => `${i + 1}. ${o.label}`)
    logQuizQuestion(params.question, details, options.map((o) => o.label))

    const finish = (result: QuizLogResult, text: string) => {
      logQuizAnswer(result)
      return textResult(text)
    }

    let response
    try {
      response = await server.server.elicitInput({
        message: details ? `${params.question}\n\n${details}` : params.question,
        requestedSchema: {
          type: "object",
          properties: {
            answer: params.multiSelect
              ? {
                  type: "array",
                  title: "Select all that apply",
                  items: { type: "string", enum: [...labels, DONT_KNOW_LABEL] },
                }
              : { type: "string", title: "Your answer", enum: [...labels, DONT_KNOW_LABEL] },
            note: { type: "string", title: "Note (optional)" },
          },
          required: ["answer"],
        },
      }, { timeout: ANSWER_TIMEOUT_MS })
    } catch (e) {
      const message = `quiz requires interactive elicitation: ${(e as Error).message}`
      return finish({ status: "unavailable", message }, `status: unavailable\n${message}`)
    }

    if (response.action !== "accept") {
      return finish({ status: "cancelled" }, "status: cancelled\nThe user skipped this question.")
    }

    const picked = [response.content?.answer ?? []].flat() as string[]
    const note = String(response.content?.note ?? "").trim() || undefined
    const dontKnow = picked.includes(DONT_KNOW_LABEL)
    const pickedIndices = picked.map((p) => labels.indexOf(p) + 1).filter((i) => i > 0)
    const correct =
      !dontKnow &&
      pickedIndices.length === correctIndices.length &&
      correctIndices.every((i) => pickedIndices.includes(i))

    const verdict = dontKnow ? "dontKnow" : correct ? "correct ✓" : "incorrect ✗"
    const lines = [
      `status: answered`,
      `result: ${verdict}`,
      `user answer: ${dontKnow ? DONT_KNOW_LABEL : picked.join(", ") || "(none)"}`,
      `correct answer: ${correctIndices.map((i) => labels[i - 1]).join(", ")}`,
      `explanation: ${explanation}`,
    ]
    if (note) lines.push(`note: ${note}`)
    return finish(
      { status: "answered", dontKnow, correct, selected: picked, correctIndices, note, explanation },
      lines.join("\n"),
    )
  },
)

await server.connect(new StdioServerTransport())
