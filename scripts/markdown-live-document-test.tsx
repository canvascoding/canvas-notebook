import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';

import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { analyzeMarkdownRichMode, createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import type { CollaborationDocument } from '../app/lib/collaboration/client';
import { createInitialTextCollaborationClientState } from '../app/lib/collaboration/client-state';

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
  const pending = new Y.Doc();
  source.getText('content').insert(0, 'Source only');
  const container = document.getElementById('view')!;
  const root = createRoot(container);
  const session = (document: Y.Doc, representation: string, hydrated = true) => ({ doc: document, session: { representation },
    clientState: { ...createInitialTextCollaborationClientState(), indexedDbHydrated: hydrated } }) as CollaborationDocument;
  function View({ collaboration }: { collaboration: CollaborationDocument }) {
    const snapshot = useLiveMarkdown(collaboration, 'stale file checkpoint');
    return <output data-available={snapshot.available}>{snapshot.content}</output>;
  }
  function StartupView({ collaboration, update }: { collaboration: CollaborationDocument; update: Uint8Array }) {
    const snapshot = useLiveMarkdown(collaboration, 'stale file checkpoint');
    useLayoutEffect(() => {
      // The initial sync lands after snapshot(), before the passive subscription.
      Y.applyUpdate(collaboration.doc, update);
    }, [collaboration, update]);
    return <output data-available={snapshot.available} data-mode={analyzeMarkdownRichMode(snapshot.content).mode}>
      {snapshot.content}
    </output>;
  }
  const startupDocuments: Y.Doc[] = [];
  const baseline = doc._observers.get('update')?.size ?? 0;
  try {
    const marp = readFileSync('tests/fixtures/markdown-roundtrip/marp-directive-source-only.md', 'utf8');
    const initialSource = new Y.Doc(); startupDocuments.push(initialSource);
    initialSource.getText('content').insert(0, marp);
    for (const [representation, initialDocument, expected] of [
      ['plain_text', initialSource, marp], ['tiptap_blocks', doc, 'AAA\n\nBBB\n\nCCC'],
    ] as const) {
      const receiving = new Y.Doc(); startupDocuments.push(receiving);
      await act(async () => root.render(<StartupView key={representation}
        collaboration={session(receiving, representation)} update={Y.encodeStateAsUpdate(initialDocument)} />));
      assert.equal(container.textContent, expected, 'initial sync between render and subscribe must not leave a stale empty preview');
      assert.equal(container.querySelector('output')?.getAttribute('data-available'), 'true');
      if (representation === 'plain_text') assert.equal(container.querySelector('output')?.getAttribute('data-mode'), 'source');
      else assert.equal(receiving.share.has('body'), false, 'catching up must not create legacy roots');
    }
    const deletionReceiver = new Y.Doc(); const deletionPeer = new Y.Doc();
    startupDocuments.push(deletionReceiver, deletionPeer);
    deletionReceiver.getText('content').insert(0, 'Delete this');
    Y.applyUpdate(deletionPeer, Y.encodeStateAsUpdate(deletionReceiver));
    deletionPeer.getText('content').delete(0, 'Delete this'.length);
    await act(async () => root.render(<StartupView key="deletion" collaboration={session(deletionReceiver, 'plain_text')}
      update={Y.encodeStateAsUpdate(deletionPeer)} />));
    assert.equal(container.textContent, '', 'a deletion in the same gap must not restore stale text or the file fallback');
    await act(async () => root.render(<View collaboration={session(pending, 'tiptap_blocks', false)} />));
    assert.equal(container.textContent, 'stale file checkpoint', 'startup retains the file preview until local state is known');
    assert.equal(pending.share.size, 0, 'an unhydrated block document must not acquire guessed XML roots');
    await act(async () => root.render(<View collaboration={session(pending, 'tiptap_blocks')} />));
    assert.equal(pending.share.size, 0, 'an empty IndexedDB load must not create legacy roots before the server update');
    assert.equal(container.querySelector('output')?.getAttribute('data-available'), 'false');
    await act(async () => {
      Y.applyUpdate(pending, Y.encodeStateAsUpdate(doc));
    });
    assert.equal(container.textContent, 'AAA\n\nBBB\n\nCCC');
    assert.equal(pending.share.has('body'), false, 'the first remote block update remains renderable');
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
  } finally { startupDocuments.forEach((document) => document.destroy()); doc.destroy(); source.destroy(); pending.destroy(); dom.window.close(); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
