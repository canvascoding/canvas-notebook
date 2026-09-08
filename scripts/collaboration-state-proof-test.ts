import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';

import { collaborationStateProof, collaborationUpdateStateProof, isCollaborationStateProof } from '../app/lib/collaboration/state-proof';
import { createInitialTextCollaborationClientState, reduceTextCollaborationClientState, textCollaborationLegacyStatus } from '../app/lib/collaboration/client-state';

const proof = (doc: Y.Doc) => collaborationStateProof(doc, Y)!;
const vector = (doc: Y.Doc) => Buffer.from(Y.encodeStateVector(doc)).toString('base64');
const copy = (doc: Y.Doc, gc = true) => {
  const result = new Y.Doc({ gc });
  Y.applyUpdate(result, Y.encodeStateAsUpdate(doc));
  return result;
};

test('a pure deletion changes the proof even when the state vector stays identical', () => {
  const doc = new Y.Doc();
  try {
    doc.getText('content').insert(0, 'AAA BBB CCC');
    const originalProof = proof(doc);
    const originalVector = vector(doc);
    doc.getText('content').delete(4, 4);
    assert.equal(vector(doc), originalVector);
    assert.notEqual(proof(doc), originalProof);
    assert.equal(collaborationUpdateStateProof(Y.encodeStateAsUpdate(doc), Y), proof(doc));
    assert.equal(isCollaborationStateProof(proof(doc)), true);
    assert.equal(isCollaborationStateProof(originalVector), false);
  } finally { doc.destroy(); }
});

test('different deletions with the same vector cannot certify each other', () => {
  const original = new Y.Doc();
  original.getText('content').insert(0, 'ABC');
  const a = copy(original); const b = copy(original);
  try {
    a.getText('content').delete(0, 1);
    b.getText('content').delete(1, 1);
    assert.equal(vector(a), vector(b));
    assert.notEqual(proof(a), proof(b));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    assert.equal(a.getText('content').toString(), 'C');
    assert.equal(proof(a), proof(b));
  } finally { original.destroy(); a.destroy(); b.destroy(); }
});

test('proofs are independent of transaction boundaries, GC and update delivery order', () => {
  const original = new Y.Doc(); original.getText('content').insert(0, 'abcdef');
  const a = copy(original, false); const b = copy(original);
  const mergedA = copy(original); const mergedB = copy(original, false);
  try {
    a.getText('content').delete(1, 1); a.getText('content').delete(1, 1);
    b.getText('content').delete(1, 2);
    assert.equal(proof(a), proof(b));
    a.getText('content').insert(1, 'A'); b.getText('content').insert(2, 'B');
    const updates = [Y.encodeStateAsUpdate(a), Y.encodeStateAsUpdate(b)];
    for (const update of updates) Y.applyUpdate(mergedA, update);
    for (const update of [...updates].reverse()) Y.applyUpdate(mergedB, update);
    for (const update of updates) Y.applyUpdate(mergedB, update);
    assert.equal(proof(mergedA), proof(mergedB));
    assert.equal(mergedA.getText('content').toString(), mergedB.getText('content').toString());
  } finally { for (const doc of [original, a, b, mergedA, mergedB]) doc.destroy(); }
});

test('rich text, metadata and block record deletions participate in the proof', () => {
  const doc = new Y.Doc();
  try {
    const inline = new Y.XmlText(); inline.insert(0, 'formatted text');
    doc.getXmlFragment('body').insert(0, [inline]);
    doc.getMap('metadata').set('title', 'Title');
    doc.getMap('blocks').set('id', new Y.Map([['type', 'paragraph']]));
    for (const remove of [() => inline.delete(0, 3), () => doc.getMap('metadata').delete('title'), () => doc.getMap('blocks').delete('id')]) {
      const before = proof(doc); const beforeVector = vector(doc);
      remove();
      assert.equal(vector(doc), beforeVector);
      assert.notEqual(proof(doc), before);
    }
  } finally { doc.destroy(); }
});

test('unapplied out-of-order structures and deletion sets never receive a proof', () => {
  const origin = new Y.Doc(); const pending = new Y.Doc(); const pendingDelete = new Y.Doc();
  try {
    origin.getText('content').insert(0, 'A');
    const first = Y.encodeStateAsUpdate(origin); const firstVector = Y.encodeStateVector(origin);
    origin.getText('content').insert(1, 'B');
    Y.applyUpdate(pending, Y.encodeStateAsUpdate(origin, firstVector));
    assert.equal(collaborationStateProof(pending, Y), null);
    const secondVector = Y.encodeStateVector(origin);
    origin.getText('content').delete(0, 1);
    Y.applyUpdate(pendingDelete, Y.encodeStateAsUpdate(origin, secondVector));
    assert.equal(collaborationStateProof(pendingDelete, Y), null);
    Y.applyUpdate(pending, first);
    assert.ok(proof(pending));
    Y.applyUpdate(pendingDelete, Y.encodeStateAsUpdate(origin));
    assert.equal(proof(pendingDelete), proof(origin));
  } finally { origin.destroy(); pending.destroy(); pendingDelete.destroy(); }
});

test('a session or transport acknowledgement cannot certify unhydrated or deleted local content', () => {
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'ABC');
  try {
    const checkpointProof = proof(doc);
    const stateVector = vector(doc);
    const checkpoint = { type: 'authoritative_snapshot' as const, documentSequence: 5, checkpointSequence: 5,
      stateVector, stateProof: checkpointProof, matchesCurrentDocument: true };
    let state = createInitialTextCollaborationClientState({ documentSequence: 5, checkpointSequence: 5, stateVector });
    assert.notEqual(state.durability, 'checkpointed_file');
    state = reduceTextCollaborationClientState(state, checkpoint);
    assert.notEqual(state.durability, 'checkpointed_file');
    state = reduceTextCollaborationClientState(state, { type: 'indexeddb_hydrated' });
    state = reduceTextCollaborationClientState(state, { type: 'remote_synced', permission: 'write' });
    state = reduceTextCollaborationClientState(state, checkpoint);
    assert.equal(textCollaborationLegacyStatus(state), 'saved');
    doc.getText('content').delete(0, 1);
    state = reduceTextCollaborationClientState(state, { type: 'document_changed' });
    assert.notEqual(textCollaborationLegacyStatus(state), 'saved', 'invalidate before provider batching');
    assert.equal(state.checkpointStateProof, null);
    state = reduceTextCollaborationClientState(state, { type: 'unsynced_changes', count: 0 });
    state = reduceTextCollaborationClientState(state, { ...checkpoint, matchesCurrentDocument: proof(doc) === checkpointProof });
    assert.notEqual(state.durability, 'checkpointed_file');
    state = reduceTextCollaborationClientState(state, { ...checkpoint, stateProof: '', matchesCurrentDocument: true });
    assert.notEqual(state.durability, 'checkpointed_file', 'legacy vector-only messages cannot certify new clients');
    state = reduceTextCollaborationClientState(state, { ...checkpoint, documentSequence: 6, checkpointSequence: 6, stateProof: proof(doc) });
    assert.equal(state.durability, 'checkpointed_file');
    assert.equal(state.checkpointStateProof, proof(doc));
  } finally { doc.destroy(); }
});
