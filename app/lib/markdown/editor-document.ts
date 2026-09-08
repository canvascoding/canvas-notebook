import { composeCanvasMarkdownDocument, splitCanvasMarkdownForRichEditor } from './obsidian-metadata';
import { restoreRichMarkdownFinalLineEnding } from './core/line-endings';

/** Metadata belongs to documents; in prompt fields every character is content. */
export type MarkdownFrontmatterMode = 'metadata' | 'content';

export function splitMarkdownEditorDocument(markdown: string, frontmatter: MarkdownFrontmatterMode) {
  return frontmatter === 'content'
    ? { body: markdown, prefix: '' }
    : splitCanvasMarkdownForRichEditor(markdown);
}

/** A properties draft supplies metadata only; its stale body never replaces current text. */
export function mergeMarkdownEditorMetadata(draft: string, previous: string, currentBody: string): string {
  return composeCanvasMarkdownDocument(
    splitCanvasMarkdownForRichEditor(draft).prefix,
    restoreRichMarkdownFinalLineEnding(splitCanvasMarkdownForRichEditor(previous).body, currentBody),
  );
}
