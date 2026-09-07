import { splitCanvasMarkdownForRichEditor } from './obsidian-metadata';

/** Metadata belongs to documents; in prompt fields every character is content. */
export type MarkdownFrontmatterMode = 'metadata' | 'content';

export function splitMarkdownEditorDocument(markdown: string, frontmatter: MarkdownFrontmatterMode) {
  return frontmatter === 'content'
    ? { body: markdown, prefix: '' }
    : splitCanvasMarkdownForRichEditor(markdown);
}
