/**
 * Mixed-inline paste must retain stale peer edits through native history.
 * Uses actual editors, UUIDs, inline text parents and both Yjs delivery orders.
 * Run: node --conditions=react-server --import tsx scripts/collaboration-block-history-mixed-inline-test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Editor, getSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { getBlockTreeHistory } from '../app/lib/collaboration/block-tree-history';
import { validateRichMarkdownStructure } from '../app/lib/collaboration/markdown-state';
import { assertNativeDocumentSchema } from '../app/lib/collaboration/native-document-schema';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';

const paragraphId = '00000000-0000-4000-8000-000000000001';
const hardBreakId = '00000000-0000-4000-8000-000000000002';
const ownSuffix = ' Typed after paste.', peerSuffix = ' Peer keeps this.';
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const clock = (doc: Y.Doc, client: number) => Y.decodeStateVector(Y.encodeStateVector(doc)).get(client) ?? 0;
type BindingProbe = { composing: boolean; compositionTree: CollaborationBlockTree | null };
const probe = (editor: Editor) => (editor.storage as unknown as { canvasBlockTreeCollaboration: { binding: BindingProbe } }).canvasBlockTreeCollaboration.binding;

function createEditor(doc: Y.Doc, errors: Error[]) {
  return new Editor({ extensions: [
    ...richMarkdownCodecExtensions().map(extension => extension.name === 'starterKit' ? extension.configure({ undoRedo: false })
      : extension.name === 'uniqueID' ? CanvasUniqueID.configure({ types: 'all', filterTransaction: (tr: Transaction) => !isRemoteRichEditorTransaction(tr) }) : extension),
    ...createRichEditorCollaborationExtensions({ document: doc, representation: 'tiptap_blocks', awareness: null,
      user: { name: 'Fixture', color: '#123456' }, onError: error => errors.push(error) }),
  ] });
}

function findParagraph(doc: ProseMirrorNode): ProseMirrorNode | null {
  let found: ProseMirrorNode | null = null;
  doc.descendants(node => { if (node.attrs.id === paragraphId) { found = node; return false; } });
  return found;
}

function paragraphEnd(editor: Editor) {
  let end = -1;
  editor.state.doc.descendants((node, pos) => { if (node.attrs.id === paragraphId) { end = pos + node.nodeSize - 1; return false; } });
  assert.ok(end >= 1); return end;
}

function itemId(value: unknown) {
  const id = (value as { _item?: { id?: { client: number; clock: number } } } | null)?._item?.id;
  return id ? { client: id.client, clock: id.clock } : null;
}

function nativeChildren(tree: CollaborationBlockTree) {
  return tree.content(paragraphId).toArray().map(child => ({ item: itemId(child),
    kind: child instanceof Y.XmlText ? 'text' : child instanceof Y.XmlElement ? child.nodeName : 'other',
    chars: child instanceof Y.XmlText ? child.length : null }));
}

for (const [initial, inputMode] of [
  ['empty', 'ordinary'], ['already-nonempty', 'ordinary'],
  ['empty', 'composition'], ['already-nonempty', 'composition'],
] as const) {
  for (const order of ['owner-redo-first', 'peer-update-first'] as const) {
    const modeSuffix = inputMode === 'composition' ? ', real composition' : '';
    test(`mixed-inline text survives paste history: ${initial} existing paragraph, ${order}${modeSuffix}`, async t => {
      const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
      for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'HTMLDetailsElement', 'Element', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
        Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
      }
      const schema = getSchema(richMarkdownCodecExtensions());
      const ownerDoc = new Y.Doc(); ownerDoc.clientID = 11;
      const peerDoc = new Y.Doc(); peerDoc.clientID = 22;
      const ownerErrors: Error[] = [], peerErrors: Error[] = [];
      let owner: Editor | undefined, peer: Editor | undefined;
      try {
        const initialText = initial === 'already-nonempty' ? schema.text('Before') : undefined;
        CollaborationBlockTree.create(ownerDoc, schema.topNodeType.createChecked(null,
          [schema.nodes.paragraph.createChecked({ id: paragraphId }, initialText)]));
        owner = createEditor(ownerDoc, ownerErrors); await Promise.resolve();
        const initialJSON = owner.getJSON();
        if (inputMode === 'composition') {
          document.body.append(owner.view.dom); owner.view.focus();
          owner.commands.setTextSelection(paragraphEnd(owner));
          owner.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
          const active = probe(owner);
          assert.equal(owner.view.composing, true); assert.equal(active.composing, true);
          assert.ok(active.compositionTree);
          assert.notStrictEqual(active.compositionTree.doc, ownerDoc, 'mixed-inline birth uses the actual composition replica');
        }
        const ownerSchema = owner.schema;
        assert.ok(ownerSchema.nodes.hardBreak, 'real product schema must support hardBreak');
        const hardBreak = ownerSchema.nodes.hardBreak.createChecked({ id: hardBreakId });
        assert.equal(hardBreak.attrs.id, hardBreakId, 'inline hardBreak has a real stable UUID');
        const pasted = ownerSchema.nodes.paragraph.createChecked({ id: paragraphId },
          [ownerSchema.text('Before'), hardBreak, ownerSchema.text('After')]);
        owner.view.dispatch(owner.state.tr.replaceWith(0, owner.state.doc.content.size, [pasted])
          .setMeta('paste', true).setMeta('uiEvent', 'paste'));
        const pastedJSON = owner.getJSON();
        if (inputMode === 'composition') {
          const liveTree = new CollaborationBlockTree(ownerDoc, ownerSchema);
          assert.deepEqual(liveTree.read().toJSON(), pastedJSON, 'composed mixed-inline birth reaches the live Y.Doc before compositionend');
          assert.equal(getBlockTreeHistory(liveTree).can('undo'), true, 'LIVE document history already captured the composed birth');
          owner.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
          await Promise.resolve();
          assert.equal(probe(owner).composing, false); assert.equal(probe(owner).compositionTree, null);
          assert.deepEqual(owner.getJSON(), pastedJSON);
        }
        assert.equal(owner.state.doc.childCount, 1);
        assert.equal(findParagraph(owner.state.doc)?.attrs.id, paragraphId);
        assert.equal(findParagraph(owner.state.doc)?.textContent, 'BeforeAfter');
        assert.deepEqual(findParagraph(owner.state.doc)?.content.content.map(node => node.type.name), ['text', 'hardBreak', 'text']);
        assertNativeDocumentSchema(ownerDoc, 'tiptap_blocks', ownerSchema);
        assert.equal(validateRichMarkdownStructure(ownerDoc).valid, true);
        const ownerTree = new CollaborationBlockTree(ownerDoc, ownerSchema);
        assert.equal(getBlockTreeHistory(ownerTree).can('undo'), true);
        const baselineVector = Y.encodeStateVector(ownerDoc);
        Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(ownerDoc), { fixture: 'snapshot-before-history' });
        peer = createEditor(peerDoc, peerErrors); await Promise.resolve();
        const peerTree = new CollaborationBlockTree(peerDoc, peer.schema);
        // Freeze LIVE native parents before any owner history command; never use the destroyed composition replica.
        const originalRecord = ownerTree.records.get(paragraphId), originalFragment = ownerTree.content(paragraphId);
        const peerRecord = peerTree.records.get(paragraphId), peerFragment = peerTree.content(paragraphId);
        const ownerTextParents = originalFragment.toArray().filter((child): child is Y.XmlText => child instanceof Y.XmlText);
        const peerTextParents = peerFragment.toArray().filter((child): child is Y.XmlText => child instanceof Y.XmlText);
        assert.ok(ownerTextParents.some(parent => parent.toString() === 'After'), 'fixture contains the newly born second text parent');
        assert.ok(peerTextParents.some(parent => parent.toString() === 'After'));
        const beforeOwnerChildren = nativeChildren(ownerTree), beforePeerChildren = nativeChildren(peerTree);
        assert.deepEqual(owner.getJSON(), peer.getJSON());
        assert.deepEqual(beforeOwnerChildren, beforePeerChildren);
        assert.deepEqual(ownerErrors, []); assert.deepEqual(peerErrors, []);

        owner.commands.setTextSelection(paragraphEnd(owner));
        owner.view.dispatch(owner.state.tr.insertText(ownSuffix));
        assert.equal(findParagraph(owner.state.doc)?.textContent, 'BeforeAfter' + ownSuffix);
        assert.equal(owner.commands.undo(), true); assert.deepEqual(owner.getJSON(), pastedJSON);
        assert.equal(owner.commands.undo(), true); assert.deepEqual(owner.getJSON(), initialJSON);
        assert.equal(owner.commands.redo(), true); assert.deepEqual(owner.getJSON(), pastedJSON);
        assert.deepEqual(owner.getJSON(), peer.getJSON(), 'complete PM JSON and both logical UUIDs are equal before the peer edit');
        assert.deepEqual(nativeChildren(peerTree), beforePeerChildren, 'peer still edits the original mixed-inline parents');
        const afterRedoChildren = nativeChildren(ownerTree); // Diagnostic only; a valid fix may retain all text parents.

        peer.commands.setTextSelection(paragraphEnd(peer));
        const beforePeerClock = clock(peerDoc, 22);
        peer.view.dispatch(peer.state.tr.insertText(peerSuffix));
        assert.equal(findParagraph(peer.state.doc)?.textContent, 'BeforeAfter' + peerSuffix);
        assert.equal(clock(peerDoc, 22) - beforePeerClock, 17);
        const redoDelta = Y.encodeStateAsUpdate(ownerDoc, baselineVector);
        const peerDelta = Y.encodeStateAsUpdate(peerDoc, baselineVector);
        const remote = { fixture: 'delayed-remote-merge' };
        if (order === 'owner-redo-first') { Y.applyUpdate(peerDoc, redoDelta, remote); Y.applyUpdate(ownerDoc, peerDelta, remote); }
        else { Y.applyUpdate(ownerDoc, peerDelta, remote); Y.applyUpdate(peerDoc, redoDelta, remote); }
        await Promise.resolve();
        const actual = { owner: findParagraph(owner.state.doc)?.textContent ?? null, peer: findParagraph(peer.state.doc)?.textContent ?? null };
        t.diagnostic(JSON.stringify({ fixture: 'I07-mixed-inline-second-text-parent', initial, order, inputMode,
          beforeOwnerChildren, beforePeerChildren, afterRedoChildren,
          redoDelta: { bytes: redoDelta.length, hash: hash(redoDelta) }, peerDelta: { bytes: peerDelta.length, hash: hash(peerDelta) } }));
        assert.deepEqual(actual, { owner: 'BeforeAfter' + peerSuffix, peer: 'BeforeAfter' + peerSuffix },
          'FIRST post-merge assertion requires retention of the stale peer edit to the second text parent');
        assert.strictEqual(ownerTree.records.get(paragraphId), originalRecord); assert.strictEqual(ownerTree.content(paragraphId), originalFragment);
        assert.strictEqual(peerTree.records.get(paragraphId), peerRecord); assert.strictEqual(peerTree.content(paragraphId), peerFragment);
        for (const parent of ownerTextParents) assert.ok(originalFragment.toArray().includes(parent), 'owner text parent survives history');
        for (const parent of peerTextParents) assert.ok(peerFragment.toArray().includes(parent), 'peer text parent survives merge');
        const expectedJSON = structuredClone(pastedJSON);
        (expectedJSON.content![0].content![2] as { text?: string }).text = 'After' + peerSuffix;
        assert.deepEqual(owner.getJSON(), peer.getJSON());
        assert.deepEqual(owner.getJSON(), owner.schema.nodeFromJSON(expectedJSON).toJSON(), 'hardBreak, UUIDs and all text remain exact');
        assert.equal(clock(ownerDoc, 22), beforePeerClock + 17);
        assertNativeDocumentSchema(ownerDoc, 'tiptap_blocks', owner.schema);
        assertNativeDocumentSchema(peerDoc, 'tiptap_blocks', peer.schema);
        assert.deepEqual(ownerErrors, []); assert.deepEqual(peerErrors, []);
        assert.equal(ownerDoc.store.pendingStructs, null); assert.equal(ownerDoc.store.pendingDs, null);
        assert.equal(peerDoc.store.pendingStructs, null); assert.equal(peerDoc.store.pendingDs, null);
      } finally {
        owner?.destroy(); peer?.destroy(); ownerDoc.destroy(); peerDoc.destroy(); dom.window.close();
      }
    });
  }
}
