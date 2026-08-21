import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Mathematics from '@tiptap/extension-mathematics';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import UniqueID from '@tiptap/extension-unique-id';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

import { getMarkdownSourceModeReason } from '@/app/lib/editor/text-editor-guards';
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

export type MarkdownRichModeAnalysis =
  | {
      mode: 'rich';
      body: string;
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
    Markdown.configure({
      markedOptions: { gfm: true, breaks: false },
      indentation: { style: 'space', size: 2 },
    }),
  ];
}

export function createRichMarkdownManager() {
  return new MarkdownManager({
    extensions: richMarkdownCodecExtensions(),
    markedOptions: { gfm: true, breaks: false },
    indentation: { style: 'space', size: 2 },
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
    if (serialized !== parts.body) return { mode: 'source', reason: 'roundtrip_changed' };
  } catch {
    return { mode: 'source', reason: 'parse_failed' };
  }

  return { mode: 'rich', prefix: parts.prefix, body: parts.body };
}
