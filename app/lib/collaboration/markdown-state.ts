import 'server-only';

import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { getSchema } from '@tiptap/core';
import type * as YTypes from 'yjs';

import {
  composeCanvasMarkdownDocument,
  splitCanvasMarkdownForRichEditor,
} from '@/app/lib/markdown/obsidian-metadata';
import {
  createRichMarkdownManager,
  richMarkdownCodecExtensions,
  restoreRichMarkdownFinalLineEnding,
} from '@/app/lib/markdown/rich-markdown-codec';
import { TiptapTransformer, Y, YProsemirror } from './server-runtime';

export function richMarkdownSchemaExtensions() {
  return richMarkdownCodecExtensions();
}

function markdownManager() {
  return createRichMarkdownManager();
}

export function createRichMarkdownYDoc(markdown: string): YTypes.Doc {
  const parts = splitCanvasMarkdownForRichEditor(markdown);
  const manager = markdownManager();
  const extensions = richMarkdownSchemaExtensions();
  const json = generateUniqueIds(manager.parse(parts.body), extensions);
  const doc = TiptapTransformer.toYdoc(json, 'body', extensions);
  if (parts.prefix) doc.getText('frontmatter').insert(0, parts.prefix);
  const finalLineEnding = parts.body.match(/(\r?\n)$/u)?.[1];
  if (finalLineEnding) doc.getText('bodyFinalLineEnding').insert(0, finalLineEnding);
  return doc;
}

export function richMarkdownFromYDoc(doc: YTypes.Doc): string {
  const json = TiptapTransformer.fromYdoc(doc, 'body');
  const serializedBody = markdownManager().serialize(json);
  const body = restoreRichMarkdownFinalLineEnding(
    doc.getText('bodyFinalLineEnding').toString(),
    serializedBody,
  );
  return composeCanvasMarkdownDocument(doc.getText('frontmatter').toString(), body);
}

/**
 * Applies a complete Markdown source edit to the authoritative rich Y.Doc.
 * y-prosemirror performs a structural diff against the existing fragment, so
 * connected web editors receive a normal collaborative transaction instead
 * of a destructive whole-file replacement.
 */
export function replaceRichMarkdownInYDoc(
  doc: YTypes.Doc,
  markdown: string,
  origin?: unknown,
): void {
  const replacement = createRichMarkdownYDoc(markdown);
  try {
    const json = TiptapTransformer.fromYdoc(replacement, 'body');
    const schema = getSchema(richMarkdownSchemaExtensions());
    const proseMirrorDocument = schema.nodeFromJSON(json);
    const parts = splitCanvasMarkdownForRichEditor(markdown);
    doc.transact(() => {
      YProsemirror.updateYFragment(
        doc,
        doc.getXmlFragment('body'),
        proseMirrorDocument,
        { mapping: new Map(), isOMark: new Map() },
      );
      const frontmatter = doc.getText('frontmatter');
      if (frontmatter.length > 0) frontmatter.delete(0, frontmatter.length);
      if (parts.prefix) frontmatter.insert(0, parts.prefix);
      const bodyFinalLineEnding = doc.getText('bodyFinalLineEnding');
      if (bodyFinalLineEnding.length > 0) bodyFinalLineEnding.delete(0, bodyFinalLineEnding.length);
      const finalLineEnding = parts.body.match(/(\r?\n)$/u)?.[1];
      if (finalLineEnding) bodyFinalLineEnding.insert(0, finalLineEnding);
    }, origin);
  } finally {
    replacement.destroy();
  }
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
