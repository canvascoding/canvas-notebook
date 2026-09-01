import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Mathematics from '@tiptap/extension-mathematics';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import UniqueID from '@tiptap/extension-unique-id';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

import { getMarkdownSourceModeReason } from '@/app/lib/editor/text-editor-guards';
import {
  CANVAS_MARKDOWN_INDENTATION,
  CANVAS_MARKED_OPTIONS,
  createCanvasMarkedInstance,
  createCanvasMarkdownExtension,
} from '@/app/lib/markdown/canvas-marked';
import { canvasRichMarkdownExtensions } from '@/app/lib/markdown/canvas-rich-markdown-extensions';
import { hasObsidianRichEditorUnsupportedSyntax } from '@/app/lib/markdown/obsidian-flavored-markdown';
import {
  parseCanvasMarkdownDocument,
  splitCanvasMarkdownForRichEditor,
} from '@/app/lib/markdown/obsidian-metadata';

export const RICH_MARKDOWN_UNIQUE_ID_TYPES = 'all' as const;

export type MarkdownRichModeReason =
  | 'invalid_frontmatter'
  | 'document_too_large'
  | 'long_line'
  | 'unsafe_slash_run'
  | 'unsupported_marp_directive'
  | 'unsupported_obsidian_syntax'
  | 'parse_failed'
  | 'roundtrip_changed';

export type MarkdownSafeNormalization =
  | 'escaped_email_address'
  | 'ordered_list_spacing'
  | 'hard_break_marker'
  | 'html_entity_escaping'
  | 'table_formatting';

export type MarkdownRichModeAnalysis =
  | {
      mode: 'rich';
      body: string;
      prefix: string;
    }
  | {
      mode: 'normalizable';
      body: string;
      normalizedBody: string;
      normalizations: MarkdownSafeNormalization[];
      prefix: string;
    }
  | {
      mode: 'source';
      reason: MarkdownRichModeReason;
    };

export function richMarkdownCodecExtensions() {
  return [
    StarterKit.configure({ link: false, paragraph: false }),
    ...canvasRichMarkdownExtensions(),
    Link.configure({ openOnClick: false, autolink: false }),
    Image,
    Mathematics,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit,
    UniqueID.configure({ types: RICH_MARKDOWN_UNIQUE_ID_TYPES }),
    createCanvasMarkdownExtension(),
  ];
}

export function createRichMarkdownManager() {
  return new MarkdownManager({
    extensions: richMarkdownCodecExtensions(),
    indentation: CANVAS_MARKDOWN_INDENTATION,
    marked: createCanvasMarkedInstance(),
    markedOptions: CANVAS_MARKED_OPTIONS,
  });
}

/**
 * TipTap's Markdown serializer omits a final line ending. Keeping the
 * pre-existing terminator is lossless and avoids a whole-file diff on the
 * first rich-editor transaction.
 */
export function restoreRichMarkdownFinalLineEnding(
  originalBody: string,
  serializedBody: string,
): string {
  if (serializedBody.endsWith('\n')) return serializedBody;
  const finalLineEnding = originalBody.match(/(\r?\n)$/u)?.[1];
  return finalLineEnding ? `${serializedBody}${finalLineEnding}` : serializedBody;
}

export function serializeRichMarkdownBody(
  markdown: string,
  manager = createRichMarkdownManager(),
): string {
  return restoreRichMarkdownFinalLineEnding(markdown, manager.serialize(manager.parse(markdown)));
}

function modeReasonFromTextGuard(markdown: string): MarkdownRichModeReason | null {
  const reason = getMarkdownSourceModeReason(markdown);
  if (reason === 'large-document') return 'document_too_large';
  if (reason === 'long-line') return 'long_line';
  if (reason === 'slash-runaway') return 'unsafe_slash_run';
  return null;
}

function hasMarpBodyDirective(markdown: string): boolean {
  return /<!--\s*(?:_?[a-z][\w-]*\s*:|marp\s*:)/iu.test(markdown);
}

function decodeComparableHtmlEntities(markdown: string): string {
  return markdown.replace(
    /&(amp|lt|gt|quot|#39|#x27);/giu,
    (entity, name: string) => {
      switch (name.toLowerCase()) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case '#39':
        case '#x27': return "'";
        default: return entity;
      }
    },
  );
}

function simpleMarkdownTableCells(line: string): string[] | null {
  const content = line.replace(/\r$/u, '');
  if (!content.startsWith('|') || !content.endsWith('|')) return null;

  const inner = content.slice(1, -1);
  // Complex escaped/code-span pipes stay source-only until a Markdown-aware
  // table tokenizer can prove that their cell boundaries are unchanged.
  if (/\\\||`/u.test(inner)) return null;
  return inner.split('|').map((cell) => cell.trim());
}

function simpleMarkdownTableDelimiter(cells: string[]): string[] | null {
  if (cells.length === 0) return null;
  const canonical: string[] = [];
  for (const cell of cells) {
    const match = cell.match(/^(:?)-{3,}(:?)$/u);
    if (!match) return null;
    canonical.push(`${match[1]}---${match[2]}`);
  }
  return canonical;
}

type SafeMarkdownTableToken =
  | { kind: 'line'; value: string }
  | { kind: 'table'; value: string };

function normalizeComparableMarkdownTables(markdown: string): { changed: boolean; value: string } {
  const lines = markdown.split('\n');
  const tokens: SafeMarkdownTableToken[] = [];
  let changed = false;
  let fence: { marker: '`' | '~'; length: number } | null = null;

  for (let index = 0; index < lines.length;) {
    const content = lines[index].replace(/\r$/u, '');
    const fenceMarker = content.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    if (fenceMarker) {
      const marker = fenceMarker[0] as '`' | '~';
      if (!fence) fence = { marker, length: fenceMarker.length };
      else if (marker === fence.marker && fenceMarker.length >= fence.length) fence = null;
      tokens.push({ kind: 'line', value: lines[index] });
      index += 1;
      continue;
    }
    if (fence) {
      tokens.push({ kind: 'line', value: lines[index] });
      index += 1;
      continue;
    }

    const header = simpleMarkdownTableCells(lines[index]);
    const delimiterCells = index + 1 < lines.length
      ? simpleMarkdownTableCells(lines[index + 1])
      : null;
    const delimiter = delimiterCells ? simpleMarkdownTableDelimiter(delimiterCells) : null;
    if (!header || !delimiter || header.length !== delimiter.length) {
      tokens.push({ kind: 'line', value: lines[index] });
      index += 1;
      continue;
    }

    const rows = [header, delimiter];
    let nextIndex = index + 2;
    while (nextIndex < lines.length) {
      const row = simpleMarkdownTableCells(lines[nextIndex]);
      if (!row || row.length !== header.length) break;
      rows.push(row);
      nextIndex += 1;
    }
    const canonical = rows.map((row) => `|${row.join('|')}|`).join('\n');
    const original = lines.slice(index, nextIndex).join('\n').replace(/\r/gu, '');
    if (canonical !== original) changed = true;
    tokens.push({ kind: 'table', value: canonical });
    index = nextIndex;
  }

  const normalized: SafeMarkdownTableToken[] = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (token.kind !== 'line' || !/^\r?$/u.test(token.value)) {
      normalized.push(token);
      index += 1;
      continue;
    }

    let nextIndex = index + 1;
    while (
      nextIndex < tokens.length
      && tokens[nextIndex].kind === 'line'
      && /^\r?$/u.test(tokens[nextIndex].value)
    ) {
      nextIndex += 1;
    }
    const touchesTable = normalized.at(-1)?.kind === 'table' || tokens[nextIndex]?.kind === 'table';
    if (touchesTable) {
      normalized.push({ kind: 'line', value: '' });
      if (nextIndex - index !== 1 || token.value !== '') changed = true;
    } else {
      normalized.push(...tokens.slice(index, nextIndex));
    }
    index = nextIndex;
  }

  return { changed, value: normalized.map((token) => token.value).join('\n') };
}

function safeRichMarkdownNormalization(
  markdown: string,
  serialized: string,
): MarkdownSafeNormalization[] | null {
  if (serializeRichMarkdownBody(serialized) !== serialized) return null;

  const lines = markdown.split('\n');
  const protectedLines = new Array<boolean>(lines.length).fill(false);
  const normalizations = new Set<MarkdownSafeNormalization>();
  let fence: { marker: '`' | '~'; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const content = lines[index].replace(/\r$/u, '');
    const openingFence = content.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    protectedLines[index] = Boolean(fence) || Boolean(openingFence);

    if (openingFence) {
      const marker = openingFence[0] as '`' | '~';
      if (!fence) {
        fence = { marker, length: openingFence.length };
      } else if (marker === fence.marker && openingFence.length >= fence.length) {
        fence = null;
      }
      continue;
    }

    if (fence) continue;
    if (!lines[index].includes('`')) {
      const normalizedEmails = lines[index].replace(
        /(^|[^\\\w])([A-Z0-9._%+-]+)\\@([A-Z0-9.-]+\.[A-Z]{2,})/giu,
        (match, prefix: string, local: string, domain: string, offset: number, line: string) => {
          const addressStart = offset + prefix.length;
          if (line.slice(Math.max(0, addressStart - 7), addressStart).toLowerCase() === 'mailto:') {
            return match;
          }
          normalizations.add('escaped_email_address');
          return `${prefix}${local}@${domain}`;
        },
      );
      lines[index] = normalizedEmails;
    }
    if (/(^|[^\\])\\\r?$/u.test(lines[index])) {
      lines[index] = lines[index].replace(/\\(\r?)$/u, '  $1');
      normalizations.add('hard_break_marker');
    }
  }

  if (lines.some((line, index) => (
    !protectedLines[index]
    && /<(?:!--|\/?[a-z][^>\n]*>)/iu.test(line)
  ))) {
    return null;
  }

  const orderedItem = /^(\s*)\d+[.)]\s+\S/u;
  const compacted: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const isBlank = /^\r?$/u.test(lines[index]);
    const previous = index > 0 ? lines[index - 1].replace(/\r$/u, '') : '';
    const next = index + 1 < lines.length ? lines[index + 1].replace(/\r$/u, '') : '';
    const previousItem = previous.match(orderedItem);
    const nextItem = next.match(orderedItem);
    if (
      isBlank
      && !protectedLines[index]
      && previousItem
      && nextItem
      && previousItem[1] === nextItem[1]
    ) {
      normalizations.add('ordered_list_spacing');
      continue;
    }
    compacted.push(lines[index]);
  }

  let comparableMarkdown = compacted.join('\n');
  let comparableSerialized = serialized;
  if (comparableMarkdown === comparableSerialized) {
    return (['escaped_email_address', 'ordered_list_spacing', 'hard_break_marker'] as const).filter((normalization) => (
      normalizations.has(normalization)
    ));
  }

  const decodedMarkdown = decodeComparableHtmlEntities(comparableMarkdown);
  const decodedSerialized = decodeComparableHtmlEntities(comparableSerialized);
  if (decodedMarkdown !== comparableMarkdown || decodedSerialized !== comparableSerialized) {
    normalizations.add('html_entity_escaping');
    comparableMarkdown = decodedMarkdown;
    comparableSerialized = decodedSerialized;
  }

  const normalizedMarkdownTables = normalizeComparableMarkdownTables(comparableMarkdown);
  const normalizedSerializedTables = normalizeComparableMarkdownTables(comparableSerialized);
  if (normalizedMarkdownTables.changed || normalizedSerializedTables.changed) {
    normalizations.add('table_formatting');
  }
  if (normalizedMarkdownTables.value !== normalizedSerializedTables.value) return null;

  return ([
    'escaped_email_address',
    'ordered_list_spacing',
    'hard_break_marker',
    'html_entity_escaping',
    'table_formatting',
  ] as const).filter((normalization) => (
    normalizations.has(normalization)
  ));
}

/**
 * Determines whether the rich editor can read and write a document without
 * changing its source representation. This is intentionally conservative:
 * uncertain inputs stay in Source mode rather than receiving a best-effort
 * whole-document serialization.
 */
export function analyzeMarkdownRichMode(markdown: string): MarkdownRichModeAnalysis {
  const parsed = parseCanvasMarkdownDocument(markdown);
  if (parsed.error) return { mode: 'source', reason: 'invalid_frontmatter' };

  const guardReason = modeReasonFromTextGuard(markdown);
  if (guardReason) return { mode: 'source', reason: guardReason };

  const parts = splitCanvasMarkdownForRichEditor(markdown);
  if (hasMarpBodyDirective(parts.body)) {
    return { mode: 'source', reason: 'unsupported_marp_directive' };
  }
  if (hasObsidianRichEditorUnsupportedSyntax(parts.body)) {
    return { mode: 'source', reason: 'unsupported_obsidian_syntax' };
  }

  try {
    const serialized = serializeRichMarkdownBody(parts.body);
    if (serialized !== parts.body) {
      const normalizations = safeRichMarkdownNormalization(parts.body, serialized);
      if (normalizations) {
        return {
          mode: 'normalizable',
          prefix: parts.prefix,
          body: parts.body,
          normalizedBody: serialized,
          normalizations,
        };
      }
      return { mode: 'source', reason: 'roundtrip_changed' };
    }
  } catch {
    return { mode: 'source', reason: 'parse_failed' };
  }

  return { mode: 'rich', prefix: parts.prefix, body: parts.body };
}
