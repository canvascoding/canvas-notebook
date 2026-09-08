import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core';
import { renderInlineWithMarkedWhitespace, renderMarkedInlineHtml } from './inline-mark-whitespace';

export const EXPLICIT_TABLE_HARD_BREAK = '<br data-canvas-hard-break>';
export const EXPLICIT_TABLE_HARD_BREAK_PATTERN = /^<br\s+data-canvas-hard-break\s*\/?>/iu;
export const EXPLICIT_TABLE_HARD_BREAK_START = /<br\s+data-canvas-hard-break\b/iu;

function requiresExplicitBreaks(blocks: JSONContent[]): boolean {
  return blocks.some((block, blockIndex) => block.type === 'paragraph' && block.content?.some((node, index, inline) => (
    node.type === 'hardBreak' && (Boolean(node.marks?.length)
      || inline[index - 1]?.type === 'hardBreak' || inline[index + 1]?.type === 'hardBreak'
      || (index === 0 && blockIndex > 0) || (index === inline.length - 1 && blockIndex < blocks.length - 1))
  )));
}

/** Old BR pairs remain paragraph separators; ambiguous hard breaks get their own marker. */
export function renderTableCellBlocks(blocks: JSONContent[], helpers: MarkdownRendererHelpers): string {
  const explicit = requiresExplicitBreaks(blocks);
  return blocks.map((block) => {
    if (!explicit || block.type !== 'paragraph') return helpers.renderChildren([block])
      .replace(/ {2}\r?\n/gu, '<br>').replace(/\r?\n/gu, '<br>');

    const parts: string[] = [];
    let inline: JSONContent[] = [];
    for (const node of block.content ?? []) {
      if (node.type !== 'hardBreak') { inline.push(node); continue; }
      parts.push(renderInlineWithMarkedWhitespace(inline, helpers));
      inline = [];
      parts.push(renderMarkedInlineHtml(EXPLICIT_TABLE_HARD_BREAK, node.marks ?? [], helpers));
    }
    parts.push(renderInlineWithMarkedWhitespace(inline, helpers));
    return parts.join('');
  }).join('<br><br>');
}
