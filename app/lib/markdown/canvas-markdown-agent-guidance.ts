export const CANVAS_MARKDOWN_GUIDANCE_REVISION = 6;
export const CANVAS_MARKDOWN_GUIDANCE_MARKER =
  `<!-- canvas-markdown-guidance:v${CANVAS_MARKDOWN_GUIDANCE_REVISION} -->`;

export const CANVAS_MARKDOWN_AGENT_GUIDANCE = `${CANVAS_MARKDOWN_GUIDANCE_MARKER}
## Canvas Markdown Formatting

Canvas renders GitHub Flavored Markdown plus Obsidian-style workspace notation and LaTeX math. Use these forms consistently in chat replies and Markdown documents:
- Use headings, lists, task lists, tables, blockquotes, fenced code blocks, and ordinary Markdown links as usual.
- In saved Markdown documents, link workspace notes with \`[[path/to/note]]\`, sections with \`[[path/to/note#Heading]]\`, block IDs with \`[[path/to/note#^block-id]]\`, and optional labels with \`[[path/to/note|Label]]\`. Paths are workspace-relative and normally omit the \`.md\` suffix.
- For a jump to a heading in the same Markdown document, use \`[Visible link label](#heading-anchor)\`. Canvas derives \`heading-anchor\` from the visible heading: lowercase it, keep letters and numbers (including characters such as ä, ö, and ü), remove punctuation, and replace one or more spaces or hyphens with one hyphen. Example: \`## Installation & Setup\` is linked as \`[Go to setup](#installation-setup)\`.
- Repeated headings receive unique suffixes in document order: \`#topic\`, \`#topic-1\`, \`#topic-2\`, and so on. Prefer unique heading text when creating a table of contents. Use the exact generated anchor after \`#\`; do not put the visible heading text or a Canvas browser URL there.
- Never use a Canvas Notebook browser URL or route as an internal document link. Use wiki-links for other workspace Markdown documents, document-local anchors for jumps within the current document, ordinary Markdown links such as \`[Brief PDF](assets/brief.pdf)\` for non-note workspace files, and ordinary Markdown links for external websites.
- Embed another workspace Markdown document with \`![[path/to/note]]\`. This wiki-embed form is only for Markdown documents, not images or other files.
- Display a workspace image with ordinary Markdown image syntax such as \`![Product photo](assets/product.png)\`. Always include the workspace-relative path; do not use \`![[assets/product.png]]\` for images. In chat replies, use \`[Visible label](path/to/file.ext)\` for workspace files that should be linked without being displayed inline.
- Use \`==highlight==\` for highlighted text and \`> [!note] Title\` for callouts.
- Use collapsible sections with \`<details>\`, a \`<summary>Visible title</summary>\` on the next line, the section content, and a closing \`</details>\`. Do not put blank lines between the opening tag and the summary.
- Add a footnote reference with \`[^source]\` and its definition on a separate line as \`[^source]: Footnote content\`. Keep every footnote identifier unique within the document.
- Write bare email addresses without escaping the \`@\` character, for example \`name@example.com\`. Use an explicit link such as \`[name@example.com](mailto:name@example.com)\` only when the address should be clickable.
- For an intentional hard line break, end the line with two spaces. Do not use a trailing backslash as a line-break marker in saved Markdown documents.
- Do not wrap a saved document body in escaped separator lines such as \`\\---\`. Use \`---\` only for YAML frontmatter delimiters or when an actual thematic break is intended.
- Write inline math as \`$E = mc^2$\`. Write display math with opening and closing \`$$\` delimiters on separate lines. Escape a literal currency dollar as \`\\$\` when it could be mistaken for math.
- Keep every Markdown fence, wiki-link bracket, and math delimiter balanced. Do not put formulas in code fences unless the user wants literal LaTeX source.
- Mermaid diagrams use fenced \`mermaid\` code blocks.
- Obsidian comments \`%%...%%\` belong in documents and are hidden in rendered output; do not use them to hide relevant information from the user.

### Canvas Markdown document properties

When creating a new user-facing note, report, plan, research document, or other knowledge document, save it as Markdown and begin it with YAML frontmatter. Use this default shape:

\`\`\`yaml
---
title: Clear document title
tags:
  - type/note
  - topic/example
  - status/draft
aliases:
  - Optional short name
---
\`\`\`

- Include a useful \`title\` and normally 2–5 specific \`tags\`. Omit \`aliases\` when there is no genuine alternative name.
- Write tags as a YAML list. Prefer lowercase hierarchical tags such as \`type/report\`, \`topic/customer-research\`, \`project/redesign\`, and \`status/draft\`; use kebab-case inside each segment.
- Choose tags from the document's actual content. Reuse established workspace tags when they fit; do not add vague or decorative tags merely to reach a count.
- Preserve existing frontmatter, unknown properties, comments, aliases, and tags when editing a document. Merge deliberately instead of replacing the whole metadata block.
- Do not add this user-document frontmatter to source code, generated data, README/AGENTS/SKILL instruction files, or technical configuration unless the user explicitly requests it.
- Add meaningful wiki-links where a real relationship exists. Do not fabricate links solely to make the Knowledge Graph denser.`;

const TOOL_GUIDANCE_ANCHOR = '# Canvas Base Tool Guidance';
const ANY_CANVAS_MARKDOWN_GUIDANCE_MARKER = /<!-- canvas-markdown-guidance:v\d+ -->/;

export function hasCurrentCanvasMarkdownAgentGuidance(systemPrompt: string): boolean {
  const markerIndex = systemPrompt.indexOf(CANVAS_MARKDOWN_GUIDANCE_MARKER);
  if (markerIndex < 0) return false;

  const toolGuidanceIndex = systemPrompt.indexOf(TOOL_GUIDANCE_ANCHOR);
  return toolGuidanceIndex < 0 || markerIndex < toolGuidanceIndex;
}

/**
 * Adds the fixed Markdown contract to legacy snapshots without reloading their
 * editable AGENTS.md/SOUL.md sections from disk.
 */
export function ensureCanvasMarkdownAgentGuidance(systemPrompt: string): string {
  if (hasCurrentCanvasMarkdownAgentGuidance(systemPrompt)) {
    return systemPrompt;
  }

  const legacyMarker = ANY_CANVAS_MARKDOWN_GUIDANCE_MARKER.exec(systemPrompt);
  if (legacyMarker) {
    const markerIndex = legacyMarker.index;
    const anchorIndex = systemPrompt.indexOf(TOOL_GUIDANCE_ANCHOR, markerIndex);
    if (anchorIndex >= 0) {
      const prefix = systemPrompt.slice(0, markerIndex).trimEnd();
      const suffix = systemPrompt.slice(anchorIndex).trimStart();
      return `${prefix}\n\n${CANVAS_MARKDOWN_AGENT_GUIDANCE}\n\n${suffix}`;
    }

    const guidanceHeading = '## Canvas Markdown Formatting';
    const guidanceHeadingIndex = systemPrompt.indexOf(guidanceHeading, markerIndex);
    const nextHeading = /^#{1,2} .+$/gm;
    nextHeading.lastIndex = guidanceHeadingIndex >= 0
      ? guidanceHeadingIndex + guidanceHeading.length
      : markerIndex + legacyMarker[0].length;
    const boundary = nextHeading.exec(systemPrompt);
    if (boundary) {
      const prefix = systemPrompt.slice(0, markerIndex).trimEnd();
      const suffix = systemPrompt.slice(boundary.index).trimStart();
      return `${prefix}\n\n${CANVAS_MARKDOWN_AGENT_GUIDANCE}\n\n${suffix}`;
    }
  }

  const anchorIndex = systemPrompt.indexOf(TOOL_GUIDANCE_ANCHOR);
  if (anchorIndex >= 0) {
    const prefix = systemPrompt.slice(0, anchorIndex).trimEnd();
    const suffix = systemPrompt.slice(anchorIndex).trimStart();
    return `${prefix}\n\n${CANVAS_MARKDOWN_AGENT_GUIDANCE}\n\n${suffix}`;
  }

  const firstLineEnd = systemPrompt.indexOf('\n');
  if (firstLineEnd >= 0) {
    return `${systemPrompt.slice(0, firstLineEnd)}\n\n${CANVAS_MARKDOWN_AGENT_GUIDANCE}\n${systemPrompt.slice(firstLineEnd)}`;
  }

  return `${CANVAS_MARKDOWN_AGENT_GUIDANCE}\n\n${systemPrompt}`;
}
