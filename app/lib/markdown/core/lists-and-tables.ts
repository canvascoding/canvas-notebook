import { OrderedList, ListItem } from '@tiptap/extension-list';
import { Table, TableKit } from '@tiptap/extension-table';
import type { JSONContent, MarkdownParseHelpers, MarkdownToken } from '@tiptap/core';

export const CanvasOrderedList = OrderedList.extend({
  parseMarkdown(token, helpers) {
    if (token.type !== 'list' || !token.ordered) return [];
    return helpers.createNode('orderedList', {
      start: Number(token.start) || 1,
      ...(token.typeMarker ? { type: token.typeMarker } : {}),
    },
      helpers.parseChildren(token.items ?? []));
  },
  // Use Marked's GFM list indentation. The alternative tokenizer deducts two
  // spaces even for a three-column marker and leaks indentation into the text.
  markdownTokenizer: {
    name: 'canvasOrderedList', level: 'block', start: () => -1,
    tokenize(source, tokens, lexer) {
      if (/^\s*\d+[.)]\s/u.test(source)) return undefined;
      return OrderedList.config.markdownTokenizer?.tokenize(source, tokens, lexer);
    },
  },
});

export const CanvasListItem = ListItem.extend({
  parseMarkdown(token, helpers) {
    const parsed = ListItem.config.parseMarkdown?.call(this, token, helpers);
    const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    for (const item of items) {
      for (const paragraph of (token.tokens?.[0]?.text?.trim() === '&nbsp;' ? (item.content ?? []).slice(0, 1) : [])) {
        if (paragraph.type === 'paragraph' && paragraph.content?.length === 1
          && paragraph.content[0].type === 'text' && ['\u00a0', '&nbsp;'].includes(paragraph.content[0].text ?? '')) {
          paragraph.content = [];
        }
      }
    }
    return parsed ?? [];
  },
  renderMarkdown(node, helpers, context) {
    const rendered = ListItem.config.renderMarkdown?.call(this, node, helpers, context) ?? '';
    const prefix = rendered.match(/^(?:\S+[.)] |[-+*] )/u)?.[0];
    const first = node.content?.[0];
    if (!prefix || !first) return rendered;
    // GFM needs a whitespace entity to recognize an otherwise empty first item.
    if (first.type === 'paragraph' && !first.content?.length) return prefix + '&nbsp;' + rendered.slice(prefix.length);
    const firstParagraph = helpers.renderChildren([first]);
    if (!firstParagraph.includes('\n')) return rendered;
    return prefix + firstParagraph.replace(/\n/gu, '\n' + ' '.repeat(prefix.length))
      + rendered.slice(prefix.length + firstParagraph.length);
  },
});

function parseTableCell(tokens: MarkdownToken[], helpers: MarkdownParseHelpers): JSONContent[] {
  const paragraphs: JSONContent[] = [];
  let inline: JSONContent[] = [];
  let breaks = 0;
  const flushBreaks = () => {
    while (breaks >= 2) {
      paragraphs.push(helpers.createNode('paragraph', undefined, inline));
      inline = [];
      breaks -= 2;
    }
    if (breaks) inline.push(helpers.createNode('hardBreak'));
    breaks = 0;
  };
  for (const token of tokens) {
    if (token.type === 'html' && /^<br\s*\/?>$/iu.test(token.raw ?? '')) {
      breaks += 1;
      continue;
    }
    flushBreaks();
    inline.push(...helpers.parseInline([token]));
  }
  flushBreaks();
  paragraphs.push(helpers.createNode('paragraph', undefined, inline));
  return paragraphs;
}

export const CanvasTable = Table.extend({
  parseMarkdown(token, helpers) {
    const alignments = Array.isArray(token.align) ? token.align : [];
    const row = (cells: MarkdownToken[], header: boolean) => helpers.createNode('tableRow', undefined,
      cells.map((cell, index) => helpers.createNode(header ? 'tableHeader' : 'tableCell',
        alignments[index] ? { align: alignments[index] } : undefined,
        parseTableCell(cell.tokens ?? [], helpers))));
    return helpers.createNode('table', undefined, [
      ...(token.header ? [row(token.header, true)] : []),
      ...(token.rows ?? []).map((cells: MarkdownToken[]) => row(cells, false)),
    ]);
  },
  renderMarkdown(node, helpers) {
    const rows = (node.content ?? []).map((row) => (row.content ?? []).map((cell) => ({
      header: cell.type === 'tableHeader',
      align: cell.attrs?.align ?? null,
      // Preserve spaces inside code; separate paragraphs from hard breaks.
      text: (cell.content ?? []).map((block) => helpers.renderChildren([block])
        .replace(/ {2}\r?\n/gu, '<br>').replace(/\r?\n/gu, '<br>'))
        .join('<br><br>').replace(/\|/gu, '\\|'),
    })));
    const columns = Math.max(0, ...rows.map((row) => row.length));
    if (!columns) return '';
    const widths = Array.from({ length: columns }, (_, index) => Math.max(3, ...rows.map((row) => row[index]?.text.length ?? 0)));
    const renderRow = (cells: string[]) => '| ' + widths.map((width, index) => (cells[index] ?? '').padEnd(width)).join(' | ') + ' |';
    const hasHeader = rows[0].some((cell) => cell.header);
    const header = renderRow(hasHeader ? rows[0].map((cell) => cell.text) : []);
    const separator = '| ' + widths.map((width, index) => {
      const align = rows.find((row) => row[index]?.align)?.[index].align;
      return (align === 'left' || align === 'center' ? ':' : '') + '-'.repeat(width)
        + (align === 'right' || align === 'center' ? ':' : '');
    }).join(' | ') + ' |';
    return '\n' + [header, separator, ...rows.slice(hasHeader ? 1 : 0).map((row) => renderRow(row.map((cell) => cell.text)))].join('\n') + '\n';
  },
});

export const CanvasTableKit = TableKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((extension) => extension.name === 'table'
      ? CanvasTable.configure(this.options.table || {}) : extension);
  },
});
