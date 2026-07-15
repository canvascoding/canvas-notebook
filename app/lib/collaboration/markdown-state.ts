import 'server-only';

import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Mathematics from '@tiptap/extension-mathematics';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import UniqueID, { generateUniqueIds } from '@tiptap/extension-unique-id';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import type * as YTypes from 'yjs';

import {
  composeCanvasMarkdownDocument,
  splitCanvasMarkdownForRichEditor,
} from '@/app/lib/markdown/obsidian-metadata';
import { TiptapTransformer, Y } from './server-runtime';

export const RICH_MARKDOWN_UNIQUE_ID_TYPES = 'all' as const;

export function richMarkdownSchemaExtensions() {
  return [
    StarterKit.configure({ link: false }),
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

function markdownManager() {
  return new MarkdownManager({
    extensions: richMarkdownSchemaExtensions(),
    markedOptions: { gfm: true, breaks: false },
    indentation: { style: 'space', size: 2 },
  });
}

export function createRichMarkdownYDoc(markdown: string): YTypes.Doc {
  const parts = splitCanvasMarkdownForRichEditor(markdown);
  const manager = markdownManager();
  const extensions = richMarkdownSchemaExtensions();
  const json = generateUniqueIds(manager.parse(parts.body), extensions);
  const doc = TiptapTransformer.toYdoc(json, 'body', extensions);
  if (parts.prefix) doc.getText('frontmatter').insert(0, parts.prefix);
  return doc;
}

export function richMarkdownFromYDoc(doc: YTypes.Doc): string {
  const json = TiptapTransformer.fromYdoc(doc, 'body');
  const body = markdownManager().serialize(json);
  return composeCanvasMarkdownDocument(doc.getText('frontmatter').toString(), body);
}

export type RichMarkdownValidation = {
  valid: boolean;
  code?: 'schema_invalid' | 'stable_id_missing' | 'stable_id_duplicate' | 'roundtrip_unstable';
  markdown?: string;
};

function stableIdsFromJson(value: unknown, ids: string[], missing: { value: boolean }): void {
  if (!value || typeof value !== 'object') return;
  const node = value as { type?: unknown; attrs?: Record<string, unknown> | null; content?: unknown[] };
  if (typeof node.type === 'string' && node.type !== 'doc' && node.type !== 'text') {
    const id = node.attrs?.id;
    if (typeof id !== 'string' || !id.trim()) missing.value = true;
    else ids.push(id);
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) stableIdsFromJson(child, ids, missing);
  }
}

/** Validates the authoritative rich document without mutating it. */
export function validateRichMarkdownYDoc(doc: YTypes.Doc): RichMarkdownValidation {
  let json: unknown;
  let markdown: string;
  try {
    json = TiptapTransformer.fromYdoc(doc, 'body');
    markdown = richMarkdownFromYDoc(doc);
  } catch {
    return { valid: false, code: 'schema_invalid' };
  }

  const ids: string[] = [];
  const missing = { value: false };
  stableIdsFromJson(json, ids, missing);
  if (missing.value) return { valid: false, code: 'stable_id_missing', markdown };
  if (new Set(ids).size !== ids.length) return { valid: false, code: 'stable_id_duplicate', markdown };

  let roundtrip: YTypes.Doc | null = null;
  try {
    roundtrip = createRichMarkdownYDoc(markdown);
    if (richMarkdownFromYDoc(roundtrip) !== markdown) {
      return { valid: false, code: 'roundtrip_unstable', markdown };
    }
  } catch {
    return { valid: false, code: 'roundtrip_unstable', markdown };
  } finally {
    roundtrip?.destroy();
  }
  return { valid: true, markdown };
}

export function createPlainTextYDoc(content: string): YTypes.Doc {
  const doc = new Y.Doc({ gc: true });
  if (content) doc.getText('content').insert(0, content);
  return doc;
}
