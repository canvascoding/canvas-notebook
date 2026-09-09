import { CanvasImage as Image } from './core/image';
import Link from '@tiptap/extension-link';
import Mathematics from '@tiptap/extension-mathematics';
import { CanvasTableKit as TableKit } from '@/app/lib/markdown/core/lists-and-tables';
import { CanvasTaskItem as TaskItem } from './core/lists-and-tables';
import { CanvasTaskList as TaskList } from './core/lists-and-tables';
import UniqueID from '@tiptap/extension-unique-id';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { CanvasCodeBlock } from './core/base-blocks';

import { getMarkdownSourceModeReason } from '@/app/lib/editor/text-editor-guards';
import {
  CANVAS_MARKDOWN_INDENTATION,
  CANVAS_MARKED_OPTIONS,
  createCanvasMarkedInstance,
  createCanvasMarkdownExtension,
} from '@/app/lib/markdown/canvas-marked';
import { canvasRichMarkdownExtensions } from '@/app/lib/markdown/canvas-rich-markdown-extensions';
import { hasObsidianRichEditorUnsupportedSyntax } from '@/app/lib/markdown/obsidian-flavored-markdown';
import { parseCanvasMarkdownDocument } from '@/app/lib/markdown/obsidian-metadata';
import { splitMarkdownEditorDocument, type MarkdownFrontmatterMode } from './editor-document';

import { restoreRichMarkdownFinalLineEnding } from './core/line-endings';
export { restoreRichMarkdownFinalLineEnding } from './core/line-endings';

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

import { equivalentMarkdownNormalization, type MarkdownSafeNormalization } from './core/equivalence';
export type { MarkdownSafeNormalization } from './core/equivalence';

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
    StarterKit.configure({ document: false, codeBlock: false, link: false, paragraph: false, blockquote: false, heading: false, orderedList: false, bulletList: false, listItem: false }),
    CanvasCodeBlock,
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

function safeRichMarkdownNormalization(markdown: string, serialized: string): MarkdownSafeNormalization[] | null {
  if (serializeRichMarkdownBody(serialized) !== serialized) return null;
  return equivalentMarkdownNormalization(markdown, serialized);
}

/**
 * Determines whether the rich editor can read and write a document without
 * changing its source representation. This is intentionally conservative:
 * uncertain inputs stay in Source mode rather than receiving a best-effort
 * whole-document serialization.
 */
export function analyzeMarkdownRichMode(
  markdown: string,
  frontmatter: MarkdownFrontmatterMode = 'metadata',
): MarkdownRichModeAnalysis {
  if (frontmatter === 'metadata' && parseCanvasMarkdownDocument(markdown).error) {
    return { mode: 'source', reason: 'invalid_frontmatter' };
  }

  const guardReason = modeReasonFromTextGuard(markdown);
  if (guardReason) return { mode: 'source', reason: guardReason };

  const parts = splitMarkdownEditorDocument(markdown, frontmatter);
  if (hasMarpBodyDirective(parts.body)) {
    return { mode: 'source', reason: 'unsupported_marp_directive' };
  }
  if (hasObsidianRichEditorUnsupportedSyntax(parts.body, { allowLeadingThematicBreak: frontmatter === 'content' })) {
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
