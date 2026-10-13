import { getSchema, type JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import { CollaborationBlockTree } from '../../app/lib/collaboration/block-tree';
import { richMarkdownSchemaExtensions } from '../../app/lib/collaboration/markdown-state';
import { TiptapTransformer } from '../../app/lib/collaboration/server-runtime';
import type { RichDocumentFormat } from '../../app/lib/collaboration/rich-document';
import { generateRichNodeIds } from '../../app/lib/editor/generate-rich-node-ids';

/** Build native fixtures without a potentially lossy Markdown import. */
export function nativeRichDocumentFixture(json: JSONContent, format: RichDocumentFormat): Y.Doc {
  const extensions = richMarkdownSchemaExtensions();
  const document = getSchema(extensions).nodeFromJSON(generateRichNodeIds(json, extensions));
  document.check();
  if (format === 'tiptap_xml') return TiptapTransformer.toYdoc(document.toJSON(), 'body', extensions);
  const doc = new Y.Doc({ gc: false });
  try { CollaborationBlockTree.create(doc, document); return doc; }
  catch (error) { doc.destroy(); throw error; }
}

/** Native fixtures retain the exact control characters under diagnosis. */
export function nativeListTextFixture(text: string, format: RichDocumentFormat): Y.Doc {
  const json: JSONContent = { type: 'doc', content: [{
    type: 'bulletList', attrs: { id: 'fixture-list' }, content: [{
      type: 'listItem', attrs: { id: 'fixture-item' }, content: [{
        type: 'paragraph', attrs: { id: 'fixture-paragraph' }, content: [{ type: 'text', text }],
      }],
    }],
  }] };
  return nativeRichDocumentFixture(json, format);
}

/** GFM deliberately cannot encode native table column widths. */
export function nativeTableWidthFixture(format: RichDocumentFormat, text = 'Target'): Y.Doc {
  return nativeRichDocumentFixture({ type: 'doc', content: [{ type: 'table', content: [
    { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colwidth: [120] },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Width' }] }] }] },
    { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colwidth: [120] },
      content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href: 'target.md' } }] }] }] }] },
  ] }] }, format);
}

/** Apply a synthetic human width edit consistently to every cell in a column. */
export function setFixtureTableColumnWidth(doc: Y.Doc, tableId: string, width = 120): void {
  const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
  let table: ReturnType<typeof tree.read> | null = null;
  tree.read().descendants((node) => { if (node.type.name === 'table' && node.attrs.id === tableId) table = node; });
  if (!table) throw new Error('Synthetic table fixture is missing.');
  const cells: string[] = [];
  (table as ReturnType<typeof tree.read>).forEach((row) => cells.push(row.firstChild!.attrs.id));
  doc.transact(() => {
    for (const id of cells) {
      const attrs = tree.records.get(id)!.get('attributes');
      if (!(attrs instanceof Y.Map)) throw new Error('Synthetic cell attributes are missing.');
      attrs.set('colwidth', [width]);
    }
  }, 'human-width-fixture');
  tree.read().check();
}
