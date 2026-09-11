import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';

import { captureAgentStateSnapshot, persistedUpdateIncludesAgentSnapshot } from '../app/lib/collaboration/agent-durability';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichMarkdownYDoc, richMarkdownFromYDoc, richMarkdownSchemaExtensions } from '../app/lib/collaboration/markdown-state';

function copy(doc: Y.Doc, gc = true) {
  const clone = new Y.Doc({ gc });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
}

function capture(doc: Y.Doc) {
  const snapshot = captureAgentStateSnapshot(doc, Y);
  assert.ok(snapshot, 'the complete authored operation has a snapshot');
  return snapshot;
}

function includes(doc: Y.Doc, expected: Uint8Array) {
  const before = Y.encodeStateAsUpdate(doc);
  const savedSnapshot = expected.slice();
  const result = persistedUpdateIncludesAgentSnapshot(before, expected, Y);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before, 'verification never changes the source document');
  assert.deepEqual(expected, savedSnapshot, 'verification does not mutate the operation receipt');
  return result;
}

test('pure deletion requires its delete ranges even when state vectors stay unchanged', () => {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'AAA BBB CCC');
  const before = copy(doc);
  try {
    doc.getText('content').delete(4, 4);
    const receipt = capture(doc);
    assert.deepEqual(Y.encodeStateVector(doc), Y.encodeStateVector(before));
    assert.equal(includes(before, receipt), false, 'a vector-only acknowledgement would incorrectly pass');
    assert.equal(includes(doc, receipt), true);
    doc.getText('content').delete(0, doc.getText('content').length);
    assert.equal(includes(doc, capture(doc)), true, 'deleting all content is still a nonempty operation receipt');
  } finally { doc.destroy(); before.destroy(); }
});

test('different or partial deletions cannot certify the required deletion', () => {
  const base = new Y.Doc(); base.getText('content').insert(0, 'ABCDEF');
  const expected = copy(base); const other = copy(base); const partial = copy(base);
  try {
    expected.getText('content').delete(1, 3);
    other.getText('content').delete(4, 2);
    partial.getText('content').delete(1, 2);
    const receipt = capture(expected);
    assert.deepEqual(Y.encodeStateVector(expected), Y.encodeStateVector(other));
    assert.equal(includes(other, receipt), false);
    assert.equal(includes(partial, receipt), false);
    Y.applyUpdate(other, Y.encodeStateAsUpdate(expected));
    assert.equal(includes(other, receipt), true, 'a merged superset of both delete sets includes the operation');
  } finally { for (const doc of [base, expected, other, partial]) doc.destroy(); }
});

test('later independent insertions and deletions preserve the earlier operation receipt', () => {
  const base = new Y.Doc(); base.getText('content').insert(0, 'AAA BBB CCC');
  const agent = copy(base); const peer = copy(base);
  try {
    agent.getText('content').delete(4, 4);
    agent.getText('content').insert(4, 'Agent ');
    const receipt = capture(agent);
    assert.equal(includes(peer, receipt), false, 'the earlier persisted vector lacks agent insertions');
    peer.getText('content').delete(0, 1);
    peer.getText('content').insert(peer.getText('content').length, ' Peer');
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(agent));
    assert.equal(includes(peer, receipt), true);
    peer.getText('content').delete(0, peer.getText('content').length);
    assert.equal(includes(peer, receipt), true, 'later removal does not undo the fact that the operation was persisted');
  } finally { base.destroy(); agent.destroy(); peer.destroy(); }
});

test('receipts contain clocks and delete ranges without document text', () => {
  const privateDoc = new Y.Doc(); const alternateDoc = new Y.Doc();
  privateDoc.clientID = 12345;
  alternateDoc.clientID = 12345;
  try {
    privateDoc.getText('content').insert(0, 'private-password-123');
    alternateDoc.getText('content').insert(0, 'unrelated-value-4567');
    privateDoc.getText('content').delete(4, 3);
    alternateDoc.getText('content').delete(4, 3);
    assert.equal(privateDoc.getText('content').length, alternateDoc.getText('content').length);
    assert.deepEqual(capture(privateDoc), capture(alternateDoc), 'equal structure clocks encode identically regardless of text');
    assert.equal(Buffer.from(capture(privateDoc)).includes(Buffer.from('private')), false);
  } finally { privateDoc.destroy(); alternateDoc.destroy(); }
});

test('garbage collection and binary reopening preserve required deletion coverage', () => {
  const doc = new Y.Doc({ gc: false });
  const nested = new Y.Map();
  const text = new Y.Text('private nested text');
  nested.set('text', text);
  doc.getMap('blocks').set('paragraph', nested);
  let restored: Y.Doc | undefined;
  try {
    doc.getMap('blocks').delete('paragraph');
    const receipt = capture(doc);
    restored = copy(doc, true);
    assert.ok([...restored.store.clients.values()].flat().some((struct) => struct instanceof Y.GC),
      'the restored document actually garbage-collected nested content');
    assert.deepEqual(capture(restored), receipt);
    assert.equal(includes(restored, receipt), true);
  } finally { doc.destroy(); restored?.destroy(); }
});

for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
  test(`rich block deletion is certified only after persistence in ${representation}`, () => {
    const doc = createRichMarkdownYDoc('First\n\nRemove me\n\nKeep', representation);
    const before = copy(doc);
    let restored: Y.Doc | undefined;
    try {
      if (representation === 'tiptap_xml') doc.getXmlFragment('body').delete(1, 1);
      else {
        const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
        tree.delete(tree.read().child(1).attrs.id as string, 'agent-deletion', 'agent');
      }
      assert.equal(richMarkdownFromYDoc(doc), 'First\n\nKeep');
      const receipt = capture(doc);
      assert.equal(includes(before, receipt), false);
      restored = copy(doc);
      assert.equal(includes(restored, receipt), true);
      assert.equal(richMarkdownFromYDoc(restored), 'First\n\nKeep');
    } finally { doc.destroy(); before.destroy(); restored?.destroy(); }
  });
}

for (const pendingKind of ['structures', 'delete ranges'] as const) {
  test(`out-of-order ${pendingKind} cannot certify a persisted update even when the expected operation is already present`, () => {
    const base = new Y.Doc(); base.getText('content').insert(0, 'Already integrated');
    const pending = copy(base); const foreign = new Y.Doc();
    try {
      const receipt = capture(base);
      foreign.getText('content').insert(0, 'A');
      const prerequisite = Y.encodeStateAsUpdate(foreign);
      const prerequisiteVector = Y.encodeStateVector(foreign);
      if (pendingKind === 'structures') foreign.getText('content').insert(1, 'B');
      else foreign.getText('content').delete(0, 1);
      Y.applyUpdate(pending, Y.encodeStateAsUpdate(foreign, prerequisiteVector));
      assert.ok(pendingKind === 'structures' ? pending.store.pendingStructs : pending.store.pendingDs);
      assert.equal(captureAgentStateSnapshot(pending, Y), null);
      assert.equal(includes(pending, receipt), false, 'integrated subset alone is insufficient');
      Y.applyUpdate(pending, prerequisite);
      assert.ok(captureAgentStateSnapshot(pending, Y));
      assert.equal(includes(pending, receipt), true);
    } finally { base.destroy(); pending.destroy(); foreign.destroy(); }
  });
}

test('malformed, missing, empty and extended snapshots never acknowledge an operation', () => {
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'ABC');
  const empty = new Y.Doc();
  try {
    const update = Y.encodeStateAsUpdate(doc);
    const valid = capture(doc);
    const invalid: Array<Uint8Array | null> = [null, new Uint8Array(), new Uint8Array([255]),
      valid.slice(0, -1), Uint8Array.from([...valid, 0]), capture(empty)];
    for (const snapshot of invalid) assert.equal(persistedUpdateIncludesAgentSnapshot(update, snapshot, Y), false);
    for (const corruptedUpdate of [new Uint8Array(), new Uint8Array([255]), update.slice(0, -1)]) {
      assert.equal(persistedUpdateIncludesAgentSnapshot(corruptedUpdate, valid, Y), false);
    }
    assert.equal(persistedUpdateIncludesAgentSnapshot(update, valid, Y), true);
  } finally { doc.destroy(); empty.destroy(); }
});

test('temporary read-only documents are destroyed on success and malformed persisted input', () => {
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'ABC');
  const temporary: Y.Doc[] = [];
  let destroyed = 0;
  class ReadOnlyDoc extends Y.Doc {
    constructor() {
      super();
      temporary.push(this);
      this.on('destroy', () => { destroyed++; });
    }
  }
  const runtime = { ...Y, Doc: ReadOnlyDoc } as typeof Y;
  try {
    const receipt = capture(doc);
    assert.equal(persistedUpdateIncludesAgentSnapshot(Y.encodeStateAsUpdate(doc), receipt, runtime), true);
    assert.equal(persistedUpdateIncludesAgentSnapshot(new Uint8Array([255]), receipt, runtime), false);
    assert.equal(temporary.length, 2);
    assert.equal(destroyed, 2);
  } finally { doc.destroy(); }
});
