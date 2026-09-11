import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';

import { AgentBlockEditError, applyAgentBlockEdit, prepareAgentBlockEdit, previewAgentBlockEdit, type AgentBlockEditRequest, type AgentTableAction } from '../app/lib/collaboration/agent-block-edits';
import { readAgentBlockStructure } from '../app/lib/collaboration/agent-block-structure';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichMarkdownYDoc, richMarkdownFromYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';

const schema = getSchema(richMarkdownSchemaExtensions());
const reopen = (doc: Y.Doc) => {
  const next = new Y.Doc(); Y.applyUpdate(next, Y.encodeStateAsUpdate(doc)); return next;
};
const block = (doc: Y.Doc, text: string, type = 'paragraph') => {
  const found = readAgentBlockStructure(doc).find((entry) => entry.type === type && entry.text === text);
  assert.ok(found, `${type}: ${text}`); return found;
};
const replaceText = (doc: Y.Doc, id: string, value: string) => {
  const tree = new CollaborationBlockTree(doc, schema);
  let node = tree.read().firstChild!;
  tree.read().descendants((entry) => { if (entry.attrs.id === id) node = entry; });
  tree.updateInlineContent(id, node.type.create(node.attrs, schema.text(value)), 'human');
};
const rejectedUnchanged = (doc: Y.Doc, action: () => unknown, code: AgentBlockEditError['code'] = 'target_changed') => {
  const before = Y.encodeStateAsUpdate(doc);
  assert.throws(action, (error: unknown) => error instanceof AgentBlockEditError && error.code === code);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
};

test('move permits concurrent foreign text, previews locally and reverts after binary reload', () => {
  const doc = createRichMarkdownYDoc('A\n\nB\n\nC', 'tiptap_blocks');
  let restored: Y.Doc | undefined;
  try {
    const a = block(doc, 'A');
    const sharedRoots = [...doc.share.keys()];
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'move_block', blockId: a.id, placementHash: a.placementHash, parentId: null, beforeId: null }]);
    const bytes = Y.encodeStateAsUpdate(doc);
    const preview = previewAgentBlockEdit(doc, prepared);
    assert.equal(JSON.parse(preview.afterText)[0].beforeId, null);
    assert.ok(!preview.afterText.includes('"text": "B"'), 'preview contains only the affected block');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), bytes, 'preparation and preview are read-only');
    assert.deepEqual([...doc.share.keys()], sharedRoots, 'preview does not create empty metadata roots');
    replaceText(doc, a.id, 'A from human');
    let updates = 0; doc.on('update', () => { updates++; });
    const { reverse } = applyAgentBlockEdit(doc, JSON.parse(JSON.stringify(prepared)), 'agent');
    assert.ok(reverse); assert.equal(updates, 1);
    assert.equal(richMarkdownFromYDoc(doc), 'B\n\nC\n\nA from human');
    restored = reopen(doc);
    replaceText(restored, a.id, 'More human text');
    let reversals = 0; restored.on('update', () => { reversals++; });
    applyAgentBlockEdit(restored, JSON.parse(JSON.stringify(reverse)), 'agent-revert');
    assert.equal(reversals, 1);
    assert.equal(richMarkdownFromYDoc(restored), 'More human text\n\nB\n\nC');
  } finally { doc.destroy(); restored?.destroy(); }
});

test('move approval footprint excludes context text but binds a different proposal', () => {
  const doc = createRichMarkdownYDoc('A\n\nB\n\nC', 'tiptap_blocks');
  try {
    const a = block(doc, 'A'); const b = block(doc, 'B');
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'move_block', blockId: a.id, placementHash: a.placementHash, parentId: null, beforeId: null }]);
    const first = previewAgentBlockEdit(doc, prepared);
    replaceText(doc, b.id, 'Unrelated human text');
    assert.equal(previewAgentBlockEdit(doc, prepared).footprintHash, first.footprintHash);
    replaceText(doc, a.id, 'Target human text');
    assert.equal(previewAgentBlockEdit(doc, prepared).footprintHash, first.footprintHash);
    assert.ok(previewAgentBlockEdit(doc, prepared).afterText.includes('Target human text'));
    const another = prepareAgentBlockEdit(doc, [{ kind: 'move_block', blockId: a.id, placementHash: a.placementHash, parentId: null, beforeId: b.id }]);
    assert.notEqual(previewAgentBlockEdit(doc, another).footprintHash, first.footprintHash);
  } finally { doc.destroy(); }
});

test('deleted or changed targets reject a prepared group without any partial apply', () => {
  const doc = createRichMarkdownYDoc('A\n\nB\n\nC', 'tiptap_blocks');
  try {
    const a = block(doc, 'A'); const b = block(doc, 'B');
    const prepared = prepareAgentBlockEdit(doc, [
      { kind: 'move_block', blockId: a.id, placementHash: a.placementHash, parentId: null, beforeId: null },
      { kind: 'delete_block', blockId: b.id, subtreeHash: b.subtreeHash },
    ]);
    replaceText(doc, b.id, 'Changed B');
    rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, prepared, 'agent'));
    new CollaborationBlockTree(doc, schema).delete(a.id, 'human-delete', 'human');
    rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, prepared, 'agent'));
  } finally { doc.destroy(); }
});

test('an older stamped move must still achieve its requested destination after foreign placement', () => {
  const doc = createRichMarkdownYDoc('A\n\nB\n\nC', 'tiptap_blocks');
  try {
    const a = block(doc, 'A'); const b = block(doc, 'B');
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'move_block', blockId: a.id, placementHash: a.placementHash, parentId: null, beforeId: null }]);
    replaceText(doc, block(doc, 'C').id, 'advance the clock past the prepared move');
    new CollaborationBlockTree(doc, schema).move({ blockId: b.id, parentId: null, beforeId: null, operationId: 'human-last' }, 'human');
    assert.equal(readAgentBlockStructure(doc).find((entry) => entry.id === a.id)?.placementHash, a.placementHash);
    rejectedUnchanged(doc, () => previewAgentBlockEdit(doc, prepared));
    rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, prepared, 'agent'));
  } finally { doc.destroy(); }
});

for (const action of ['delete', 'reparent'] as const) {
  test(`old forward ${action} cannot invalidate a later human move to its anchor`, () => {
    const doc = createRichMarkdownYDoc('A\n\nB\n\nC\n\nD\n\n> Q', 'tiptap_blocks');
    try {
      const a = block(doc, 'A'); const d = block(doc, 'D');
      const quote = readAgentBlockStructure(doc).find((entry) => entry.type === 'blockquote')!;
      const prepared = prepareAgentBlockEdit(doc, [action === 'delete'
        ? { kind: 'delete_block', blockId: a.id, subtreeHash: a.subtreeHash }
        : { kind: 'move_block', blockId: a.id, placementHash: a.placementHash, parentId: quote.id, beforeId: null }]);
      replaceText(doc, block(doc, 'C').id, 'Human text advances the clock after preparation');
      const tree = new CollaborationBlockTree(doc, schema);
      tree.move({ blockId: d.id, parentId: null, beforeId: a.id, operationId: 'human-before-a' }, 'human');
      assert.equal(tree.project().conflicts.length, 0);
      const json = tree.read().toJSON();
      rejectedUnchanged(doc, () => previewAgentBlockEdit(doc, prepared));
      rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, prepared, 'agent'));
      assert.deepEqual(tree.read().toJSON(), json);
      assert.equal(tree.project().conflicts.length, 0, 'the human move stays accepted');
    } finally { doc.destroy(); }
  });
}

test('old reparent cannot reactivate a foreign placement that is currently rejected', () => {
  const doc = createRichMarkdownYDoc('A\n\nB\n\nC\n\nD\n\n> Q', 'tiptap_blocks');
  const tree = new CollaborationBlockTree(doc, schema);
  const undo = tree.createUndoManager('temporary-parent');
  try {
    const a = block(doc, 'A'); const d = block(doc, 'D');
    const quote = readAgentBlockStructure(doc).find((entry) => entry.type === 'blockquote')!;
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'move_block', blockId: a.id, placementHash: a.placementHash,
      parentId: quote.id, beforeId: null }]);
    replaceText(doc, block(doc, 'C').id, 'Advance past the prepared placement');
    tree.move({ blockId: a.id, parentId: quote.id, beforeId: null, operationId: 'temporary-parent' }, 'temporary-parent');
    tree.move({ blockId: d.id, parentId: quote.id, beforeId: a.id, operationId: 'human-dependent' }, 'human');
    undo.undo();
    assert.equal(readAgentBlockStructure(doc).find((entry) => entry.id === a.id)?.placementHash, a.placementHash);
    assert.ok(tree.project().conflicts.some((conflict) => conflict.operationId === 'human-dependent' && conflict.reason === 'target_changed'));
    rejectedUnchanged(doc, () => previewAgentBlockEdit(doc, prepared));
    rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, prepared, 'agent'));
  } finally { undo.destroy(); doc.destroy(); }
});

test('delete still permits an unrelated later foreign placement', () => {
  const doc = createRichMarkdownYDoc('A\n\nB\n\nC\n\nD', 'tiptap_blocks');
  try {
    const a = block(doc, 'A'); const b = block(doc, 'B'); const d = block(doc, 'D');
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'delete_block', blockId: a.id, subtreeHash: a.subtreeHash }]);
    replaceText(doc, block(doc, 'C').id, 'Human C');
    const tree = new CollaborationBlockTree(doc, schema);
    tree.move({ blockId: d.id, parentId: null, beforeId: b.id, operationId: 'human-before-b' }, 'human');
    applyAgentBlockEdit(doc, prepared, 'agent');
    assert.equal(richMarkdownFromYDoc(doc), 'D\n\nB\n\nHuman C');
    assert.equal(tree.project().conflicts.length, 0);
  } finally { doc.destroy(); }
});

test('move into a container then delete guards the original text of every deleted block', () => {
  const doc = createRichMarkdownYDoc('A\n\nB\n\n> Q\n\nTail', 'tiptap_blocks');
  try {
    const a = block(doc, 'A');
    const quote = readAgentBlockStructure(doc).find((entry) => entry.type === 'blockquote')!;
    const prepared = prepareAgentBlockEdit(doc, [
      { kind: 'move_block', blockId: a.id, placementHash: a.placementHash, parentId: quote.id, beforeId: null },
      { kind: 'delete_block', blockId: quote.id, subtreeHash: quote.subtreeHash },
    ]);
    assert.ok(prepared.conditions.some((condition) => condition.id === a.id && condition.subtreeHash === a.subtreeHash));
    replaceText(doc, a.id, 'Human changed this content after the plan');
    rejectedUnchanged(doc, () => previewAgentBlockEdit(doc, prepared));
    rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, prepared, 'agent'));
    assert.ok(readAgentBlockStructure(doc).some((entry) => entry.id === a.id));
  } finally { doc.destroy(); }
});

test('move into a table cell then delete its row guards the newly included existing content', () => {
  const doc = createRichMarkdownYDoc('A\n\n| H1 | H2 |\n| --- | --- |\n| one | two |\n| keep | row |\n\nTail', 'tiptap_blocks');
  try {
    const a = block(doc, 'A'); const cell = block(doc, 'one', 'tableCell');
    const table = readAgentBlockStructure(doc).find((entry) => entry.type === 'table')!;
    const prepared = prepareAgentBlockEdit(doc, [
      { kind: 'move_block', blockId: a.id, placementHash: a.placementHash, parentId: cell.id, beforeId: null },
      { kind: 'table_operation', cellId: cell.id, subtreeHash: table.subtreeHash, action: 'deleteRow' },
    ]);
    assert.ok(prepared.conditions.some((condition) => condition.id === a.id && condition.subtreeHash === a.subtreeHash));
    replaceText(doc, a.id, 'Human content must not be hidden by the row deletion');
    rejectedUnchanged(doc, () => previewAgentBlockEdit(doc, prepared));
    rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, prepared, 'agent'));
  } finally { doc.destroy(); }
});

test('delete restores the same records and retains unrelated changes', () => {
  const doc = createRichMarkdownYDoc('Keep\n\n> Quote\n>\n> Child\n\nTail', 'tiptap_blocks');
  let restored: Y.Doc | undefined;
  try {
    const target = readAgentBlockStructure(doc).find((entry) => entry.type === 'blockquote')!;
    const tail = block(doc, 'Tail');
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'delete_block', blockId: target.id, subtreeHash: target.subtreeHash }]);
    const { reverse } = applyAgentBlockEdit(doc, prepared, 'agent'); assert.ok(reverse);
    restored = reopen(doc); replaceText(restored, tail.id, 'Human tail');
    applyAgentBlockEdit(restored, reverse, 'agent-revert');
    assert.equal(readAgentBlockStructure(restored).find((entry) => entry.id === target.id)?.text, target.text);
    assert.ok(richMarkdownFromYDoc(restored).includes('Human tail'));
  } finally { doc.destroy(); restored?.destroy(); }
});

test('insert IDs are fixed at preparation; inverse removes only unchanged inserted records', () => {
  const doc = createRichMarkdownYDoc('A\n\nB', 'tiptap_blocks');
  let restored: Y.Doc | undefined;
  try {
    const b = block(doc, 'B');
    const request = [{ kind: 'insert_blocks' as const, parentId: null, beforeId: b.id,
      blocks: [{ type: 'paragraph', attrs: { id: 'untrusted-id' }, content: [{ type: 'text', text: 'New' }] }] }];
    const prepared = prepareAgentBlockEdit(doc, request);
    assert.equal(request[0].blocks[0].attrs.id, 'untrusted-id');
    const first = previewAgentBlockEdit(doc, prepared); assert.ok(first.afterText.includes('"text": "New"'));
    const { reverse } = applyAgentBlockEdit(doc, prepared, 'agent'); assert.ok(reverse);
    const inserted = block(doc, 'New'); assert.notEqual(inserted.id, 'untrusted-id');
    assert.ok(prepared.affectedBlockIds.includes(inserted.id));
    restored = reopen(doc); replaceText(restored, b.id, 'Human B');
    applyAgentBlockEdit(restored, reverse, 'agent-revert');
    assert.equal(richMarkdownFromYDoc(restored), 'A\n\nHuman B');
    const tree = new CollaborationBlockTree(restored, schema);
    assert.ok(tree.records.has(inserted.id), 'insert reversion retains the record as a tombstone');
    assert.ok(tree.project().deleted.has(inserted.id));
    assert.ok(tree.receipts.size > 0);
    rejectedUnchanged(restored, () => applyAgentBlockEdit(restored!, prepared, 'old-forward-retry'));
    replaceText(doc, inserted.id, 'Human changed insertion');
    rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, reverse, 'agent-revert'));
  } finally { doc.destroy(); restored?.destroy(); }
});

test('format reverses the authored attribute and keeps concurrent block text', () => {
  const doc = createRichMarkdownYDoc('# Heading\n\nTail', 'tiptap_blocks');
  try {
    const heading = block(doc, 'Heading', 'heading');
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'format_block', blockId: heading.id, beforeAttrs: { level: 1 }, afterAttrs: { level: 2 } }]);
    const { reverse } = applyAgentBlockEdit(doc, prepared, 'agent'); assert.ok(reverse);
    replaceText(doc, heading.id, 'Human heading');
    applyAgentBlockEdit(doc, reverse, 'agent-revert');
    assert.equal(richMarkdownFromYDoc(doc), '# Human heading\n\nTail');
    rejectedUnchanged(doc, () => prepareAgentBlockEdit(doc, [{ kind: 'format_block', blockId: heading.id,
      beforeAttrs: { id: heading.id }, afterAttrs: { id: 'replacement' } }]), 'schema_invalid');
  } finally { doc.destroy(); }
});

test('format reversion rejects a later human change to the same attribute', () => {
  const doc = createRichMarkdownYDoc('# Heading\n\nTail', 'tiptap_blocks');
  try {
    const heading = block(doc, 'Heading', 'heading');
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'format_block', blockId: heading.id, beforeAttrs: { level: 1 }, afterAttrs: { level: 2 } }]);
    const { reverse } = applyAgentBlockEdit(doc, prepared, 'agent'); assert.ok(reverse);
    const record = new CollaborationBlockTree(doc, schema).records.get(heading.id)!;
    (record.get('attributes') as Y.Map<unknown>).set('level', 3);
    rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, reverse, 'agent-revert'));
  } finally { doc.destroy(); }
});

const tableSource = '| A | B |\n| --- | --- |\n| one | two |\n| three | four |\n\nTail';
for (const action of ['addRowBefore', 'addRowAfter', 'deleteRow', 'addColumnBefore', 'addColumnAfter', 'deleteColumn',
  'deleteTable', 'alignLeft', 'alignCenter', 'alignRight', 'alignNone', 'moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight'] satisfies AgentTableAction[]) {
  test(`portable table ${action} applies atomically and reverses across binary reload`, () => {
    const doc = createRichMarkdownYDoc(tableSource, 'tiptap_blocks');
    let restored: Y.Doc | undefined;
    try {
      const initial = richMarkdownFromYDoc(doc);
      const table = readAgentBlockStructure(doc).find((entry) => entry.type === 'table')!;
      const cellText = action === 'moveRowUp' ? 'three' : action === 'moveColumnLeft' ? 'two' : 'one';
      const cell = block(doc, cellText, 'tableCell');
      const prepared = prepareAgentBlockEdit(doc, [{ kind: 'table_operation', cellId: cell.id, subtreeHash: table.subtreeHash, action }]);
      let updates = 0; doc.on('update', () => { updates++; });
      const { reverse } = applyAgentBlockEdit(doc, prepared, 'agent'); assert.ok(reverse);
      assert.ok(updates <= 1);
      restored = reopen(doc);
      applyAgentBlockEdit(restored, reverse, 'agent-revert');
      assert.equal(richMarkdownFromYDoc(restored), initial);
    } finally { doc.destroy(); restored?.destroy(); }
  });
}

test('list insertion uses existing schema rules and reverses without losing list text', () => {
  const doc = createRichMarkdownYDoc('- First\n- Last\n\nTail', 'tiptap_blocks');
  try {
    const entries = readAgentBlockStructure(doc); const list = entries.find((entry) => entry.type === 'bulletList')!;
    const last = block(doc, 'Last', 'listItem');
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'insert_blocks', parentId: list.id, beforeId: last.id,
      blocks: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Middle' }] }] }] }]);
    const { reverse } = applyAgentBlockEdit(doc, prepared, 'agent'); assert.ok(reverse);
    assert.ok(richMarkdownFromYDoc(doc).includes('Middle'));
    replaceText(doc, block(doc, 'First').id, 'Human first');
    applyAgentBlockEdit(doc, reverse, 'agent-revert');
    assert.ok(richMarkdownFromYDoc(doc).includes('Human first')); assert.ok(!richMarkdownFromYDoc(doc).includes('Middle'));
  } finally { doc.destroy(); }
});

test('insertion never silently fits blocks into a different parent than requested', () => {
  const doc = createRichMarkdownYDoc('Paragraph\n\nTail', 'tiptap_blocks');
  try {
    const parent = block(doc, 'Paragraph');
    rejectedUnchanged(doc, () => prepareAgentBlockEdit(doc, [{ kind: 'insert_blocks', parentId: parent.id, beforeId: null,
      blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested invalid paragraph' }] }] }]), 'schema_invalid');
  } finally { doc.destroy(); }
});

test('table attribute reversion preserves later human cell text; stale table preparation rejects it', () => {
  const doc = createRichMarkdownYDoc(tableSource, 'tiptap_blocks');
  try {
    const table = readAgentBlockStructure(doc).find((entry) => entry.type === 'table')!;
    const cell = block(doc, 'one', 'tableCell'); const paragraph = block(doc, 'one');
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'table_operation', cellId: cell.id, subtreeHash: table.subtreeHash, action: 'alignCenter' }]);
    const { reverse } = applyAgentBlockEdit(doc, prepared, 'agent'); assert.ok(reverse);
    replaceText(doc, paragraph.id, 'Human cell edit');
    applyAgentBlockEdit(doc, reverse, 'agent-revert');
    assert.ok(richMarkdownFromYDoc(doc).includes('Human cell edit'));
    rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, prepared, 'stale-forward'));
  } finally { doc.destroy(); }
});

test('payload and request count limits reject before live mutation', () => {
  const doc = createRichMarkdownYDoc('Keep', 'tiptap_blocks');
  try {
    const request = { kind: 'insert_blocks' as const, parentId: null, beforeId: null, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] };
    rejectedUnchanged(doc, () => prepareAgentBlockEdit(doc, Array(33).fill(request)), 'limit_exceeded');
    rejectedUnchanged(doc, () => prepareAgentBlockEdit(doc, [{ ...request, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(512 * 1024) }] }] }]), 'limit_exceeded');
  } finally { doc.destroy(); }
});

test('required runtime request guards cannot be disabled by omitted or malformed fields', () => {
  const doc = createRichMarkdownYDoc('A\n\nB', 'tiptap_blocks');
  try {
    const a = block(doc, 'A');
    const invalid: unknown[] = [
      { kind: 'delete_block', blockId: a.id },
      { kind: 'delete_block', blockId: a.id, subtreeHash: null },
      { kind: 'delete_block', blockId: a.id, subtreeHash: 'bad' },
      { kind: 'move_block', blockId: a.id, parentId: null, beforeId: null },
      { kind: 'move_block', blockId: a.id, placementHash: a.placementHash, beforeId: null },
      { kind: 'move_block', blockId: a.id, placementHash: a.placementHash, parentId: 123, beforeId: null },
      { kind: 'insert_blocks', beforeId: null, blocks: [{ type: 'paragraph' }] },
      { kind: 'format_block', blockId: a.id, beforeAttrs: null, afterAttrs: {} },
      { kind: 'table_operation', cellId: a.id, action: 'deleteTable' },
      { kind: 'format_text', blockId: a.id, from: 0, to: 1, mark: 'bold', enabled: true },
      { kind: 'format_text', blockId: a.id, subtreeHash: a.subtreeHash, from: 0, to: 1, mark: 'bold' },
      { kind: 'format_text', blockId: a.id, subtreeHash: a.subtreeHash, from: 0, to: 1, mark: 'raw_html', enabled: true },
      { kind: 'delete_block', blockId: a.id, subtreeHash: a.subtreeHash, updateBase64: 'forbidden' },
      { kind: 'unknown', blockId: a.id },
    ];
    for (const request of invalid) rejectedUnchanged(doc, () => prepareAgentBlockEdit(doc, [request as AgentBlockEditRequest]), 'schema_invalid');
  } finally { doc.destroy(); }
});

for (const mark of ['bold', 'italic', 'strike', 'code', 'link'] as const) {
  test(`bounded ${mark} formatting and mark removal survive reload and selective reverse`, () => {
    const doc = createRichMarkdownYDoc('Hello world\n\nUnrelated', 'tiptap_blocks');
    let restored: Y.Doc | undefined;
    try {
      const target = block(doc, 'Hello world'); const other = block(doc, 'Unrelated');
      const prepared = prepareAgentBlockEdit(doc, [{ kind: 'format_text', blockId: target.id, subtreeHash: target.subtreeHash,
        from: 0, to: 5, mark, enabled: true, ...(mark === 'link' ? { href: 'https://example.com/docs' } : {}) }]);
      let updates = 0; doc.on('update', () => { updates++; });
      const { reverse } = applyAgentBlockEdit(doc, prepared, 'agent'); assert.ok(reverse); assert.equal(updates, 1);
      const formatted = new CollaborationBlockTree(doc, schema).read().firstChild!;
      assert.ok(formatted.firstChild!.marks.some((value) => value.type.name === mark));
      assert.equal(formatted.lastChild!.marks.length, 0, 'formatting stays within the requested range');
      restored = reopen(doc); replaceText(restored, other.id, 'Human unrelated');
      applyAgentBlockEdit(restored, reverse, 'agent-revert');
      assert.equal(richMarkdownFromYDoc(restored), 'Hello world\n\nHuman unrelated');
      const current = block(doc, 'Hello world');
      const remove = prepareAgentBlockEdit(doc, [{ kind: 'format_text', blockId: target.id, subtreeHash: current.subtreeHash,
        from: 0, to: 5, mark, enabled: false }]);
      const removed = applyAgentBlockEdit(doc, remove, 'agent-remove'); assert.ok(removed.reverse);
      assert.equal(new CollaborationBlockTree(doc, schema).read().firstChild!.firstChild!.marks.length, 0);
      applyAgentBlockEdit(doc, removed.reverse, 'agent-revert-remove');
      assert.ok(new CollaborationBlockTree(doc, schema).read().firstChild!.firstChild!.marks.some((value) => value.type.name === mark));
    } finally { doc.destroy(); restored?.destroy(); }
  });
}

test('format ranges reject grapheme splits, foreign blocks and unsafe link protocols', () => {
  const doc = createRichMarkdownYDoc('A👩‍💻éZ\n\nTail', 'tiptap_blocks');
  try {
    const target = block(doc, 'A👩‍💻éZ');
    const request = { kind: 'format_text' as const, blockId: target.id, subtreeHash: target.subtreeHash,
      from: 1, to: 6, mark: 'bold' as const, enabled: true };
    assert.ok(prepareAgentBlockEdit(doc, [request]));
    for (const range of [[1, 2], [1, 4], [6, 7], [0, 20]]) {
      rejectedUnchanged(doc, () => prepareAgentBlockEdit(doc, [{ ...request, from: range[0], to: range[1] }]), 'schema_invalid');
    }
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)']) {
      rejectedUnchanged(doc, () => prepareAgentBlockEdit(doc, [{ ...request, mark: 'link', href }]), 'schema_invalid');
    }
    const prepared = prepareAgentBlockEdit(doc, [request]);
    const { reverse } = applyAgentBlockEdit(doc, prepared, 'agent'); assert.ok(reverse);
    replaceText(doc, target.id, 'Later human target text');
    rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, reverse, 'agent-revert'));
  } finally { doc.destroy(); }
});

test('native schema-valid blocks remain editable when Markdown projection is unstable', () => {
  const doc = createRichMarkdownYDoc('- First\n- Second\n\nTail', 'tiptap_blocks');
  try {
    const first = block(doc, 'First');
    replaceText(doc, first.id, 'A\t\nB');
    const validation = validateRichMarkdownYDoc(doc);
    assert.equal(validation.valid, false); assert.equal(validation.code, 'roundtrip_unstable');
    const entries = readAgentBlockStructure(doc); const list = entries.find((entry) => entry.type === 'bulletList')!;
    const item = entries.find((entry) => entry.type === 'listItem' && entry.text === 'A\t\nB')!;
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'move_block', blockId: item.id, placementHash: item.placementHash,
      parentId: list.id, beforeId: null }]);
    const { reverse } = applyAgentBlockEdit(doc, prepared, 'agent'); assert.ok(reverse);
    assert.ok(readAgentBlockStructure(doc).some((entry) => entry.id === first.id && entry.text === 'A\t\nB'));
    applyAgentBlockEdit(doc, reverse, 'agent-revert');
    assert.ok(readAgentBlockStructure(doc).some((entry) => entry.id === first.id && entry.text === 'A\t\nB'));
  } finally { doc.destroy(); }
});
