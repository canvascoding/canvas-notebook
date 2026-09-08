import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';

import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import type { CollaborationDocument } from '../app/lib/collaboration/client';

async function main() {
  const dom = new JSDOM('<!doctype html><html><body><div id="view"></div></body></html>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'DOMParser', 'MutationObserver', 'getComputedStyle'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const { useLiveMarkdown } = await import('../app/components/editor/MarkdownDocumentModes');
  const extensions = richMarkdownCodecExtensions();
  const schema = getSchema(extensions);
  const doc = new Y.Doc();
  const tree = CollaborationBlockTree.create(doc, schema.nodeFromJSON(generateUniqueIds(
    createRichMarkdownManager().parse('AAA\n\nBBB\n\nCCC'), extensions,
  )));
  const source = new Y.Doc();
  source.getText('content').insert(0, 'Source only');
  const container = document.getElementById('view')!;
  const root = createRoot(container);
  const session = (document: Y.Doc, representation: string) => ({ doc: document, session: { representation } }) as CollaborationDocument;
  function View({ collaboration }: { collaboration: CollaborationDocument }) {
    const snapshot = useLiveMarkdown(collaboration, 'stale file checkpoint');
    return <output data-available={snapshot.available}>{snapshot.content}</output>;
  }
  const baseline = doc._observers.get('update')?.size ?? 0;
  try {
    await act(async () => root.render(<View collaboration={session(doc, 'tiptap_blocks')} />));
    assert.equal(container.textContent, 'AAA\n\nBBB\n\nCCC');
    const id = tree.read().child(1).attrs.id as string;
    await act(async () => tree.move({ blockId: id, parentId: null, beforeId: null, operationId: 'move' }, 'remote'));
    assert.equal(container.textContent, 'AAA\n\nCCC\n\nBBB');
    await act(async () => (tree.content(id).get(0) as Y.XmlText).insert(3, '!'));
    assert.equal(container.textContent, 'AAA\n\nCCC\n\nBBB!');
    assert.equal(doc.share.has('body'), false);
    await act(async () => root.render(<View collaboration={session(source, 'plain_text')} />));
    assert.equal(doc._observers.get('update')?.size ?? 0, baseline);
    await act(async () => (tree.content(id).get(0) as Y.XmlText).insert(4, ' late'));
    assert.equal(container.textContent, 'Source only', 'updates from the previous document never replace the current view');
    await act(async () => root.unmount());
    assert.equal(source._observers.get('update')?.size ?? 0, 0);
    console.log('Live Read/Source subscription follows block moves and text edits and releases the previous document.');
  } finally { doc.destroy(); source.destroy(); dom.window.close(); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
