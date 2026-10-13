import { getSchema, type JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import { CollaborationBlockTree } from '../../app/lib/collaboration/block-tree';
import { richMarkdownSchemaExtensions } from '../../app/lib/collaboration/markdown-state';
import { TiptapTransformer } from '../../app/lib/collaboration/server-runtime';
import type { RichDocumentFormat } from '../../app/lib/collaboration/rich-document';

/** Native fixtures bypass Markdown import so the original control characters survive. */
export function nativeListTextFixture(text: string, format: RichDocumentFormat): Y.Doc {
  const extensions = richMarkdownSchemaExtensions();
  const json: JSONContent = { type: 'doc', content: [{
    type: 'bulletList', attrs: { id: 'fixture-list' }, content: [{
      type: 'listItem', attrs: { id: 'fixture-item' }, content: [{
        type: 'paragraph', attrs: { id: 'fixture-paragraph' }, content: [{ type: 'text', text }],
      }],
    }],
  }] };
  const document = getSchema(extensions).nodeFromJSON(json);
  document.check();
  if (format === 'tiptap_xml') return TiptapTransformer.toYdoc(document.toJSON(), 'body', extensions);
  const doc = new Y.Doc({ gc: false });
  try { CollaborationBlockTree.create(doc, document); return doc; }
  catch (error) { doc.destroy(); throw error; }
}
