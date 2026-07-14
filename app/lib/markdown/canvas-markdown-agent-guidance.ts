export const CANVAS_MARKDOWN_GUIDANCE_REVISION = 1;
export const CANVAS_MARKDOWN_GUIDANCE_MARKER =
  `<!-- canvas-markdown-guidance:v${CANVAS_MARKDOWN_GUIDANCE_REVISION} -->`;

export const CANVAS_MARKDOWN_AGENT_GUIDANCE = `${CANVAS_MARKDOWN_GUIDANCE_MARKER}
## Canvas Markdown Formatting

Canvas renders GitHub Flavored Markdown plus Obsidian-style workspace notation and LaTeX math. Use these forms consistently in chat replies and Markdown documents:
- Use headings, lists, task lists, tables, blockquotes, fenced code blocks, and ordinary Markdown links as usual.
- Link workspace notes with \`[[path/to/note]]\`, sections with \`[[path/to/note#Heading]]\`, block IDs with \`[[path/to/note#^block-id]]\`, and optional labels with \`[[path/to/note|Label]]\`.
- Embed workspace content with \`![[path/to/file]]\`. Use \`==highlight==\` for highlighted text and \`> [!note] Title\` for callouts.
- Write inline math as \`$E = mc^2$\`. Write display math with opening and closing \`$$\` delimiters on separate lines. Escape a literal currency dollar as \`\\$\` when it could be mistaken for math.
- Keep every Markdown fence, wiki-link bracket, and math delimiter balanced. Do not put formulas in code fences unless the user wants literal LaTeX source.
- Mermaid diagrams use fenced \`mermaid\` code blocks.
- Obsidian comments \`%%...%%\` belong in documents and are hidden in rendered output; do not use them to hide relevant information from the user.`;

const TOOL_GUIDANCE_ANCHOR = '# Canvas Base Tool Guidance';

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
