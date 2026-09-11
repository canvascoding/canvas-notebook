import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core';
import { renderInlineWithMarkedWhitespace, renderMarkedInlineHtml } from './inline-mark-whitespace';
import { EXPLICIT_TABLE_HARD_BREAK } from './hard-break-markers';

export { EXPLICIT_TABLE_HARD_BREAK, EXPLICIT_TABLE_HARD_BREAK_PATTERN, EXPLICIT_TABLE_HARD_BREAK_START } from './hard-break-markers';

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
    if (!explicit || block.type !== 'paragraph') {
      const rendered = block.type === 'paragraph'
        ? renderInlineWithMarkedWhitespace(block.content ?? [], helpers, { softBreaksAsEntities: true })
        : helpers.renderChildren([block]);
      return rendered.replace(/ {2}\r?\n/gu, '<br>').replace(/\r?\n/gu, '<br>');
    }

    const parts: string[] = [];
    let inline: JSONContent[] = [];
    for (const node of block.content ?? []) {
      if (node.type !== 'hardBreak') { inline.push(node); continue; }
      parts.push(renderInlineWithMarkedWhitespace(inline, helpers, { softBreaksAsEntities: true }));
      inline = [];
      parts.push(renderMarkedInlineHtml(EXPLICIT_TABLE_HARD_BREAK, node.marks ?? [], helpers));
    }
    parts.push(renderInlineWithMarkedWhitespace(inline, helpers, { softBreaksAsEntities: true }));
    return parts.join('');
  }).join('<br><br>');
}
