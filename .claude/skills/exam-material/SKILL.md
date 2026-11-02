---
name: exam-material
description: Sorts uploaded lecture slides, notes and past exams (PDFs, images, Word and PowerPoint files, including scans and photos), extracts them into well-formatted markdown with a table of contents, then answers questions from them with page citations. Use when he wants to prepare from his own material, or mentions uploaded notes, slides, past papers or files in material/.
argument-hint: "[subject] [question]"
allowed-tools: Bash(node *inventory.mjs*), Bash(node *contents.mjs*)
---

# Exam material

Turns the files he uploads into faithful markdown, so that later work can rest on his material rather than on the web or on memory. Each file is transcribed by a `material-extractor` subagent, which keeps large documents out of this conversation.

Material lives in `material/<subject>/`, in any subfolders. Word and PowerPoint files are converted to PDF first, automatically, by the inventory.

Output goes to `material/<subject>/extracted/`, which Obsidian can read directly:

```
extracted/
├── _contents.md      table of contents
├── _catalog.json     what each upload is
├── study/            lecture slides and notes, one .md per upload
└── exams/            past exams, one .md per exam
```

Each folder has a `figures/` folder of crops from the source, so figures stay identical to the original.

## Phase 1 — Extract

1. **Take stock.** Run the inventory with the subject, or with no argument to list the subjects:

   ```
   node "${CLAUDE_SKILL_DIR}/scripts/inventory.mjs" "<subject>"
   ```

   If no subject was given and there is exactly one, use it. If there are several, ask with `AskUserQuestion`. If there are none, tell him to put his files in `material/<subject>/` and stop.

2. **Classify.** If `unclassified` isn't empty, start one `material-classifier` with the `catalog` path and the full `unclassified` list, wait for it, and run the inventory again. Don't classify files yourself. This step also groups images of the same exam, so repeat it until `unclassified` is empty.

3. **Dispatch.** Start one `material-extractor` for each entry in `todo`, up to 5 at a time, in the background. Each entry is one PDF page range, or all the images of one exam, and an `incomplete` entry is redone from scratch. Pass the entry's fields as the prompt:

   ```
   Agent(subagent_type="material-extractor", description="<short label>", prompt="title: <title>\ncategory: <category>\nkind: <kind>\nsources: <sources, one per line, in order>\npages: <firstPage>-<lastPage>\noutput: <output>")
   ```

4. **Verify.** When the batch finishes, run the inventory again and don't rely on the agents' reports. Repeat steps 3 and 4 until `todo` is empty, retrying a failed entry at most twice.

5. **Build the contents.** Generate `extracted/_contents.md`, which lists study material and exams separately, with their headings, figures and pages:

   ```
   node "${CLAUDE_SKILL_DIR}/scripts/contents.mjs" "<subject>"
   ```

6. **Report.** Tell him how many files and pages were extracted, how many study files and exams there are, which images were merged into which exam, any `note` from the catalog, the output folder, and the total `illegible` count with the affected files. List anything in `unsupported` or `unreadable`, and any entry that still failed after retries.

An interrupted run resumes by running this again: finished entries are skipped, and a source that has changed is extracted again. If he corrects `_catalog.json`, delete the affected `.md` files and run this again.

Extraction only transcribes. Don't summarize, teach from, or answer questions about the material in this phase.

## Phase 2 — Research

Use this when a question should be answered from his material, when he wants to know what past exams ask, or when a lesson is being planned from it. If he only asked for extraction, stop after Phase 1.

1. **Check the material is current.** Run the inventory. If `todo` isn't empty, run Phase 1 first.
2. **Dispatch.** Start a `material-researcher`. It sees nothing of this conversation, so the prompt needs the subject and the full question:

   ```
   Agent(subagent_type="material-researcher", description="<short label>", prompt="subject: <subject>\nquestion: <the question, with any context needed to understand it>")
   ```

3. **Use the brief.** Answer from it and keep its file and page citations. Copy any `![[...]]` figure embed into your reply, so the figure renders in the linked note.

If the brief says the material doesn't cover something, say so plainly. Don't fill the gap from memory without telling him that the answer comes from outside his material.
