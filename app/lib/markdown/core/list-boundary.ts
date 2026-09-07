import type { JSONContent, RenderContext } from '@tiptap/core';

// A standard invisible Markdown comment separates lists without adding an
// authored paragraph or changing their numbering. Only this exact marker is
// consumed by the importer; other HTML/comments retain the source safeguards.
export const LIST_BOUNDARY_MARKDOWN = '<!-- canvas-list-boundary -->';
export const LIST_BOUNDARY_PATTERN = /^ {0,3}<!-- canvas-list-boundary -->[ \t]*(?:\r?\n|$)/u;
export const LIST_BOUNDARY_START_PATTERN = new RegExp(LIST_BOUNDARY_PATTERN.source, 'mu');

export function preserveAdjacentListBoundary(node: JSONContent, context: RenderContext, markdown: string): string {
  return context.previousNode?.type === node.type
    ? `${LIST_BOUNDARY_MARKDOWN}\n\n${markdown}` : markdown;
}
