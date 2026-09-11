import { attrsEqual, Extension, type JSONContent, type MarkdownRendererHelpers, type MarkdownToken } from '@tiptap/core';
import { EXPLICIT_TABLE_HARD_BREAK } from './hard-break-markers';

const markTags: Record<string, string> = { bold: 'strong', italic: 'em', strike: 's', underline: 'u', canvasHighlight: 'mark', code: 'code' };
const tagMarks: Record<string, string> = { strong: 'bold', em: 'italic', s: 'strike', u: 'underline', mark: 'canvasHighlight', code: 'code' };

/** Read the exact inline tags emitted by our serializer without requiring a browser DOM. */
export const CanvasPortableInlineMark = Extension.create({
  name: 'canvasPortableInlineMark',
  parseMarkdown(token: MarkdownToken & { canvasMark?: string }, helpers) {
    if (!token.canvasMark || !markTags[token.canvasMark]) return [];
    return helpers.applyMark(token.canvasMark, helpers.parseInline(token.tokens ?? []));
  },
  markdownTokenizer: {
    name: 'canvasPortableInlineMark', level: 'inline',
    start: (source) => source.search(/<(?:strong|em|s|u|mark|code)>/u),
    tokenize(source, _tokens, lexer) {
      const opening = source.match(/^<(strong|em|s|u|mark|code)>/u);
      if (!opening) return undefined;
      const stack: string[] = [];
      const tags = /<(\/?)(strong|em|s|u|mark|code)>/gu;
      for (const match of source.matchAll(tags)) {
        if (!match[1]) stack.push(match[2]);
        else if (stack.pop() !== match[2]) return undefined;
        if (!stack.length) {
          const raw = source.slice(0, match.index! + match[0].length);
          const text = source.slice(opening[0].length, match.index);
          return { type: 'canvasPortableInlineMark', canvasMark: tagMarks[opening[1]], raw, text, tokens: lexer.inlineTokens(text) };
        }
      }
      return undefined;
    },
  },
});

/** Preserve formatting on an inline HTML atom; links keep the regular Markdown renderer. */
export function renderMarkedInlineHtml(markup: string, marks: NonNullable<JSONContent['marks']>, helpers: Pick<MarkdownRendererHelpers, 'renderChildren'>): string {
  const wrapped = marks.filter((mark) => markTags[mark.type]).reduce((content, mark) =>
    `<${markTags[mark.type]}>${content}</${markTags[mark.type]}>`, markup);
  const remaining = marks.filter((mark) => !markTags[mark.type]);
  if (!remaining.length) return wrapped;
  let placeholder = '\uE000CanvasInlineHtml\uE001';
  const source = JSON.stringify([markup, marks]);
  while (source.includes(placeholder)) placeholder += 'X';
  return helpers.renderChildren([{ type: 'text', text: placeholder, marks: remaining }]).replace(placeholder, wrapped);
}

function literalInlineHtml(text: string): string {
  // Decode as prose after delimiter parsing, not as authored Markdown or HTML.
  return text.replace(/[\s&<>\\`*_\[\]~+]/gu, (character) => `&#${character.codePointAt(0)};`);
}

/** Preserve inline whitespace that Markdown would trim or move outside marks. */
export function renderInlineWithMarkedWhitespace(
  content: JSONContent[],
  helpers: Pick<MarkdownRendererHelpers, 'renderChildren'>,
  options: { inlineOnly?: boolean; softBreaksAsEntities?: boolean } = {},
): string {
  const startsLine = (index: number) => index === 0 || content[index - 1]?.type === 'hardBreak';
  const endsLine = (index: number) => index === content.length - 1 || content[index + 1]?.type === 'hardBreak';
  const explicitBreak = (node: JSONContent, index: number) => node.type === 'hardBreak'
    && (options.inlineOnly || startsLine(index) || endsLine(index) || Boolean(node.marks?.length));
  const unsafeSoftBreak = options.inlineOnly || options.softBreaksAsEntities
    ? /\r?\n/gu : /(?:[ \t]{2,}\r?\n|(?:\r?\n){2,})/gu;
  const explicitCode = (node: JSONContent) => node.type === 'text'
    && node.marks?.some((mark) => mark.type === 'code') && /^\s|\s$|[\r\n]/u.test(node.text ?? '');
  if (!content.some((node, index) => {
    if (explicitBreak(node, index) || explicitCode(node)) return true;
    if (node.type !== 'text' || node.marks?.some((mark) => mark.type === 'code')) return false;
    unsafeSoftBreak.lastIndex = 0;
    if (unsafeSoftBreak.test(node.text ?? '')) return true;
    if ((startsLine(index) && /^\s/u.test(node.text ?? ''))
      || (endsLine(index) && /\s$/u.test(node.text ?? ''))) return true;
    if (!node.marks?.length) return false;
    const boundary = (neighbor: JSONContent | undefined) => node.marks!.some((mark) => neighbor?.type !== 'text'
      || !neighbor.marks?.some((other) => other.type === mark.type && attrsEqual(other.attrs, mark.attrs)));
    return (/^\s/u.test(node.text ?? '') && boundary(content[index - 1]))
      || (/\s$/u.test(node.text ?? '') && boundary(content[index + 1]));
  })) {
    return helpers.renderChildren(content);
  }

  // The upstream serializer hoists whitespace outside marks before invoking a
  // mark renderer. Protect just those characters during inline serialization;
  // HTML mark wrappers avoid emphasis delimiter ambiguity next to words or
  // overlapping marks. Numeric entities preserve their exact whitespace.
  // Safe code spans keep their backticks. Whitespace-sensitive code uses the
  // portable HTML-code parser, which decodes these entities as marked text.
  const source = JSON.stringify(content);
  let prefix = '\uE000CanvasSpace';
  while (source.includes(prefix)) prefix += 'X';
  const replacements: string[] = [];
  // Protect adjacent marked whitespace too: replacing a run with HTML creates
  // new delimiter boundaries for its neighbors. Already-safe inline sequences
  // take the unchanged fast path above (e.g. ==important **context**==).
  const protectWhitespace = (space: string) => {
    const token = `${prefix}${replacements.length}\uE001`;
    replacements.push(Array.from(space, (character) => `&#${character.codePointAt(0)};`).join(''));
    return token;
  };
  const protectedContent = content.map((node, index) => {
    if (explicitCode(node)) {
      const token = `${prefix}${replacements.length}\uE001`;
      replacements.push(renderMarkedInlineHtml(literalInlineHtml(node.text ?? ''), node.marks ?? [], helpers));
      return { type: 'text', text: token };
    }
    if (explicitBreak(node, index)) {
      const token = `${prefix}${replacements.length}\uE001`;
      replacements.push(renderMarkedInlineHtml(EXPLICIT_TABLE_HARD_BREAK, node.marks ?? [], helpers));
      return { type: 'text', text: token };
    }
    if (node.type !== 'text' || node.marks?.some((mark) => mark.type === 'code')) return node;
    if (!node.marks?.length) {
      // Deleting a word can expose a space or soft newline at a block/line
      // boundary. Keep that authored text distinct from Markdown indentation.
      let text = (node.text ?? '').replace(unsafeSoftBreak, protectWhitespace);
      if (startsLine(index)) text = text.replace(/^\s+/u, protectWhitespace);
      if (endsLine(index)) text = text.replace(/\s+$/u, protectWhitespace);
      return { ...node, text };
    }
    const htmlMarks = node.marks.filter((mark) => markTags[mark.type]);
    if (htmlMarks.length && /^\s|\s$/u.test(node.text ?? '')) {
      const token = `${prefix}${replacements.length}\uE001`;
      replacements.push(htmlMarks.reduce((text, mark) => `<${markTags[mark.type]}>${text}</${markTags[mark.type]}>`,
        literalInlineHtml(node.text ?? '')));
      return { ...node, text: token, marks: node.marks.filter((mark) => !markTags[mark.type]) };
    }
    return { ...node, text: (node.text ?? '').replace(/^\s+|\s+$/gu, protectWhitespace)
      .replace(unsafeSoftBreak, protectWhitespace) };
  });
  return helpers.renderChildren(protectedContent).replace(new RegExp(`${prefix}(\\d+)\uE001`, 'gu'),
    (_token, index: string) => replacements[Number(index)]);
}
