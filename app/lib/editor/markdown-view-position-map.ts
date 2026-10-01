import { decodeHtmlEntities, type JSONContent, type MarkdownToken } from '@tiptap/core';

import { splitMarkdownEditorDocument, type MarkdownFrontmatterMode } from '../markdown/editor-document';
import { createRichMarkdownManager } from '../markdown/rich-markdown-codec';
import { proseEntities } from '../markdown/core/prose-entities';

export type MarkdownViewBlock = {
  type: string;
  sourceFrom: number;
  sourceTo: number;
  richFrom: number | null;
  richTo: number | null;
  blockId?: string;
  /** Source boundaries of visible characters, including inline atoms/breaks. */
  textOffsets?: readonly number[];
};

export type MarkdownViewPositionMap = {
  sourceLength: number;
  bodyOffset: number;
  blocks: readonly MarkdownViewBlock[];
  sourceToRich: (offset: number) => number | null;
  richToSource: (position: number) => number | null;
  blockIdToSource: (id: string) => number | null;
  textToSource: (sourceFrom: number, textOffset: number) => number | null;
  sourceToText: (offset: number) => { sourceFrom: number; textOffset: number } | null;
};

type SourceView = { text: string; offsets: number[] };
type SourceNode = { type: string; view: SourceView; children?: SourceNode[]; textOffsets?: number[] };
type Token = MarkdownToken & {
  mainContent?: string; indentLevel?: number; task?: boolean; nestedTokens?: Token[];
  header?: Token[]; rows?: Token[][]; calloutTitle?: string; calloutTitleTokens?: Token[];
  detailsSummary?: string; detailsSummaryTokens?: Token[];
};

function sourceView(source: string, offset: number): SourceView {
  let text = '';
  const offsets: number[] = [];
  // Marked normalizes CRLF before lexing. Keep original UTF-16 offsets for
  // CodeMirror, including the extra CR and surrogate pairs.
  for (let index = 0; index < source.length; index++) {
    offsets.push(offset + index);
    if (source[index] === '\r' && source[index + 1] === '\n') index++;
    text += source[index] === '\r' ? '\n' : source[index];
  }
  offsets.push(offset + source.length);
  return { text, offsets };
}

function slice(view: SourceView, from: number, to = view.text.length): SourceView {
  return { text: view.text.slice(from, to), offsets: view.offsets.slice(from, to + 1) };
}

function trim(view: SourceView): SourceView {
  const from = view.text.length - view.text.trimStart().length;
  return slice(view, from, view.text.trimEnd().length);
}

function lines(view: SourceView): SourceView[] {
  const result: SourceView[] = [];
  let from = 0;
  for (let index = 0; index <= view.text.length; index++) {
    if (index === view.text.length || view.text[index] === '\n') {
      result.push(slice(view, from, index));
      from = index + 1;
    }
  }
  return result;
}

function joinLines(views: SourceView[]): SourceView {
  const offsets: number[] = [];
  let text = '';
  views.forEach((view, index) => {
    if (index) {
      text += '\n';
      // The preceding line's end points at its actual source newline.
      offsets.push(views[index - 1].offsets.at(-1)!);
    }
    text += view.text;
    offsets.push(...view.offsets.slice(0, -1));
  });
  offsets.push(views.at(-1)?.offsets.at(-1) ?? 0);
  return { text, offsets };
}

/** Match the parser's deindented lines to their same physical source lines.
 * This is exact, ordered syntax alignment; repeated paragraphs cannot select
 * another occurrence elsewhere in the document. */
function deindent(view: SourceView, text: string): SourceView | null {
  const originals = lines(view);
  const wanted = text.split('\n');
  const result: SourceView[] = [];
  let originalIndex = 0;
  for (const line of wanted) {
    while (originalIndex < originals.length && !originals[originalIndex].text.trim() && line) originalIndex++;
    const original = originals[originalIndex++];
    if (!original || !original.text.endsWith(line)) return null;
    result.push(slice(original, original.text.length - line.length));
  }
  return joinLines(result);
}

function tokenTextView(token: Token, view: SourceView): SourceView | null {
  const raw = (token.tokens ?? []).map(child => child.raw ?? '').join('');
  const text = raw || token.text || '';
  const index = view.text.indexOf(text);
  return index < 0 ? deindent(view, text) : slice(view, index, index + text.length);
}

function decodedOffsets(view: SourceView, decoded = decodeHtmlEntities(proseEntities(view.text))): number[] | null {
  const result = [view.offsets[0]];
  let rendered = '';
  for (let index = 0; index < view.text.length;) {
    const entity = view.text.slice(index).match(/^&(?:#x[0-9a-f]+|#\d+|[a-z][a-z\d]+);/iu)?.[0];
    const raw = entity ?? view.text[index];
    const visible = entity ? decodeHtmlEntities(proseEntities(entity)) : raw;
    for (let character = 0; character < visible.length; character++) {
      result.push(view.offsets[index + (character === visible.length - 1 ? raw.length : 0)]);
    }
    rendered += visible;
    index += raw.length;
  }
  return rendered === decoded ? result : null;
}

function inlineOffsets(tokens: Token[], view: SourceView): number[] | null {
  const result: number[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const raw = token.raw ?? '';
    if (!view.text.startsWith(raw, cursor)) return null;
    const part = slice(view, cursor, cursor + raw.length);
    cursor += raw.length;
    let points: number[] | null;
    if (token.type === 'br' || ['image', 'inlineMath', 'blockMath', 'markdownMention', 'obsidianWikiLink', 'markdownFootnoteReference', 'canvasPortableImage'].includes(token.type ?? '')) {
      points = [part.offsets[0], part.offsets.at(-1)!];
    } else if (token.tokens?.length) {
      const child = tokenTextView(token, part);
      points = child ? inlineOffsets(token.tokens as Token[], child) : null;
    } else if (token.type === 'text') {
      points = decodedOffsets(part, decodeHtmlEntities(token.text ?? raw));
    } else if (token.type === 'escape') {
      // Canvas's numeric prose-entity tokenizer deliberately uses Marked's
      // already-decoded escape token. Its raw is an entity, not a backslash
      // followed by one literal character.
      points = /^&#(?:x[0-9a-f]+|\d+);$/iu.test(raw)
        ? decodedOffsets(part, token.text)
        : decodedOffsets(slice(part, Math.max(0, raw.length - (token.text?.length ?? 1))), token.text);
    } else if (token.type === 'codespan') {
      const marker = raw.match(/^`+/u)?.[0].length ?? 0;
      let content = slice(part, marker, raw.length - marker);
      const text = token.text ?? content.text;
      if (content.text.replace(/\n/gu, ' ') !== text && content.text.startsWith(' ') && content.text.endsWith(' ')) {
        content = slice(content, 1, content.text.length - 1);
      }
      points = content.text.replace(/\n/gu, ' ') === text ? content.offsets : null;
    } else if (token.type === 'html' && /^<br\s*\/?>$/iu.test(raw)) {
      points = [part.offsets[0], part.offsets.at(-1)!];
    } else {
      points = decodedOffsets(part, token.text ?? raw);
    }
    if (!points) return null;
    if (!result.length) result.push(points[0]);
    // Markdown wrappers occupy source space but no rich text space.
    result[result.length - 1] = points[0];
    result.push(...points.slice(1));
  }
  return result.length ? result : [view.offsets[0]];
}

function textNode(type: string, token: Token, view: SourceView): SourceNode {
  const content = tokenTextView(token, view);
  return { type, view, textOffsets: content
    ? inlineOffsets((token.tokens ?? []) as Token[], content) ?? undefined : undefined };
}

function tableNodes(token: Token, view: SourceView): SourceNode[] {
  const physicalLines = lines(view);
  const rows = [token.header ?? [], ...(token.rows ?? [])];
  return rows.map((cells, rowIndex) => {
    const line = physicalLines[rowIndex === 0 ? 0 : rowIndex + 1];
    if (!line) return { type: 'tableRow', view };
    const separators = [-1];
    for (let index = 0; index < line.text.length; index++) {
      if (line.text[index] !== '|') continue;
      let backslashes = 0;
      for (let previous = index - 1; previous >= 0 && line.text[previous] === '\\'; previous--) backslashes++;
      if (backslashes % 2 === 0) separators.push(index);
    }
    separators.push(line.text.length);
    const cellViews: SourceView[] = [];
    for (let index = 1; index < separators.length; index++) {
      const cell = trim(slice(line, separators[index - 1] + 1, separators[index]));
      if (!cell.text && (index === 1 || index === separators.length - 1)) continue;
      cellViews.push(cell);
    }
    return { type: 'tableRow', view: line, children: cells.map((cell, index) => {
      let content = cellViews[index];
      if (!content) return { type: rowIndex === 0 ? 'tableHeader' : 'tableCell', view: line };
      // Marked removes the GFM delimiter escape before inline lexing a cell.
      // Carry that exact transform through the physical source coordinates.
      const positions = Array.from({ length: content.text.length }, (_, offset) => offset)
        .filter(offset => !(content!.text[offset] === '\\' && content!.text[offset + 1] === '|'));
      content = { text: positions.map(offset => content!.text[offset]).join(''),
        offsets: [...positions.map(offset => content!.offsets[offset]), content.offsets.at(-1)!] };
      const paragraphs: SourceNode[] = [];
      let tokens: Token[] = [];
      let rawStart = 0;
      let rawEnd = 0;
      let breaks: Token[] = [];
      const flush = () => {
        if (breaks.length >= 2) {
          while (breaks.length >= 2) {
            paragraphs.push(textNode('paragraph', { type: 'paragraph', raw: '', tokens }, slice(content, rawStart, rawEnd)));
            rawStart = rawEnd + (breaks[0].raw?.length ?? 0) + (breaks[1].raw?.length ?? 0);
            rawEnd = rawStart;
            tokens = [];
            breaks = breaks.slice(2);
          }
        }
        for (const br of breaks) {
          tokens.push({ ...br, type: 'br' });
          rawEnd += br.raw?.length ?? 0;
        }
        breaks = [];
      };
      for (const inline of cell.tokens ?? []) {
        if (inline.type === 'html' && /^<br\s*\/?>$/iu.test(inline.raw ?? '')) breaks.push(inline as Token);
        else { flush(); tokens.push(inline as Token); rawEnd += inline.raw?.length ?? 0; }
      }
      flush();
      paragraphs.push(textNode('paragraph', { type: 'paragraph', raw: '', tokens }, slice(content, rawStart, rawEnd)));
      return { type: rowIndex === 0 ? 'tableHeader' : 'tableCell', view: content, children: paragraphs };
    }) };
  });
}

function listNodes(token: Token, view: SourceView): SourceNode[] {
  const groups: SourceNode[] = [];
  let cursor = 0;
  const physicalLines = lines(view);
  for (const item of (token.items ?? []) as Token[]) {
    let itemView: SourceView | null = null;
    if (item.raw) {
      // A list's final item may own one newline beyond the list token's raw.
      const raw = view.text.startsWith(item.raw, cursor) ? item.raw : item.raw.replace(/\n$/u, '');
      if (view.text.startsWith(raw, cursor)) { itemView = slice(view, cursor, cursor + raw.length); cursor += raw.length; }
    } else {
      const start = cursor;
      const ownLine = physicalLines.find(line => line.offsets[0] === view.offsets[start]);
      const indent = ownLine?.text.match(/^\s*/u)?.[0].length ?? 0;
      const nextLine = physicalLines.find(line => line.offsets[0] > (ownLine?.offsets[0] ?? Infinity)
        && new RegExp(`^ {0,${indent}}[-+*] \\[[ xX]\\] `, 'u').test(line.text));
      const endOffset = nextLine?.offsets[0] ?? view.offsets.at(-1)!;
      const end = view.offsets.indexOf(endOffset);
      itemView = slice(view, start, end < 0 ? view.text.length : end);
      cursor = itemView.text.length + start;
    }
    if (!itemView) return [];
    const task = token.type === 'taskList' || Boolean(item.task) || item.type === 'taskItem';
    const type = task ? 'taskList' : token.ordered ? 'orderedList' : 'bulletList';
    let children: SourceNode[];
    if (item.type === 'taskItem') {
      const itemLines = lines(itemView);
      const main = item.mainContent ?? item.text ?? '';
      const first = itemLines[0];
      const content = first && first.text.endsWith(main) ? slice(first, first.text.length - main.length) : null;
      children = [{ type: 'paragraph', view: content ?? first ?? itemView,
        textOffsets: content ? inlineOffsets((item.tokens ?? []) as Token[], content) ?? undefined : undefined }];
      if (item.nestedTokens?.length) {
        const nestedRaw = item.nestedTokens.map(nested => nested.raw ?? '').join('');
        const nested = deindent(joinLines(itemLines.slice(1)), nestedRaw.trimEnd());
        if (nested) children.push(...blockNodes(item.nestedTokens, nested));
      }
    } else {
      const body = deindent(itemView, item.text ?? '');
      children = body ? blockNodes(((item.tokens ?? []) as Token[]).filter(child => child.type !== 'checkbox'), body) : [];
    }
    if (!children.length) children = [{ type: 'paragraph', view: itemView, textOffsets: [itemView.offsets[0]] }];
    const node: SourceNode = { type: task ? 'taskItem' : 'listItem', view: itemView, children };
    const group = groups.at(-1);
    if (group?.type === type) {
      group.children!.push(node);
      group.view = slice(view, view.offsets.indexOf(group.view.offsets[0]), cursor);
    } else groups.push({ type, view: itemView, children: [node] });
  }
  return groups;
}

function blockNodes(tokens: Token[], view: SourceView): SourceNode[] {
  const result: SourceNode[] = [];
  let cursor = 0;
  const firstBlock = tokens.findIndex(token => token.type !== 'space');
  let lastBlock = tokens.length - 1;
  while (lastBlock >= 0 && tokens[lastBlock].type === 'space') lastBlock--;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const raw = token.raw ?? '';
    // Child lexers sometimes retain a final newline removed from token.text.
    const available = raw.endsWith('\n') && !view.text.startsWith(raw, cursor) ? raw.replace(/\n$/u, '') : raw;
    if (!view.text.startsWith(available, cursor)) return result;
    const part = slice(view, cursor, cursor + available.length);
    cursor += available.length;
    switch (token.type) {
      case 'space': {
        const separators = (raw.match(/\n\n/gu) ?? []).length;
        const boundary = index < firstBlock || index > lastBlock;
        for (let empty = 0; empty < Math.max(0, separators - (boundary ? 0 : 1)); empty++) {
          const blank = Math.min(empty * 2 + (index < firstBlock ? 0 : boundary ? 1 : 2), part.text.length);
          const blankView = slice(part, blank, Math.min(blank + 1, part.text.length));
          result.push({ type: 'paragraph', view: blankView, textOffsets: [blankView.offsets[0]] });
        }
        break;
      }
      case 'canvasListBoundary': case 'def': break;
      case 'paragraph': case 'text': {
        const only = token.tokens?.length === 1 ? token.tokens[0] : null;
        result.push(only && ['image', 'canvasPortableImage'].includes(only.type ?? '')
          ? { type: 'image', view: part } : textNode('paragraph', token, part));
        break;
      }
      case 'heading': result.push(textNode('heading', token, part)); break;
      case 'code': {
        const firstNewline = part.text.indexOf('\n');
        const fence = /^ {0,3}(?:`{3,}|~{3,})/u.test(part.text);
        const content = fence ? slice(part, firstNewline + 1, firstNewline + 1 + (token.text?.length ?? 0)) : deindent(part, token.text ?? '');
        result.push({ type: 'codeBlock', view: part, textOffsets: content?.offsets });
        break;
      }
      case 'hr': result.push({ type: 'horizontalRule', view: part }); break;
      case 'list': case 'taskList': result.push(...listNodes(token, part)); break;
      case 'blockquote': {
        const content = deindent(part, token.text ?? '');
        result.push({ type: 'blockquote', view: part, children: content ? blockNodes((token.tokens ?? []) as Token[], content) : [] });
        break;
      }
      case 'table': result.push({ type: 'table', view: part, children: tableNodes(token, part) }); break;
      case 'canvasCallout': {
        const physicalLines = lines(part);
        const title = token.calloutTitle ?? '';
        const titleView = title ? slice(physicalLines[0], physicalLines[0].text.lastIndexOf(title)) : slice(physicalLines[0], physicalLines[0].text.length);
        const body = trim(joinLines(physicalLines.slice(1).map(line => slice(line, line.text.match(/^ {0,3}>[ \t]?/u)?.[0].length ?? 0))));
        result.push({ type: 'canvasCallout', view: part, children: [
          { type: 'canvasCalloutTitle', view: titleView, textOffsets: inlineOffsets(token.calloutTitleTokens ?? [], titleView) ?? undefined },
          ...blockNodes((token.tokens ?? []) as Token[], body),
        ] });
        break;
      }
      case 'canvasDetails': {
        const physicalLines = lines(part);
        const summary = token.detailsSummary ?? '';
        const summaryStart = physicalLines[1]?.text.indexOf(summary) ?? -1;
        const summaryView = summaryStart >= 0 ? slice(physicalLines[1], summaryStart, summaryStart + summary.length) : slice(part, 0, 0);
        const body = trim(joinLines(physicalLines.slice(2, physicalLines.at(-1)?.text === '' ? -2 : -1)));
        result.push({ type: 'canvasDetails', view: part, children: [
          { type: 'canvasDetailsSummary', view: summaryView, textOffsets: inlineOffsets(token.detailsSummaryTokens ?? [], summaryView) ?? undefined },
          { type: 'canvasDetailsContent', view: body, children: blockNodes((token.tokens ?? []) as Token[], body) },
        ] });
        break;
      }
      case 'markdownFootnoteDefinition': {
        const rawContent = (token.tokens ?? []).map(child => child.raw ?? '').join('');
        const body = deindent(part, rawContent.trimEnd());
        result.push({ type: 'markdownFootnoteDefinition', view: part,
          children: body ? blockNodes((token.tokens ?? []) as Token[], body) : [] });
        break;
      }
      default: result.push({ type: token.type ?? 'unknown', view: part });
    }
  }
  return result;
}

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'canvasCalloutTitle', 'canvasDetailsSummary']);
function nodeSize(node: JSONContent): number {
  if (node.type === 'text') return node.text?.length ?? 0;
  if (!node.content?.length && !TEXT_BLOCKS.has(node.type ?? '') && !['canvasDetailsContent', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'table', 'tableRow', 'tableCell', 'tableHeader', 'canvasCallout', 'canvasDetails', 'markdownFootnoteDefinition'].includes(node.type ?? '')) return 1;
  return 2 + (node.content ?? []).reduce((size, child) => size + nodeSize(child), 0);
}

function lowerBoundary(offsets: readonly number[], offset: number): number {
  let from = 0;
  let to = offsets.length - 1;
  while (from < to) {
    const middle = Math.ceil((from + to) / 2);
    if (offsets[middle] <= offset) from = middle;
    else to = middle - 1;
  }
  return from;
}

/** Build a read-only, revision-specific index. Actual source is never rewritten,
 * and an incompatible/stale rich tree never receives guessed positions. */
export function createMarkdownViewPositionMap(
  markdown: string,
  frontmatter: MarkdownFrontmatterMode = 'metadata',
  richDocument?: JSONContent | null,
): MarkdownViewPositionMap {
  const parts = splitMarkdownEditorDocument(markdown, frontmatter);
  const bodyOffset = markdown.length - parts.body.length;
  const blocks: MarkdownViewBlock[] = [];
  const manager = createRichMarkdownManager();
  let parsed: JSONContent | null = null;
  let sources: SourceNode[] = [];
  try {
    sources = blockNodes(manager.instance.lexer(parts.body) as Token[], sourceView(parts.body, bodyOffset));
  } catch { /* Opaque syntax may not have a lexical block projection. */ }
  if (richDocument !== null) {
    try { parsed = manager.parse(parts.body); }
    catch { /* Source/Read keep lexical offsets when Rich cannot parse. */ }
  }
  const actual = richDocument === undefined ? parsed : richDocument;
  // Parsing entities and Markdown marks can split one authored text run into
  // several nodes; a typing transaction can merge it again. Adjacent text
  // runs have identical document positions regardless of those mark/parser
  // boundaries. Preserve block/atom structure and exact text when checking
  // revision compatibility, rather than comparing text-node segmentation.
  const textRuns = (children: JSONContent[] = []): JSONContent[] => {
    const result: JSONContent[] = [];
    for (const child of children) {
      const previous = result.at(-1);
      if (child.type === 'text' && previous?.type === 'text') previous.text = (previous.text ?? '') + (child.text ?? '');
      else result.push(child.type === 'text' ? { type: 'text', text: child.text } : child);
    }
    return result;
  };
  const sameTree = (expected: JSONContent, current: JSONContent): boolean => {
    if (expected.type !== current.type || expected.text !== current.text) return false;
    const expectedContent = textRuns(expected.content);
    const currentContent = textRuns(current.content);
    return expectedContent.length === currentContent.length
      && expectedContent.every((child, index) => sameTree(child, currentContent[index]));
  };
  const parsedCount = parsed?.content?.length ?? 0;
  const extraTail = actual?.content?.slice(parsedCount) ?? [];
  // The mounted rich editor may expose an editable empty paragraph after its
  // final block (for example after a code block). Its zero characters are not
  // necessarily represented by Markdown. It does not shift any earlier
  // positions; give it an EOF span rather than invalidating the whole index.
  const emptyTail = extraTail.every(node => node.type === 'paragraph' && !node.content?.length);
  const comparableActual = actual && emptyTail ? { ...actual, content: actual.content?.slice(0, parsedCount) } : actual;
  const richAvailable = Boolean(parsed && comparableActual && emptyTail && sameTree(parsed, comparableActual));
  if (richAvailable && sources.length === parsedCount) {
    for (const _paragraph of extraTail) sources.push({ type: 'paragraph', view: sourceView('', markdown.length), textOffsets: [markdown.length] });
  }
  const collect = (source: SourceNode, node: JSONContent | null, position: number | null) => {
    const aligned = node?.type === source.type;
    const richFrom = aligned ? position : null;
    const richTo = aligned && position !== null ? position + nodeSize(node!) : null;
    const textOffsets = source.textOffsets && (!aligned || !node || source.textOffsets.length === nodeSize(node) - 1)
      ? source.textOffsets : aligned && node && source.type === 'paragraph' && nodeSize(node) === 2
        ? [source.view.offsets[0]] : undefined;
    blocks.push({ type: source.type, sourceFrom: source.view.offsets[0], sourceTo: source.view.offsets.at(-1)!,
      richFrom, richTo, blockId: aligned && typeof node?.attrs?.id === 'string' ? node.attrs.id : undefined, textOffsets });
    let childPosition = richFrom === null ? null : richFrom + 1;
    const matchingChildren = aligned && source.children?.length === (node?.content?.length ?? 0);
    for (let index = 0; index < (source.children?.length ?? 0); index++) {
      const child = matchingChildren ? node!.content![index] : null;
      collect(source.children![index], child, childPosition);
      if (childPosition !== null && child) childPosition += nodeSize(child);
    }
  };
  let position = 0;
  const matchingRoots = richAvailable && sources.length === actual!.content?.length;
  sources.forEach((source, index) => {
    const node = matchingRoots ? actual!.content![index] : null;
    collect(source, node, node ? position : null);
    if (node) position += nodeSize(node);
  });
  const sourceBlock = (offset: number, textOnly = false) => {
    const candidates = blocks.filter(block => (!textOnly || block.textOffsets) && block.sourceFrom <= offset && offset <= block.sourceTo);
    // Leaf spans win over their containers. At an exact next-block start use
    // the next block rather than the preceding block's terminal boundary.
    candidates.sort((left, right) => (left.sourceTo - left.sourceFrom) - (right.sourceTo - right.sourceFrom)
      || Number(Boolean(right.textOffsets)) - Number(Boolean(left.textOffsets))
      || right.sourceFrom - left.sourceFrom);
    return candidates[0] ?? blocks.filter(block => !textOnly || block.textOffsets)
      .reduce<MarkdownViewBlock | undefined>((nearest, block) => !nearest
        || Math.abs(block.sourceFrom - offset) < Math.abs(nearest.sourceFrom - offset) ? block : nearest, undefined);
  };
  const richBlock = (at: number) => blocks.filter(block => block.richFrom !== null && block.richTo !== null
    && block.richFrom <= at && at <= block.richTo).sort((left, right) =>
      Number(right.richFrom === at) - Number(left.richFrom === at)
      || (left.richTo! - left.richFrom!) - (right.richTo! - right.richFrom!))[0];
  return {
    sourceLength: markdown.length, bodyOffset, blocks,
    sourceToRich(offset) {
      const block = sourceBlock(Math.max(0, Math.min(markdown.length, offset)));
      if (!block || block.richFrom === null) return null;
      return block.richFrom + (block.textOffsets ? 1 + lowerBoundary(block.textOffsets, offset) : 0);
    },
    richToSource(at) {
      const block = richBlock(at);
      if (!block || block.richFrom === null) return null;
      return block.textOffsets?.[Math.min(block.textOffsets.length - 1, Math.max(0, at - block.richFrom - 1))] ?? block.sourceFrom;
    },
    blockIdToSource(id) { return blocks.find(block => block.blockId === id)?.sourceFrom ?? null; },
    textToSource(sourceFrom, textOffset) {
      const block = blocks.find(candidate => candidate.sourceFrom === sourceFrom && candidate.textOffsets)
        ?? blocks.find(candidate => candidate.textOffsets && candidate.sourceFrom > sourceFrom && candidate.sourceFrom - sourceFrom <= 1);
      return block?.textOffsets?.[Math.max(0, Math.min(block.textOffsets.length - 1, Math.floor(textOffset)))] ?? null;
    },
    sourceToText(offset) {
      const block = sourceBlock(offset, true);
      return block?.textOffsets ? { sourceFrom: block.sourceFrom, textOffset: lowerBoundary(block.textOffsets, offset) } : null;
    },
  };
}
