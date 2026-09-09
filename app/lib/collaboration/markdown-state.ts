import 'server-only';

import { preserveAlignedStableIds, stableIdCounts, type RichMarkdownJsonNode } from '../editor/rich-node-identities';

import { generateRichNodeIds } from '../editor/generate-rich-node-ids';
import { getSchema, type JSONContent } from '@tiptap/core';
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
import { equivalentRichDocument } from '../markdown/core/equivalence';
import { CollaborationBlockTree } from './block-tree';
import { readRichDocumentJson, richDocumentFormat, type RichDocumentFormat } from './rich-document';

export function richMarkdownSchemaExtensions() {
  return richMarkdownCodecExtensions();
}

function markdownManager() {
  return createRichMarkdownManager();
}

function createRichDocument(json: JSONContent, format: RichDocumentFormat): YTypes.Doc {
  const extensions = richMarkdownSchemaExtensions();
  if (format === 'tiptap_xml') return TiptapTransformer.toYdoc(json, 'body', extensions);
  const doc = new Y.Doc();
  try {
    const content = json.content?.length ? json : generateRichNodeIds({ type: 'doc', content: [{ type: 'paragraph' }] }, extensions);
    CollaborationBlockTree.create(doc, getSchema(extensions).nodeFromJSON(content));
    return doc;
  } catch (error) { doc.destroy(); throw error; }
}

/** Only the fenced lifecycle migration may replace a persisted representation. */
export function convertRichMarkdownYDoc(source: YTypes.Doc, format: RichDocumentFormat): YTypes.Doc {
  const doc = createRichDocument(readRichDocumentJson(source), format);
  for (const name of ['frontmatter', 'bodyFinalLineEnding']) {
    const value = source.getText(name).toString();
    if (value) doc.getText(name).insert(0, value);
  }
  return doc;
}

export function createRichMarkdownYDoc(markdown: string, format: RichDocumentFormat = 'tiptap_xml'): YTypes.Doc {
  const parts = splitCanvasMarkdownForRichEditor(markdown);
  const manager = markdownManager();
  const extensions = richMarkdownSchemaExtensions();
  const json = generateRichNodeIds(manager.parse(parts.body), extensions);
  const doc = createRichDocument(json, format);
  if (parts.prefix) doc.getText('frontmatter').insert(0, parts.prefix);
  const finalLineEnding = parts.body.match(/((?:\r?\n)+)$/u)?.[1];
  if (finalLineEnding) doc.getText('bodyFinalLineEnding').insert(0, finalLineEnding);
  return doc;
}

export function richMarkdownFromYDoc(doc: YTypes.Doc): string {
  const json = readRichDocumentJson(doc);
  const serializedBody = markdownManager().serialize(json);
  const body = restoreRichMarkdownFinalLineEnding(
    doc.getText('bodyFinalLineEnding').toString(),
    serializedBody,
  );
  return composeCanvasMarkdownDocument(doc.getText('frontmatter').toString(), body);
}

/**
 * Applies a complete Markdown source edit to the authoritative rich Y.Doc.
 * The representation adapter preserves existing identities and shared text.
 * Block placement changes never replace the corresponding text fragment.
 */
export function replaceRichMarkdownInYDoc(
  doc: YTypes.Doc,
  markdown: string,
  origin?: unknown,
): void {
  const replacement = createRichMarkdownYDoc(markdown);
  try {
    const currentJson = readRichDocumentJson(doc) as RichMarkdownJsonNode;
    const json = readRichDocumentJson(replacement) as RichMarkdownJsonNode;
    preserveAlignedStableIds(currentJson, json, stableIdCounts(currentJson));
    const schema = getSchema(richMarkdownSchemaExtensions());
    const proseMirrorDocument = schema.nodeFromJSON(json);
    const parts = splitCanvasMarkdownForRichEditor(markdown);
    doc.transact(() => {
      if (richDocumentFormat(doc) === 'tiptap_blocks') {
        const tree = new CollaborationBlockTree(doc, schema);
        tree.applyDocumentChange(tree.read(), proseMirrorDocument, origin);
      } else {
        YProsemirror.updateYFragment(
          doc,
          doc.getXmlFragment('body'),
          proseMirrorDocument,
          { mapping: new Map(), isOMark: new Map() },
        );
      }
      const frontmatter = doc.getText('frontmatter');
      if (frontmatter.length > 0) frontmatter.delete(0, frontmatter.length);
      if (parts.prefix) frontmatter.insert(0, parts.prefix);
      const bodyFinalLineEnding = doc.getText('bodyFinalLineEnding');
      if (bodyFinalLineEnding.length > 0) bodyFinalLineEnding.delete(0, bodyFinalLineEnding.length);
      const finalLineEnding = parts.body.match(/((?:\r?\n)+)$/u)?.[1];
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
    json = readRichDocumentJson(doc);
    const schemaDocument = getSchema(richMarkdownSchemaExtensions()).nodeFromJSON(json);
    // A new Y.Doc can be completely empty before the first editor mounts.
    if (schemaDocument.content.size > 0) schemaDocument.check();
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
    if (richMarkdownFromYDoc(roundtrip) !== markdown
      || !equivalentRichDocument(json, readRichDocumentJson(roundtrip))) {
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
