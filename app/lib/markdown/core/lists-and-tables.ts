import { portableTableCommands } from './table-commands';
import { renderTableCellBlocks } from './table-breaks';
import { OrderedList, BulletList, TaskList, TaskItem, ListItem, ORDERED_LIST_MARKER_PATTERN } from '@tiptap/extension-list';
import { Table, TableKit } from '@tiptap/extension-table';
import type { JSONContent, MarkdownParseHelpers, MarkdownRendererHelpers, MarkdownToken } from '@tiptap/core';
import { preserveAdjacentListBoundary } from './list-boundary';

const ORDERED_LIST_PREFIX = new RegExp(`^\\s*(?:${ORDERED_LIST_MARKER_PATTERN})[.)]\\s+`);

function boundedTableStart(source: string): number {
  const start = Table.config.markdownTokenizer?.start;
  if (typeof start !== 'function') return typeof start === 'string' ? source.indexOf(start) : -1;
  // The upstream table hint inspects only the first two lines. Give it those
  // same lines without splitting every remaining paragraph on each attempt.
  const first = source.indexOf('\n');
  const second = first < 0 ? -1 : source.indexOf('\n', first + 1);
  return start(second < 0 ? source : source.slice(0, second));
}

export const CanvasBulletList = BulletList.extend({
  renderMarkdown(node, helpers, context) {
    return preserveAdjacentListBoundary(node, context, BulletList.config.renderMarkdown?.call(this, node, helpers, context) ?? '');
  },
});

export const CanvasTaskList = TaskList.extend({
  renderMarkdown(node, helpers, context) {
    return preserveAdjacentListBoundary(node, context, TaskList.config.renderMarkdown?.call(this, node, helpers, context) ?? '');
  },
  markdownTokenizer: {
    ...TaskList.config.markdownTokenizer!,
    tokenize(source, tokens, lexer) {
      const start = TaskList.config.markdownTokenizer?.start;
      // Its anchored hint recognizes every possible first task item, including
      // leading blank lines. Ordinary paragraphs need no full line split.
      if (typeof start === 'function' && start(source) < 0) return undefined;
      return TaskList.config.markdownTokenizer?.tokenize(source, tokens, lexer);
    },
  },
});

export const CanvasOrderedList = OrderedList.extend({
  renderMarkdown(node, helpers, context) {
    return preserveAdjacentListBoundary(node, context, OrderedList.config.renderMarkdown?.call(this, node, helpers, context) ?? '');
  },
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
      const end = source.indexOf('\n');
      if (!ORDERED_LIST_PREFIX.test(end < 0 ? source : source.slice(0, end))) return undefined;
      if (/^\s*\d+[.)]\s/u.test(source)) return undefined;
      return OrderedList.config.markdownTokenizer?.tokenize(source, tokens, lexer);
    },
  },
});

/** Separate standalone blocks from the first paragraph without touching inline images. */
function listBlockRenderHelpers(helpers: MarkdownRendererHelpers): MarkdownRendererHelpers {
  return { ...helpers, renderChild(node, index) {
    const rendered = helpers.renderChild?.(node, index) ?? helpers.renderChildren([node]);
    return node.type !== 'paragraph' && !['bulletList', 'orderedList', 'taskList'].includes(node.type ?? '')
      && rendered && !rendered.startsWith('\n') ? '\n' + rendered : rendered;
  } };
}

export const CanvasTaskItem = TaskItem.extend({
  renderMarkdown(node, helpers, context) {
    return TaskItem.config.renderMarkdown?.call(this, node, listBlockRenderHelpers(helpers), context) ?? '';
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
    const rendered = ListItem.config.renderMarkdown?.call(this, node, listBlockRenderHelpers(helpers), context) ?? '';
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

/** Escape cell delimiters in already-serialized inline Markdown, not raw text. */
function escapeTableCellPipes(markdown: string): string {
  let escaped = '';
  let backslashes = 0;
  for (const character of markdown) {
    if (character === '|') {
      // Prose backslashes are already paired by the inline serializer. Code
      // spans keep literal backslashes: always leave an odd run before a pipe
      // so GFM cannot interpret cell content as a column delimiter.
      // Odd literal runs in code are not losslessly representable by GFM code
      // spans; the existing structural checkpoint guard must still reject them.
      escaped += backslashes % 2 === 0 ? '\\' : '\\\\';
    }
    escaped += character;
    backslashes = character === '\\' ? backslashes + 1 : 0;
  }
  return escaped;
}

export const CanvasTable = Table.extend({
  markdownTokenizer: { ...Table.config.markdownTokenizer!, start: boundedTableStart },
  addCommands() { return portableTableCommands(this.parent?.() ?? {}); },
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
      text: escapeTableCellPipes(renderTableCellBlocks(cell.content ?? [], helpers)),
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
