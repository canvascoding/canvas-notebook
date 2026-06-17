---
name: docx
description: "Use this Canvas-owned clean-room skill for creating, reading, editing, reviewing, redlining, commenting, or repairing Word `.docx` documents. Trigger for Word documents, DOCX files, memos, reports, letters, templates, tracked changes, comments, table of contents, headers, footers, page numbers, and Google Docs-targeted documents that should be authored as DOCX first."
license: "Canvas Notebook Sustainable Use License"
---

# DOCX Documents

This skill covers Word-compatible `.docx` work in Canvas Notebook. It is a
clean-room Canvas skill; do not copy vendor skill material, hidden prompts, or
proprietary helper code into this folder.

## Core Contract

- Work on a copy of any input document unless the user explicitly asks to
  overwrite a path.
- Preserve existing document style for targeted edits. For new documents, set
  explicit page size, margins, paragraph spacing, font choices, headings,
  tables, headers, and footers instead of relying on Word defaults.
- Prefer editable Word-native content: paragraphs, runs, tables, lists,
  sections, headers, footers, comments, and fields. Do not turn pages into
  screenshots unless the user asks for an image-only deliverable.
- Keep intermediate render images, PDFs, unpacked XML, and scratch files out of
  the final response unless the user asks for them.
- Store final user-facing files in the requested path or under the workspace,
  using a stable descriptive filename.

## Recommended Tools

- `python-docx` for normal document creation and structured edits.
- Standard library `zipfile` plus `lxml` for OOXML edits that `python-docx`
  cannot express, such as true comments, content controls, fields, or targeted
  XML repair.
- LibreOffice `soffice` when available for DOCX to PDF conversion.
- Poppler `pdftoppm` or `pdftocairo` when available for PDF to PNG rendering.

Install only missing local dependencies that are actually needed. Never store
API keys or secrets in a skill directory.

## Workflow

1. Identify whether the task is read/review, create, targeted edit, structural
   repair, comments/redlines, or conversion.
2. If editing an existing document, inspect the current structure before
   changing it: headings, sections, tables, images, comments, tracked changes,
   headers, footers, and metadata.
3. Make the smallest reliable edit that satisfies the request. Use styles and
   reusable helper functions instead of scattered one-off formatting.
4. For visual deliverables, render the DOCX when possible and inspect page
   images for clipping, overlap, missing glyphs, broken tables, bad page breaks,
   header/footer issues, and inconsistent spacing.
5. If render output is wrong, fix the DOCX and render again. If rendering is
   unavailable, perform structural checks and clearly state that visual QA could
   not be completed.

## Common Tasks

- **Read or summarize:** extract text with `python-docx`; inspect tables and
  images separately; render if layout matters.
- **Create a new document:** build with `python-docx`, define styles up front,
  then add content. Use real tables and lists.
- **Targeted edit:** preserve existing formatting. Avoid document-wide restyles
  unless asked.
- **Comments:** use OOXML comments only when true Word comments are required.
  Otherwise, a review memo or inline markup may be safer.
- **Tracked changes:** true Word redlines require OOXML patching. If exact
  revision semantics matter, validate in Word-compatible tooling after writing.
- **Google Docs target:** create a clean `.docx` first. Avoid Word-only visual
  effects that import poorly, such as decorative title rules, complex floating
  objects, and brittle fields.

## Final Checks

- Final DOCX opens without repair warnings.
- No placeholder tokens, internal notes, or unresolved TODOs remain.
- Tables fit within margins and have readable column widths.
- Headers, footers, page numbering, links, and references are intentional.
- For high-stakes documents, mention any environment limitation that prevented
  render or Word-native validation.
