/**
 * IME edits must preserve neutral allocation and shared parent lineage through history.
 * Exercises actual composition events, independent Yjs update replay and stale peers.
 * Run: node --conditions=react-server --import tsx scripts/collaboration-block-history-ime-allocation-test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Editor, getSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { BLOCK_TREE_ALLOCATION_ORIGIN, CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { getBlockTreeHistory } from '../app/lib/collaboration/block-tree-history';
import { validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { assertNativeDocumentSchema } from '../app/lib/collaboration/native-document-schema';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';

const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
const pastedLines = ['First paste: äöü ß 😀', 'Second line preserves plain text.', 'Last paragraph.'];
const ownSuffix = ' Typed after paste.', peerSuffix = ' Peer keeps this.';
type BindingProbe = { origin: object; composing: boolean; compositionTree: CollaborationBlockTree | null };
type Sample = { origin: 'allocation' | 'binding' | 'other'; updateBytes: number; updateHash: string;
  body: ReturnType<ProseMirrorNode['toJSON']>; bodyHash: string; markdownHash: string; wireStateHash: string };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const probe = (editor: Editor) => (editor.storage as unknown as { canvasBlockTreeCollaboration: { binding: BindingProbe } }).canvasBlockTreeCollaboration.binding;
const clock = (doc: Y.Doc, client: number) => Y.decodeStateVector(Y.encodeStateVector(doc)).get(client) ?? 0;

function createEditor(doc: Y.Doc, errors: Error[]) {
  return new Editor({ extensions: [
    ...richMarkdownCodecExtensions().map(extension => extension.name === 'starterKit' ? extension.configure({ undoRedo: false })
      : extension.name === 'uniqueID' ? CanvasUniqueID.configure({ types: 'all', filterTransaction: (tr: Transaction) => !isRemoteRichEditorTransaction(tr) }) : extension),
    ...createRichEditorCollaborationExtensions({ document: doc, representation: 'tiptap_blocks', awareness: null,
      user: { name: 'Fixture', color: '#123456' }, onError: error => errors.push(error) }),
  ] });
}

function findParagraph(doc: ProseMirrorNode, id: string): ProseMirrorNode | null {
  let found: ProseMirrorNode | null = null;
  doc.descendants(node => { if (node.attrs.id === id) { found = node; return false; } });
  return found;
}

function paragraphEnd(editor: Editor, id: string) {
  let end = -1;
  editor.state.doc.descendants((node, pos) => { if (node.attrs.id === id) { end = pos + node.nodeSize - 1; return false; } });
  assert.ok(end >= 1); return end;
}

function itemId(value: unknown) {
  const id = (value as { _item?: { id?: { client: number; clock: number } } } | null)?._item?.id;
  assert.ok(id); return { client: id.client, clock: id.clock };
}

function lineage(tree: CollaborationBlockTree, id: string) {
  return { id, record: itemId(tree.records.get(id)), content: itemId(tree.content(id)) };
}

/** Every emitted v1 update is replayed in order on a real independent Y.Doc. */
function observeBirthUpdates(doc: Y.Doc, schema: Schema, bindingOrigin: object) {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc), { fixture: 'observer-initial-state' });
  const samples: Sample[] = [], failures: unknown[] = [];
  const validate = () => {
    const replayTree = new CollaborationBlockTree(replica, schema);
    assert.equal(replayTree.root.get('version'), 1);
    assert.equal(replica.share.has('body'), false);
    assertNativeDocumentSchema(replica, 'tiptap_blocks', schema);
    const validation = validateRichMarkdownYDoc(replica);
    assert.equal(validation.valid, true);
    assert.equal(typeof validation.markdown, 'string');
    const replayed = replayTree.read().toJSON();
    const actual = new CollaborationBlockTree(doc, schema).read().toJSON();
    assert.deepEqual(replayed, actual, 'each update independently replays to the actual source projection');
    return { body: replayed, bodyHash: hash(JSON.stringify(replayed)), markdownHash: hash(validation.markdown!),
      wireStateHash: hash(Y.encodeStateAsUpdate(doc)) };
  };
  const baseline = validate();
  const update = (bytes: Uint8Array, origin: unknown) => {
    // Observer assertions are caught, never thrown through a product Yjs event.
    try {
      Y.decodeUpdate(bytes); // Actual 'update' protocol is v1; do not decode content for logging.
      Y.applyUpdate(replica, bytes, { fixture: 'observer-replay' });
      samples.push({ origin: origin === BLOCK_TREE_ALLOCATION_ORIGIN ? 'allocation' : origin === bindingOrigin ? 'binding' : 'other',
        updateBytes: bytes.length, updateHash: hash(bytes), ...validate() });
    } catch (error) { failures.push(error); }
  };
  doc.on('update', update);
  let stopped = false;
  return { baseline, samples, failures, stop() {
    if (stopped) return; stopped = true; doc.off('update', update); replica.destroy();
  } };
}

for (const mode of ['first-empty-paragraph', 'pasted-new-paragraph'] as const) {
  for (const order of ['owner-redo-first', 'peer-update-first'] as const) {
    test(`composed birth allocation remains neutral and peer text survives history: ${mode}, ${order}`, async t => {
      const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
      for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'HTMLDetailsElement', 'Element', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
        Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
      }
      const schema = getSchema(richMarkdownCodecExtensions());
      const ownerDoc = new Y.Doc(); ownerDoc.clientID = 11;
      const peerDoc = new Y.Doc(); peerDoc.clientID = 22;
      const ownerErrors: Error[] = [], peerErrors: Error[] = [];
      const observers: ReturnType<typeof observeBirthUpdates>[] = [];
      let owner: Editor | undefined, peer: Editor | undefined;
      try {
        CollaborationBlockTree.create(ownerDoc, schema.topNodeType.createChecked(null, [schema.nodes.paragraph.createChecked({ id: ids[0] })]));
        owner = createEditor(ownerDoc, ownerErrors);
        document.body.append(owner.view.dom);
        await Promise.resolve(); owner.view.focus();
        const initialJSON = owner.getJSON();
        const liveBinding = probe(owner);
        owner.commands.setTextSelection(paragraphEnd(owner, ids[0]));
        owner.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
        assert.equal(owner.view.composing, true); assert.equal(liveBinding.composing, true);
        assert.ok(liveBinding.compositionTree);
        assert.notStrictEqual(liveBinding.compositionTree.doc, ownerDoc, 'the real extension owns a separate composition replica');
        const compositionActor = liveBinding.compositionTree.doc.clientID;
        const live = observeBirthUpdates(ownerDoc, owner.schema, liveBinding.origin);
        const composed = observeBirthUpdates(liveBinding.compositionTree.doc, owner.schema, liveBinding.origin);
        observers.push(live, composed);

        if (mode === 'pasted-new-paragraph') {
          const ownerSchema = owner.schema;
          const nodes = pastedLines.map((text, index) => ownerSchema.nodes.paragraph.createChecked({ id: ids[index] }, ownerSchema.text(text)));
          owner.view.dispatch(owner.state.tr.replaceWith(0, owner.state.doc.content.size, nodes).setMeta('paste', true).setMeta('uiEvent', 'paste'));
        } else {
          owner.view.dispatch(owner.state.tr.insertText('起始'));
        }
        // Scope exact-two evidence to this ONE composed birth transaction.
        live.stop(); composed.stop();
        const bornJSON = owner.getJSON();
        for (const evidence of [live, composed]) {
          assert.deepEqual(evidence.failures, []);
          assert.equal(evidence.samples.length, 2);
          assert.deepEqual(evidence.samples.map(sample => sample.origin), ['allocation', 'binding']);
          assert.deepEqual(evidence.samples[0].body, initialJSON, 'neutral allocation has not changed the original body');
          assert.equal(evidence.samples[0].bodyHash, evidence.baseline.bodyHash);
          assert.equal(evidence.samples[0].markdownHash, evidence.baseline.markdownHash);
          assert.notEqual(evidence.samples[0].wireStateHash, evidence.baseline.wireStateHash, 'neutral allocation changes native bytes, not visible content');
          assert.deepEqual(evidence.samples[1].body, bornJSON);
          assert.notEqual(evidence.samples[1].bodyHash, evidence.baseline.bodyHash);
        }
        assert.deepEqual(new CollaborationBlockTree(ownerDoc, owner.schema).read().toJSON(), bornJSON,
          'composition has immediately reached the live Y.Doc before compositionend');
        owner.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
        await Promise.resolve();
        assert.equal(probe(owner).composing, false); assert.equal(probe(owner).compositionTree, null);
        assert.deepEqual(owner.getJSON(), bornJSON);

        const caseIds = mode === 'pasted-new-paragraph' ? ids : ids.slice(0, 1);
        const targetId = caseIds.at(-1)!;
        const baseText = findParagraph(owner.state.doc, targetId)!.textContent;
        const ownerTree = new CollaborationBlockTree(ownerDoc, owner.schema);
        const history = getBlockTreeHistory(ownerTree);
        assert.equal(history.can('undo'), true, 'composed birth is captured in LIVE document history');
        const baselineVector = Y.encodeStateVector(ownerDoc);
        Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(ownerDoc), { fixture: 'snapshot-before-history' });
        peer = createEditor(peerDoc, peerErrors); await Promise.resolve();
        const peerTree = new CollaborationBlockTree(peerDoc, peer.schema);
        const beforeOwner = caseIds.map(id => ({ record: ownerTree.records.get(id), content: ownerTree.content(id), lineage: lineage(ownerTree, id) }));
        const beforePeer = caseIds.map(id => ({ record: peerTree.records.get(id), content: peerTree.content(id), lineage: lineage(peerTree, id) }));
        assert.deepEqual(peer.getJSON(), bornJSON);
        assert.deepEqual(beforePeer.map(value => value.lineage), beforeOwner.map(value => value.lineage));
        owner.commands.setTextSelection(paragraphEnd(owner, targetId));
        owner.view.dispatch(owner.state.tr.insertText(ownSuffix));
        assert.equal(owner.commands.undo(), true); assert.deepEqual(owner.getJSON(), bornJSON);
        assert.equal(owner.commands.undo(), true); assert.deepEqual(owner.getJSON(), initialJSON);
        assert.equal(owner.commands.redo(), true); assert.deepEqual(owner.getJSON(), bornJSON);
        assert.deepEqual(owner.getJSON(), peer.getJSON());
        assert.deepEqual(caseIds.map(id => lineage(peerTree, id)), beforePeer.map(value => value.lineage));

        peer.commands.setTextSelection(paragraphEnd(peer, targetId));
        const beforePeerClock = clock(peerDoc, 22);
        peer.view.dispatch(peer.state.tr.insertText(peerSuffix));
        assert.equal(findParagraph(peer.state.doc, targetId)?.textContent, baseText + peerSuffix);
        assert.equal(clock(peerDoc, 22) - beforePeerClock, 17, 'ordinary stale-peer edit retains the original 17-unit contract');
        const redoDelta = Y.encodeStateAsUpdate(ownerDoc, baselineVector);
        const peerDelta = Y.encodeStateAsUpdate(peerDoc, baselineVector);
        const remote = { fixture: 'delayed-remote-merge' };
        if (order === 'owner-redo-first') { Y.applyUpdate(peerDoc, redoDelta, remote); Y.applyUpdate(ownerDoc, peerDelta, remote); }
        else { Y.applyUpdate(ownerDoc, peerDelta, remote); Y.applyUpdate(peerDoc, redoDelta, remote); }
        await Promise.resolve();
        const actual = { owner: findParagraph(owner.state.doc, targetId)?.textContent ?? null,
          peer: findParagraph(peer.state.doc, targetId)?.textContent ?? null };
        t.diagnostic(JSON.stringify({ fixture: 'I07-real-composition-neutral-allocation', mode, order, compositionActor,
          twoUpdateEvidence: [live, composed].map(evidence => evidence.samples.map(sample => ({ origin: sample.origin,
            updateBytes: sample.updateBytes, updateHash: sample.updateHash, bodyHash: sample.bodyHash,
            markdownHash: sample.markdownHash, wireStateHash: sample.wireStateHash }))),
          redoDelta: { bytes: redoDelta.length, hash: hash(redoDelta) }, peerDelta: { bytes: peerDelta.length, hash: hash(peerDelta) } }));
        assert.deepEqual(actual, { owner: baseText + peerSuffix, peer: baseText + peerSuffix }, 'FIRST post-merge check requires both replicas to retain peer text');
        for (let index = 0; index < caseIds.length; index++) {
          const id = caseIds[index];
          assert.strictEqual(ownerTree.records.get(id), beforeOwner[index].record); assert.strictEqual(ownerTree.content(id), beforeOwner[index].content);
          assert.strictEqual(peerTree.records.get(id), beforePeer[index].record); assert.strictEqual(peerTree.content(id), beforePeer[index].content);
          assert.deepEqual(lineage(ownerTree, id), beforeOwner[index].lineage); assert.deepEqual(lineage(peerTree, id), beforePeer[index].lineage);
        }
        const expectedJSON = structuredClone(bornJSON);
        (expectedJSON.content![caseIds.length - 1].content![0] as { text?: string }).text = baseText + peerSuffix;
        const expected = owner.schema.nodeFromJSON(expectedJSON).toJSON();
        assert.deepEqual(owner.getJSON(), peer.getJSON()); assert.deepEqual(owner.getJSON(), expected);
        assert.equal(clock(ownerDoc, 22), beforePeerClock + 17);
        assert.deepEqual(ownerErrors, []); assert.deepEqual(peerErrors, []);
        assert.equal(ownerDoc.store.pendingStructs, null); assert.equal(ownerDoc.store.pendingDs, null);
        assert.equal(peerDoc.store.pendingStructs, null); assert.equal(peerDoc.store.pendingDs, null);
      } finally {
        for (const observer of observers) observer.stop();
        owner?.destroy(); peer?.destroy(); ownerDoc.destroy(); peerDoc.destroy(); dom.window.close();
      }
    });
  }
}
