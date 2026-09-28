import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';

import { mergeCollaborationPersistenceUpdates } from '../app/lib/collaboration/persistence-merge';

const update = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc);

function copy(doc: Y.Doc, gc = false): Y.Doc {
  const clone = new Y.Doc({ gc });
  Y.applyUpdate(clone, update(doc));
  return clone;
}

function open(bytes: Uint8Array, gc = false): Y.Doc {
  const doc = new Y.Doc({ gc });
  Y.applyUpdate(doc, bytes);
  return doc;
}

test('equal full snapshots preserve the current bytes without reconciliation', () => {
  const doc = new Y.Doc({ gc: false });
  try {
    doc.getText('content').insert(0, 'same');
    const current = update(doc);
    const result = mergeCollaborationPersistenceUpdates(current, update(doc));
    assert.equal(result.disposition, 'unchanged');
    assert.equal(result.incomingNeedsReconcile, false);
    assert.deepEqual(result.update, current);
    assert.notEqual(result.update, current, 'the result does not alias a caller-owned buffer');
    assert.deepEqual(result.stateVector, Y.encodeStateVector(doc));
  } finally { doc.destroy(); }
});

test('an incoming descendant advances the persisted state directly', () => {
  const base = new Y.Doc({ gc: false });
  const incoming = copy(base);
  try {
    base.getText('content').insert(0, 'base');
    Y.applyUpdate(incoming, update(base));
    incoming.getText('content').insert(4, ' plus');
    const incomingUpdate = update(incoming);
    const result = mergeCollaborationPersistenceUpdates(update(base), incomingUpdate);
    assert.equal(result.disposition, 'advanced');
    assert.equal(result.incomingNeedsReconcile, false);
    assert.deepEqual(result.update, incomingUpdate);
    assert.deepEqual(result.stateVector, Y.encodeStateVector(incoming));
  } finally { base.destroy(); incoming.destroy(); }
});

test('an incoming ancestor is a no-op and must reconcile from current', () => {
  const ancestor = new Y.Doc({ gc: false });
  const current = new Y.Doc({ gc: false });
  try {
    ancestor.getText('content').insert(0, 'base');
    Y.applyUpdate(current, update(ancestor));
    current.getText('content').insert(4, ' current');
    const currentUpdate = update(current);
    const result = mergeCollaborationPersistenceUpdates(currentUpdate, update(ancestor));
    assert.equal(result.disposition, 'unchanged');
    assert.equal(result.incomingNeedsReconcile, true);
    assert.deepEqual(result.update, currentUpdate);
  } finally { ancestor.destroy(); current.destroy(); }
});

test('divergent insertions produce a canonical union containing both branches', () => {
  const base = new Y.Doc({ gc: false });
  base.getText('content').insert(0, 'root');
  const current = copy(base); const incoming = copy(base);
  let merged: Y.Doc | undefined;
  try {
    current.getText('content').insert(4, '-current');
    incoming.getText('content').insert(4, '-incoming');
    const result = mergeCollaborationPersistenceUpdates(update(current), update(incoming));
    assert.equal(result.disposition, 'merged');
    assert.equal(result.incomingNeedsReconcile, true);
    merged = open(result.update);
    const content = merged.getText('content').toString();
    assert.match(content, /current/u);
    assert.match(content, /incoming/u);
    assert.deepEqual(result.stateVector, Y.encodeStateVector(merged));
    const reverse = mergeCollaborationPersistenceUpdates(update(incoming), update(current));
    assert.deepEqual(reverse.update, result.update, 'canonical union is independent of source order');
  } finally { base.destroy(); current.destroy(); incoming.destroy(); merged?.destroy(); }
});

test('deletion-only divergence with equal vectors merges both delete sets', () => {
  const base = new Y.Doc({ gc: false });
  base.getText('content').insert(0, 'ABC');
  const current = copy(base); const incoming = copy(base);
  let merged: Y.Doc | undefined;
  try {
    current.getText('content').delete(0, 1);
    incoming.getText('content').delete(1, 1);
    assert.deepEqual(Y.encodeStateVector(current), Y.encodeStateVector(incoming));
    const result = mergeCollaborationPersistenceUpdates(update(current), update(incoming));
    assert.equal(result.disposition, 'merged');
    assert.equal(result.incomingNeedsReconcile, true);
    merged = open(result.update);
    assert.equal(merged.getText('content').toString(), 'C');
    assert.deepEqual(Y.encodeStateVector(merged), Y.encodeStateVector(base));
  } finally { base.destroy(); current.destroy(); incoming.destroy(); merged?.destroy(); }
});

test('GC and non-GC encodings of the same snapshot are equal for containment', () => {
  const retained = new Y.Doc({ gc: false });
  const nested = new Y.Map();
  nested.set('text', new Y.Text('deleted nested value'));
  retained.getMap('blocks').set('paragraph', nested);
  retained.getMap('blocks').delete('paragraph');
  const collected = new Y.Doc({ gc: true });
  try {
    const retainedUpdate = update(retained);
    Y.applyUpdate(collected, retainedUpdate);
    const collectedUpdate = update(collected);
    assert.notDeepEqual(collectedUpdate, retainedUpdate, 'fixture must exercise different GC encodings');
    assert.ok([...collected.store.clients.values()].flat().some((struct) => struct instanceof Y.GC));
    const result = mergeCollaborationPersistenceUpdates(retainedUpdate, collectedUpdate);
    assert.equal(result.disposition, 'unchanged');
    assert.equal(result.incomingNeedsReconcile, false);
    assert.deepEqual(result.update, retainedUpdate);
  } finally { retained.destroy(); collected.destroy(); }
});

test('out-of-order structures and delete ranges are rejected as incomplete updates', () => {
  const emptyDoc = new Y.Doc({ gc: false });
  try {
    const empty = update(emptyDoc);
    for (const pendingKind of ['structures', 'delete ranges'] as const) {
      const source = new Y.Doc({ gc: false });
      try {
        source.getText('content').insert(0, 'A');
        const prerequisiteVector = Y.encodeStateVector(source);
        if (pendingKind === 'structures') source.getText('content').insert(1, 'B');
        else source.getText('content').delete(0, 1);
        const partial = Y.encodeStateAsUpdate(source, prerequisiteVector);
        assert.throws(
          () => mergeCollaborationPersistenceUpdates(empty, partial),
          /not a complete, self-contained Yjs V1 update/u,
        );
      } finally { source.destroy(); }
    }
  } finally { emptyDoc.destroy(); }
});

test('empty, malformed, extended and oversized binary payloads are rejected', () => {
  const doc = new Y.Doc({ gc: false });
  doc.getText('content').insert(0, 'valid');
  try {
    const valid = update(doc);
    for (const malformed of [new Uint8Array(), new Uint8Array([255]), valid.slice(0, -1),
      Uint8Array.from([...valid, 0])]) {
      assert.throws(() => mergeCollaborationPersistenceUpdates(valid, malformed));
    }
    assert.throws(
      () => mergeCollaborationPersistenceUpdates(valid, new Uint8Array(64 * 1024 * 1024 + 1)),
      /64 MiB persistence update limit/u,
    );
  } finally { doc.destroy(); }
});

test('source and returned buffers never alias or mutate one another', () => {
  const base = new Y.Doc({ gc: false });
  base.getText('content').insert(0, 'root');
  const left = copy(base); const right = copy(base);
  try {
    left.getText('content').insert(4, '-left');
    right.getText('content').insert(4, '-right');
    const current = update(left); const incoming = update(right);
    const savedCurrent = current.slice(); const savedIncoming = incoming.slice();
    const result = mergeCollaborationPersistenceUpdates(current, incoming);
    const savedResult = result.update.slice();
    assert.deepEqual(current, savedCurrent);
    assert.deepEqual(incoming, savedIncoming);
    current[0] ^= 0xff;
    incoming[0] ^= 0xff;
    assert.deepEqual(result.update, savedResult, 'result retained immutable captures of both inputs');
    result.update[0] ^= 0xff;
    assert.notDeepEqual(result.update, savedResult);
    assert.deepEqual(current.slice(1), savedCurrent.slice(1));
    assert.deepEqual(incoming.slice(1), savedIncoming.slice(1));
  } finally { base.destroy(); left.destroy(); right.destroy(); }
});

test('Node Buffer input is copied for unchanged and advanced snapshots too', () => {
  const base = new Y.Doc();
  base.getText('content').insert(0, 'base');
  const newer = copy(base);
  newer.getText('content').insert(4, '-new');
  try {
    for (const kind of ['unchanged', 'advanced'] as const) {
      const current = Buffer.from(update(base));
      const incoming = Buffer.from(update(kind === 'unchanged' ? base : newer));
      const beforeCurrent = Buffer.from(current);
      const beforeIncoming = Buffer.from(incoming);
      const result = mergeCollaborationPersistenceUpdates(current, incoming);
      assert.equal(result.disposition, kind);
      result.update[0] ^= 0xff;
      assert.deepEqual(current, beforeCurrent);
      assert.deepEqual(incoming, beforeIncoming);
    }
  } finally { base.destroy(); newer.destroy(); }
});

test('snapshot containment assumes Yjs IDs never carry conflicting values', () => {
  const current = new Y.Doc({ gc: false }); const incoming = new Y.Doc({ gc: false });
  current.clientID = 42; incoming.clientID = 42;
  try {
    current.getText('content').insert(0, 'left');
    incoming.getText('content').insert(0, 'rite');
    const currentUpdate = update(current); const incomingUpdate = update(incoming);
    assert.notDeepEqual(currentUpdate, incomingUpdate);
    assert.deepEqual(Y.encodeStateVector(current), Y.encodeStateVector(incoming));
    const result = mergeCollaborationPersistenceUpdates(currentUpdate, incomingUpdate);
    assert.equal(result.disposition, 'unchanged');
    assert.deepEqual(result.update, currentUpdate);
    assert.equal(result.incomingNeedsReconcile, false,
      'snapshot metadata cannot detect a producer that violates immutable struct identity');
  } finally { current.destroy(); incoming.destroy(); }
});
