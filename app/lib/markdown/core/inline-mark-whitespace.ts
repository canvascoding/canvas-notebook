import { attrsEqual, Extension, type JSONContent, type MarkdownRendererHelpers } from '@tiptap/core';

const markTags: Record<string, string> = { bold: 'strong', italic: 'em', strike: 's', underline: 'u', canvasHighlight: 'mark' };
const tagTokens: Record<string, string> = { strong: 'strong', em: 'em', s: 'del', u: 'underline', mark: 'canvasHighlight' };

/** Read the exact inline tags emitted by our serializer without requiring a browser DOM. */
export const CanvasPortableInlineMark = Extension.create({
  name: 'canvasPortableInlineMark',
  markdownTokenizer: {
    name: 'canvasPortableInlineMark', level: 'inline',
    start: (source) => source.search(/<(?:strong|em|s|u|mark)>/u),
    tokenize(source, _tokens, lexer) {
      const opening = source.match(/^<(strong|em|s|u|mark)>/u);
      if (!opening) return undefined;
      const stack: string[] = [];
      const tags = /<(\/?)(strong|em|s|u|mark)>/gu;
      for (const match of source.matchAll(tags)) {
        if (!match[1]) stack.push(match[2]);
        else if (stack.pop() !== match[2]) return undefined;
        if (!stack.length) {
          const raw = source.slice(0, match.index! + match[0].length);
          const text = source.slice(opening[0].length, match.index);
          return { type: tagTokens[opening[1]], raw, text, tokens: lexer.inlineTokens(text) };
        }
      }
      return undefined;
    },
  },
});

function literalInlineHtml(text: string): string {
  // Decode as prose after delimiter parsing, not as authored Markdown or HTML.
  return text.replace(/[\s&<>\\`*_\[\]~+]/gu, (character) => `&#${character.codePointAt(0)};`);
}

/** Keep marked edge whitespace inside Markdown delimiters, without changing editor content. */
export function renderInlineWithMarkedWhitespace(content: JSONContent[], helpers: Pick<MarkdownRendererHelpers, 'renderChildren'>): string {
  if (!content.some((node, index) => {
    if (node.type !== 'text' || !node.marks?.length || node.marks.some((mark) => mark.type === 'code')) return false;
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
  // Code spans keep literal entities, so they must never use this conversion.
  const source = JSON.stringify(content);
  let prefix = '\uE000CanvasSpace';
  while (source.includes(prefix)) prefix += 'X';
  const replacements: string[] = [];
  // Protect adjacent marked whitespace too: replacing a run with HTML creates
  // new delimiter boundaries for its neighbors. Already-safe inline sequences
  // take the unchanged fast path above (e.g. ==important **context**==).
  const protectedContent = content.map((node) => {
    if (node.type !== 'text' || !node.marks?.length || node.marks.some((mark) => mark.type === 'code')) return node;
    const htmlMarks = node.marks.filter((mark) => markTags[mark.type]);
    if (htmlMarks.length && /^\s|\s$/u.test(node.text ?? '')) {
      const token = `${prefix}${replacements.length}\uE001`;
      replacements.push(htmlMarks.reduce((text, mark) => `<${markTags[mark.type]}>${text}</${markTags[mark.type]}>`,
        literalInlineHtml(node.text ?? '')));
      return { ...node, text: token, marks: node.marks.filter((mark) => !markTags[mark.type]) };
    }
    return { ...node, text: (node.text ?? '').replace(/^\s+|\s+$/gu, (space) => {
      const token = `${prefix}${replacements.length}\uE001`;
      replacements.push(Array.from(space, (character) => `&#${character.codePointAt(0)};`).join(''));
      return token;
    }) };
  });
  return helpers.renderChildren(protectedContent).replace(new RegExp(`${prefix}(\\d+)\uE001`, 'gu'),
    (_token, index: string) => replacements[Number(index)]);
}
