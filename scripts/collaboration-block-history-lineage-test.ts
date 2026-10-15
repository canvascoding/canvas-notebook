/**
 * Delayed peer edits must survive native paste undo/redo on the same block IDs.
 * Exercises the real editor binding, document history and Yjs merge order.
 * Run: node --conditions=react-server --import tsx scripts/collaboration-block-history-lineage-test.ts
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
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';

const paragraphIds = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
] as const;
const pastedLines = ['First paste: äöü ß 😀', 'Second line preserves plain text.', 'Last paragraph.'];
const ownSuffix = ' Typed after paste.';
const peerSuffix = ' Peer keeps this.';
const ownerClient = 11, peerClient = 22;
type ItemCoordinates = { client: number; clock: number };
type MergeOrder = 'owner-redo-first' | 'peer-update-first';

function createEditor(doc: Y.Doc, errors: Error[]): Editor {
  // Same actual schema, UniqueID remote filter, disabled StarterKit history,
  // and block binding as the existing collaboration-block-editor-test helper.
  return new Editor({
    extensions: [
      ...richMarkdownCodecExtensions().map(extension => extension.name === 'starterKit'
        ? extension.configure({ undoRedo: false })
        : extension.name === 'uniqueID'
          ? CanvasUniqueID.configure({ types: 'all', filterTransaction: (transaction: Transaction) => !isRemoteRichEditorTransaction(transaction) })
          : extension),
      ...createRichEditorCollaborationExtensions({ document: doc, representation: 'tiptap_blocks',
        awareness: null, user: { name: 'Fixture', color: '#123456' }, onError: error => errors.push(error) }),
    ],
  });
}

function coordinates(value: unknown): ItemCoordinates {
  const item = (value as { _item?: { id?: ItemCoordinates } } | null)?._item;
  assert.ok(item?.id, 'fixture requires an integrated nested Y type');
  return { client: item.id.client, clock: item.id.clock };
}

function lineage(tree: CollaborationBlockTree, blockId: string) {
  return { blockId, record: coordinates(tree.records.get(blockId)), content: coordinates(tree.content(blockId)) };
}

function clock(doc: Y.Doc, client: number) {
  return Y.decodeStateVector(Y.encodeStateVector(doc)).get(client) ?? 0;
}

function findParagraph(doc: ProseMirrorNode, id: string): ProseMirrorNode | null {
  let found: ProseMirrorNode | null = null;
  doc.descendants(node => { if (node.attrs.id === id) { found = node; return false; } });
  return found;
}

function paragraph(doc: ProseMirrorNode, id: string): ProseMirrorNode {
  const found = findParagraph(doc, id);
  assert.ok(found, 'fixture paragraph UUID must remain present');
  return found;
}

function paragraphEnd(editor: Editor, id: string): number {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.attrs.id === id) { end = pos + node.nodeSize - 1; return false; }
  });
  assert.ok(end >= 1, 'fixture paragraph must have a valid text caret');
  return end;
}

function updateMetadata(update: Uint8Array) {
  return { bytes: update.length, sha256: createHash('sha256').update(update).digest('hex') };
}

for (const targetIndex of [0, 1, 2] as const) {
  for (const order of ['owner-redo-first', 'peer-update-first'] as const satisfies readonly MergeOrder[]) {
    const targetKind = targetIndex === 0 ? 'existing-first-paragraph' : `new-paragraph-${targetIndex + 1}`;
    test(`block history retains peer text and native lineage: ${targetKind}, ${order}`, async t => {
      const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
      for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'HTMLDetailsElement', 'Element', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
        Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
      }
      const schema = getSchema(richMarkdownCodecExtensions());
      const ownerDoc = new Y.Doc(); ownerDoc.clientID = ownerClient;
      const peerDoc = new Y.Doc(); peerDoc.clientID = peerClient;
      const ownerErrors: Error[] = [], peerErrors: Error[] = [];
      let owner: Editor | undefined, peer: Editor | undefined;
      let releasePeerUpdate = () => {};
      try {
        CollaborationBlockTree.create(ownerDoc, schema.topNodeType.createChecked(null,
          [schema.nodes.paragraph.createChecked({ id: paragraphIds[0] })]));
        owner = createEditor(ownerDoc, ownerErrors);
        await Promise.resolve();
        const ownerTree = new CollaborationBlockTree(ownerDoc, owner.schema);
        const ownerHistory = getBlockTreeHistory(ownerTree);
        assert.equal(ownerHistory.can('undo'), false);
        const ownerSchema = owner.schema;
        const pasted = pastedLines.map((text, index) => ownerSchema.nodes.paragraph.createChecked(
          { id: paragraphIds[index] }, ownerSchema.text(text)));
        owner.view.dispatch(owner.state.tr.replaceWith(0, owner.state.doc.content.size, pasted)
          .setMeta('paste', true).setMeta('uiEvent', 'paste'));
        const pastedJSON = owner.getJSON();
        assert.deepEqual(owner.state.doc.content.content.map(node => node.attrs.id), [...paragraphIds]);
        assert.equal(owner.state.doc.textContent.length, 69);
        assert.equal(ownerHistory.can('undo'), true);

        // Independent peer snapshot BEFORE owner history. There is no relay.
        const baselineVector = Y.encodeStateVector(ownerDoc);
        Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(ownerDoc), { fixture: 'initial-sync' });
        peer = createEditor(peerDoc, peerErrors);
        await Promise.resolve();
        const peerTree = new CollaborationBlockTree(peerDoc, peer.schema);
        const beforeOwnerClock = clock(ownerDoc, ownerClient);
        const beforeOwner = paragraphIds.map(id => ({ record: ownerTree.records.get(id),
          content: ownerTree.content(id), lineage: lineage(ownerTree, id) }));
        const beforePeer = paragraphIds.map(id => ({ record: peerTree.records.get(id),
          content: peerTree.content(id), lineage: lineage(peerTree, id) }));
        assert.deepEqual(peer.getJSON(), pastedJSON);
        assert.deepEqual(beforePeer.map(item => item.lineage), beforeOwner.map(item => item.lineage));
        assert.equal(clock(peerDoc, ownerClient), beforeOwnerClock);

        // Keep the original separate own typing / undo / paste undo / redo.
        // Its text always targets the last paragraph, independent of peer case.
        owner.commands.setTextSelection(paragraphEnd(owner, paragraphIds[2]));
        owner.view.dispatch(owner.state.tr.insertText(ownSuffix));
        assert.equal(paragraph(owner.state.doc, paragraphIds[2]).textContent, pastedLines[2] + ownSuffix);
        assert.equal(owner.commands.undo(), true);
        assert.deepEqual(owner.getJSON(), pastedJSON);
        assert.equal(owner.commands.undo(), true);
        assert.equal(owner.state.doc.textContent, '');
        assert.equal(owner.commands.redo(), true);
        assert.deepEqual(owner.getJSON(), pastedJSON);
        assert.deepEqual(owner.getJSON(), peer.getJSON(), 'same complete PM JSON and UUIDs before stale-peer edit');
        assert.deepEqual(paragraphIds.map(id => lineage(peerTree, id)), beforePeer.map(item => item.lineage),
          'peer still holds the original pre-history native lineages');
        // No precondition demands that undo/redo replaced any native identity.
        const afterRedoLineages = paragraphIds.map(id => lineage(ownerTree, id));
        const afterRedoOwnerClock = clock(ownerDoc, ownerClient);

        const targetId = paragraphIds[targetIndex];
        const peerBinding = (peer.storage as unknown as { canvasBlockTreeCollaboration: { binding: { origin: object } } }).canvasBlockTreeCollaboration.binding;
        assert.ok(peerBinding?.origin);
        const localPeerUpdates: Uint8Array[] = [];
        const capturePeerUpdate = (update: Uint8Array, origin: unknown) => {
          if (origin === peerBinding.origin) localPeerUpdates.push(update.slice());
        };
        peerDoc.on('update', capturePeerUpdate);
        releasePeerUpdate = () => peerDoc.off('update', capturePeerUpdate);
        const beforePeerClock = clock(peerDoc, peerClient);
        peer.commands.setTextSelection(paragraphEnd(peer, targetId));
        peer.view.dispatch(peer.state.tr.insertText(peerSuffix));
        const expectedText = pastedLines[targetIndex] + peerSuffix;
        assert.equal(paragraph(peer.state.doc, targetId).textContent, expectedText);
        assert.equal(clock(peerDoc, peerClient) - beforePeerClock, peerSuffix.length);
        assert.ok(localPeerUpdates.length > 0, 'the active product binding emitted the peer edit');

        // Freeze both independently generated deltas BEFORE ANY merge. Only
        // delivery order changes across cases; the edit/history causal order
        // above is identical in all six fixtures.
        const redoDelta = Y.encodeStateAsUpdate(ownerDoc, baselineVector);
        const peerDelta = Y.encodeStateAsUpdate(peerDoc, baselineVector);
        const remoteOrigin = { fixture: 'delayed-remote-merge' };
        if (order === 'owner-redo-first') {
          Y.applyUpdate(peerDoc, redoDelta, remoteOrigin);
          Y.applyUpdate(ownerDoc, peerDelta, remoteOrigin);
        } else {
          Y.applyUpdate(ownerDoc, peerDelta, remoteOrigin);
          Y.applyUpdate(peerDoc, redoDelta, remoteOrigin);
        }
        await Promise.resolve();

        const actual = { owner: findParagraph(owner.state.doc, targetId)?.textContent ?? null,
          peer: findParagraph(peer.state.doc, targetId)?.textContent ?? null };
        t.diagnostic(JSON.stringify({ fixture: 'I07-block-history-lineage', targetIndex, order,
          clocks: { beforeOwnerClock, afterRedoOwnerClock, integratedPeerClock: clock(ownerDoc, peerClient) },
          beforeOwnerLineages: beforeOwner.map(item => item.lineage), afterRedoLineages,
          updates: { peerActiveBinding: localPeerUpdates.map(updateMetadata), redoDelta: updateMetadata(redoDelta), peerDelta: updateMetadata(peerDelta) },
          actual: { ownerChars: actual.owner?.length ?? null, peerChars: actual.peer?.length ?? null,
            ownerHasPeer: actual.owner?.includes(peerSuffix) ?? false, peerHasPeer: actual.peer?.includes(peerSuffix) ?? false } }));

        // FIRST post-merge product assertion: convergence or native identity
        // cannot pass this test when both replicas silently lost the peer text.
        assert.deepEqual(actual, { owner: expectedText, peer: expectedText },
          'peer text survives owner paste history on both replicas');
        for (let index = 0; index < paragraphIds.length; index++) {
          const id = paragraphIds[index];
          assert.strictEqual(ownerTree.records.get(id), beforeOwner[index].record, `owner record identity remains stable for ${id}`);
          assert.strictEqual(ownerTree.content(id), beforeOwner[index].content, `owner fragment identity remains stable for ${id}`);
          assert.strictEqual(peerTree.records.get(id), beforePeer[index].record, `peer record identity remains stable for ${id}`);
          assert.strictEqual(peerTree.content(id), beforePeer[index].content, `peer fragment identity remains stable for ${id}`);
          assert.deepEqual(lineage(ownerTree, id), beforeOwner[index].lineage);
          assert.deepEqual(lineage(peerTree, id), beforePeer[index].lineage);
        }
        const expectedJSON = structuredClone(pastedJSON);
        (expectedJSON.content![targetIndex].content![0] as { text?: string }).text = expectedText;
        assert.deepEqual(owner.getJSON(), peer.getJSON(), 'full PM documents converge');
        assert.deepEqual(owner.getJSON(), owner.schema.nodeFromJSON(expectedJSON).toJSON(),
          'untouched paragraphs and undone own text remain exact');
        assert.equal(clock(ownerDoc, peerClient), beforePeerClock + peerSuffix.length);
        assert.deepEqual(ownerErrors, []); assert.deepEqual(peerErrors, []);
        assert.equal(ownerDoc.store.pendingStructs, null); assert.equal(ownerDoc.store.pendingDs, null);
        assert.equal(peerDoc.store.pendingStructs, null); assert.equal(peerDoc.store.pendingDs, null);
      } finally {
        releasePeerUpdate();
        owner?.destroy(); peer?.destroy(); ownerDoc.destroy(); peerDoc.destroy(); dom.window.close();
      }
    });
  }
}
