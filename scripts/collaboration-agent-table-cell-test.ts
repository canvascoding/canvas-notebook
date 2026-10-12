import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';

import { AgentBlockEditError, applyAgentBlockEdit, prepareAgentBlockEdit } from '../app/lib/collaboration/agent-block-edits';
import { readAgentBlockStructure, validateAgentBlockDocument } from '../app/lib/collaboration/agent-block-structure';
import { applyAgentTextTargets, createRichAgentTextTargets } from '../app/lib/collaboration/agent-operations';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichMarkdownYDoc, richMarkdownFromYDoc, richMarkdownSchemaExtensions } from '../app/lib/collaboration/markdown-state';

const schema = getSchema(richMarkdownSchemaExtensions());
const origin = { actorType: 'agent' as const, actorId: 'agent', initiatedByUserId: 'human', operationId: 'cell-test' };
const applyText = (doc: Y.Doc, targets: ReturnType<typeof createRichAgentTextTargets>) =>
  applyAgentTextTargets({ doc, targets, origin, validateClone: validateAgentBlockDocument });
const contentPlan = '| Article | Status |\n| --- | --- |\n| First | **✅ Online** |\n| Second | ✅ Online |';

function multiParagraphCellDoc() {
  const paragraph = (id: string, text: string) => schema.nodes.paragraph.create({ id }, schema.text(text));
  const cell = schema.nodes.tableCell.create({ id: 'cell' }, [paragraph('first', 'Same Alpha'), paragraph('second', 'Beta Same')]);
  const row = schema.nodes.tableRow.create({ id: 'row' }, cell);
  const table = schema.nodes.table.create({ id: 'table' }, row);
  const doc = new Y.Doc();
  CollaborationBlockTree.create(doc, schema.topNodeType.create(null, table));
  return doc;
}

test('cells expose a complete table command target even when the table entry is outside a read page', () => {
  const doc = createRichMarkdownYDoc(contentPlan, 'tiptap_blocks');
  const restored = new Y.Doc();
  try {
    const before = Y.encodeStateAsUpdate(doc);
    let updates = 0; doc.on('update', () => { updates++; });
    const blocks = readAgentBlockStructure(doc);
    const table = blocks.find((block) => block.type === 'table')!;
    const cells = blocks.filter((block) => block.type === 'tableCell' || block.type === 'tableHeader');
    for (const cell of cells) {
      assert.deepEqual(cell.tableOperationTarget, { cellId: cell.id, subtreeHash: table.subtreeHash });
      assert.notEqual(cell.subtreeHash, cell.tableOperationTarget!.subtreeHash);
      const offset = blocks.findIndex((block) => block.id === cell.id);
      assert.deepEqual(blocks.slice(offset, offset + 1)[0].tableOperationTarget, cell.tableOperationTarget);
    }
    assert.ok(blocks.filter((block) => !cells.includes(block)).every((block) => block.tableOperationTarget === undefined));
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    assert.equal(updates, 0);
    Y.applyUpdate(restored, before);
    assert.deepEqual(readAgentBlockStructure(restored), blocks, 'metadata remains stable through binary hydration');
  } finally { doc.destroy(); restored.destroy(); }
});

test('a cell target edits only its own paragraph, preserves bold formatting and supports native revert', () => {
  const doc = createRichMarkdownYDoc(contentPlan, 'tiptap_blocks');
  try {
    const before = readAgentBlockStructure(doc);
    const cells = before.filter((block) => block.type === 'tableCell' && block.text === '✅ Online');
    const paragraph = before.find((block) => block.parentId === cells[0].id)!;
    const saved = Y.encodeStateAsUpdate(doc);
    const targets = createRichAgentTextTargets({ doc, blockId: cells[0].id, search: '✅ Online', replacement: '🗑️ Archiviert' });
    assert.equal(targets.length, 1);
    assert.equal(targets[0].blockId, paragraph.id, 'the native guard remains bound to the paragraph inside the cell');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), saved, 'target preparation cannot mutate the live document');
    const result = applyText(doc, targets);
    assert.equal(result.status, 'applied_to_ydoc', JSON.stringify(result.conflicts));
    const after = readAgentBlockStructure(doc);
    assert.equal(after.find((block) => block.id === cells[0].id)?.text, '🗑️ Archiviert');
    assert.equal(after.find((block) => block.id === cells[1].id)?.text, '✅ Online');
    assert.deepEqual(after.map((block) => block.id), before.map((block) => block.id));
    assert.match(richMarkdownFromYDoc(doc), /\*\*🗑️ Archiviert\*\*/u);
    assert.equal(applyText(doc, result.reverseTargets).status, 'applied_to_ydoc');
    assert.deepEqual(readAgentBlockStructure(doc), before);
  } finally { doc.destroy(); }
});

test('a header cell ID resolves its own descendant text without editing body cells', () => {
  const doc = createRichMarkdownYDoc('| Status |\n| --- |\n| Status |', 'tiptap_blocks');
  try {
    const header = readAgentBlockStructure(doc).find((block) => block.type === 'tableHeader')!;
    const result = applyText(doc, createRichAgentTextTargets({ doc, blockId: header.id, search: 'Status', replacement: 'State' }));
    assert.equal(result.status, 'applied_to_ydoc');
    const blocks = readAgentBlockStructure(doc);
    assert.equal(blocks.find((block) => block.id === header.id)?.text, 'State');
    assert.equal(blocks.find((block) => block.type === 'tableCell')?.text, 'Status');
  } finally { doc.destroy(); }
});

test('cell targets enforce occurrence counts within separate descendant text blocks', () => {
  const doc = multiParagraphCellDoc();
  try {
    const before = Y.encodeStateAsUpdate(doc);
    assert.throws(() => createRichAgentTextTargets({ doc, blockId: 'cell', search: 'Same', replacement: 'Chosen' }), /requires review/u);
    assert.throws(() => createRichAgentTextTargets({ doc, blockId: 'cell', search: 'Same', replacement: 'Chosen', expectedOccurrences: 3 }), /requires review/u);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    const targets = createRichAgentTextTargets({ doc, blockId: 'cell', search: 'Same', replacement: 'Chosen', expectedOccurrences: 2 });
    assert.deepEqual(targets.map((target) => target.blockId), ['first', 'second']);
    assert.equal(applyText(doc, targets).status, 'applied_to_ydoc');
    assert.equal(readAgentBlockStructure(doc).find((block) => block.id === 'cell')?.text, 'Chosen AlphaBeta Chosen');
  } finally { doc.destroy(); }
});

test('cell targeting refuses searches spanning paragraphs and never expands other containers', () => {
  const doc = multiParagraphCellDoc();
  try {
    const before = Y.encodeStateAsUpdate(doc);
    for (const blockId of ['cell', 'row', 'table', 'missing']) {
      assert.throws(() => createRichAgentTextTargets({ doc, blockId, search: 'AlphaBeta', replacement: 'Changed' }), /requires review/u);
    }
    for (const blockId of ['row', 'table']) {
      assert.throws(() => createRichAgentTextTargets({ doc, blockId, search: 'Alpha', replacement: 'Changed' }), /requires review/u);
    }
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  } finally { doc.destroy(); }
});

test('cell targets retain Unicode grapheme and invalid-surrogate guards', () => {
  const doc = createRichMarkdownYDoc('| Status |\n| --- |\n| 🗑️ Archiviert |', 'tiptap_blocks');
  try {
    const cell = readAgentBlockStructure(doc).find((block) => block.type === 'tableCell')!;
    const before = Y.encodeStateAsUpdate(doc);
    assert.throws(() => createRichAgentTextTargets({ doc, blockId: cell.id, search: '🗑', replacement: 'X' }), /grapheme boundaries/u);
    assert.throws(() => createRichAgentTextTargets({ doc, blockId: cell.id, search: 'Archiviert', replacement: '\uD800' }), /invalid Unicode surrogate/u);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  } finally { doc.destroy(); }
});

test('cell targets still reject a changed native paragraph after preparation', () => {
  const doc = createRichMarkdownYDoc(contentPlan, 'tiptap_blocks');
  try {
    const blocks = readAgentBlockStructure(doc);
    const cell = blocks.find((block) => block.type === 'tableCell' && block.text === '✅ Online')!;
    const targets = createRichAgentTextTargets({ doc, blockId: cell.id, search: '✅ Online', replacement: '🗑️ Archiviert' });
    const tree = new CollaborationBlockTree(doc, schema);
    const text = tree.content(targets[0].blockId!).get(0) as Y.XmlText;
    text.insert(text.length, ' human');
    text.delete(0, '✅'.length);
    const beforeApply = Y.encodeStateAsUpdate(doc);
    const result = applyText(doc, targets);
    assert.equal(result.status, 'needs_review');
    assert.ok(result.conflicts.some((conflict) => conflict.code === 'target_changed'));
    assert.deepEqual(Y.encodeStateAsUpdate(doc), beforeApply);
  } finally { doc.destroy(); }
});

test('table operations refuse cell hashes with an actionable diagnostic and accept the copied table target', () => {
  const doc = createRichMarkdownYDoc(contentPlan, 'tiptap_blocks');
  try {
    const cell = readAgentBlockStructure(doc).find((block) => block.type === 'tableCell' && block.text === 'Second')!;
    const before = Y.encodeStateAsUpdate(doc);
    assert.throws(() => prepareAgentBlockEdit(doc, [{ kind: 'table_operation', cellId: cell.id,
      subtreeHash: cell.subtreeHash, action: 'deleteRow' }]), (error: unknown) =>
      error instanceof AgentBlockEditError && error.code === 'target_changed' && error.message.includes('tableOperationTarget'));
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'table_operation', ...cell.tableOperationTarget!, action: 'deleteRow' }]);
    applyAgentBlockEdit(doc, prepared, origin);
    assert.equal(readAgentBlockStructure(doc).filter((block) => block.type === 'tableRow').length, 2);
    assert.ok(!richMarkdownFromYDoc(doc).includes('Second'));
    assert.ok(richMarkdownFromYDoc(doc).includes('First'));
  } finally { doc.destroy(); }
});

test('table command metadata becomes stale after a concurrent edit in another cell', () => {
  const doc = createRichMarkdownYDoc(contentPlan, 'tiptap_blocks');
  try {
    const blocks = readAgentBlockStructure(doc);
    const selected = blocks.find((block) => block.type === 'tableCell' && block.text === 'Second')!;
    const other = blocks.find((block) => block.type === 'tableCell' && block.text === 'First')!;
    assert.equal(applyText(doc, createRichAgentTextTargets({ doc, blockId: other.id, search: 'First', replacement: 'Changed' })).status, 'applied_to_ydoc');
    const current = readAgentBlockStructure(doc).find((block) => block.id === selected.id)!;
    assert.equal(current.subtreeHash, selected.subtreeHash, 'the selected cell content itself has not changed');
    assert.notEqual(current.tableOperationTarget!.subtreeHash, selected.tableOperationTarget!.subtreeHash);
    const before = Y.encodeStateAsUpdate(doc);
    assert.throws(() => prepareAgentBlockEdit(doc, [{ kind: 'table_operation', ...selected.tableOperationTarget!, action: 'deleteRow' }]),
      (error: unknown) => error instanceof AgentBlockEditError && error.code === 'target_changed');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  } finally { doc.destroy(); }
});
