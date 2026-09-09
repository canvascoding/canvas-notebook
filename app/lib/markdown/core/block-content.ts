import type { JSONContent, MarkdownParseHelpers, MarkdownToken } from '@tiptap/core';

/** List lexers can label standalone block-body paragraphs as text tokens. */
export function parseMarkdownBlockChildren(tokens: MarkdownToken[], helpers: MarkdownParseHelpers): JSONContent[] {
  const parseBlocks = helpers.parseBlockChildren ?? helpers.parseChildren;
  return parseBlocks(tokens.map(child => child.type === 'text'
    ? { ...child, type: 'paragraph', tokens: child.tokens ?? [{ type: 'text', raw: child.raw, text: child.text }] }
    : child));
}

export function withMarkdownBlockChildren(helpers: MarkdownParseHelpers): MarkdownParseHelpers {
  const parse = (tokens: MarkdownToken[]) => parseMarkdownBlockChildren(tokens, helpers);
  return { ...helpers, parseChildren: parse, parseBlockChildren: parse };
}
