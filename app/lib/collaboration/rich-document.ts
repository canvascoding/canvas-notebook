import { getSchema, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';

import { richMarkdownCodecExtensions } from '../markdown/rich-markdown-codec';
import { BLOCK_TREE_KEY, CollaborationBlockTree } from './block-tree';

export type RichDocumentFormat = 'tiptap_xml' | 'tiptap_blocks';

/** The durable root, never the mounted editor, determines how content is read. */
export function richDocumentFormat(doc: Y.Doc): RichDocumentFormat {
  return doc.share.has(BLOCK_TREE_KEY) ? 'tiptap_blocks' : 'tiptap_xml';
}

export function readRichDocumentJson(doc: Y.Doc, schema?: Schema): JSONContent {
  const resolvedSchema = schema ?? getSchema(richMarkdownCodecExtensions());
  if (richDocumentFormat(doc) === 'tiptap_blocks') {
    return new CollaborationBlockTree(doc, resolvedSchema).read().toJSON();
  }
  // XML emits empty mark attributes and omits null node defaults. Normalize
  // through the shared schema so format comparisons use the same JSON shape.
  return resolvedSchema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('body'))).toJSON();
}
