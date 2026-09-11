import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';
import { richMarkdownCodecExtensions } from '../markdown/rich-markdown-codec';
import { BLOCK_TREE_KEY } from './block-tree';
import { readRichDocumentJson } from './rich-document';
import type { CollaborationSessionResponse } from './types';

/** IndexedDB's whenSynced also resolves for a new empty database. Only an
 * existing, complete native root may be used before the first network sync. */
export function hasStoredLocalDocument(doc: Y.Doc, session: CollaborationSessionResponse): boolean {
  if (doc.store.pendingStructs || doc.store.pendingDs || Y.encodeStateAsUpdate(doc).byteLength <= 2) return false;
  try {
    if (session.representation === 'plain_text') {
      return doc.share.has('content') && !doc.share.has('body') && !doc.share.has(BLOCK_TREE_KEY);
    }
    if (session.representation === 'tiptap_blocks'
      ? !doc.share.has(BLOCK_TREE_KEY) || doc.share.has('body')
      : session.representation !== 'tiptap_xml' || !doc.share.has('body') || doc.share.has(BLOCK_TREE_KEY)) return false;
    const schema = getSchema(richMarkdownCodecExtensions());
    schema.nodeFromJSON(readRichDocumentJson(doc, schema)).check();
    return true;
  } catch { return false; }
}
