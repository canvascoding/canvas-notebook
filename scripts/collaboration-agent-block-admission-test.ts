import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { readAgentBlockStructure, validateAgentBlockDocument } from '../app/lib/collaboration/agent-block-structure';
import { applyAgentBlockEdit, prepareAgentBlockEdit } from '../app/lib/collaboration/agent-block-edits';
import { applyAgentBlockTargets, applyAgentTextTargets, createRichAgentTextTargets } from '../app/lib/collaboration/agent-operations';
import { asAgentFileToolError } from '../app/lib/pi/agent-file-tool-results';
import { AgentBlockEditError } from '../app/lib/collaboration/agent-block-edits';
import { createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
const schema = getSchema(richMarkdownSchemaExtensions());
const origin = { actorType: 'agent' as const, actorId: 'agent', initiatedByUserId: 'human', operationId: 'test' };

function projectionFailureDocument() {
  const doc = createRichMarkdownYDoc('- A\n\nKeep', 'tiptap_blocks');
  const tree = new CollaborationBlockTree(doc, schema);
  const paragraph = tree.read().firstChild!.firstChild!.firstChild!;
  tree.updateInlineContent(paragraph.attrs.id, paragraph.type.create(paragraph.attrs, schema.text('A\t\nB')), 'human');
  assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
  return doc;
}

test('valid live structure remains editable while its Markdown roundtrip fails', () => {
  const doc = projectionFailureDocument();
  const reopened = new Y.Doc();
  try {
    const first = readAgentBlockStructure(doc)[0];
    assert.equal(validateAgentBlockDocument(doc), null);
    const saved = Y.encodeStateAsUpdate(doc);
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'move_block', blockId: first.id,
      placementHash: first.placementHash, parentId: null, beforeId: null }]);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), saved, 'preparing must remain read-only');
    const result = applyAgentBlockTargets({ doc, origin, validateClone: validateAgentBlockDocument, targets: [{
      kind: 'block_edit', targetId: 'move', groupId: 'move', startAnchor: '', endAnchor: '',
      baseTargetHash: first.placementHash, replacement: prepared.afterText, blockEdit: prepared, boundaryPolicy: 'exclude_external',
    }] });
    assert.equal(result.status, 'applied_to_ydoc', JSON.stringify(result));
    assert.equal(new CollaborationBlockTree(doc, schema).read().lastChild!.attrs.id, first.id);
    assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable', 'export validator must remain strict');
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(doc));
    assert.equal(validateAgentBlockDocument(reopened), null);
    applyAgentBlockEdit(reopened, result.reverseTargets[0].blockEdit!, origin);
    assert.equal(new CollaborationBlockTree(reopened, schema).read().firstChild!.attrs.id, first.id);
    const targets = createRichAgentTextTargets({ doc: reopened, search: 'Keep', replacement: 'Kept' });
    assert.equal(applyAgentTextTargets({ doc: reopened, targets, origin, validateClone: validateAgentBlockDocument }).status, 'applied_to_ydoc');
    assert.equal(validateRichMarkdownYDoc(reopened).code, 'roundtrip_unstable');
  } finally { doc.destroy(); reopened.destroy(); }
});

test('block admission rejects incompatible representation without modifying it', () => {
  const doc = createRichMarkdownYDoc('Legacy', 'tiptap_xml');
  try {
    const saved = Y.encodeStateAsUpdate(doc);
    assert.equal(validateAgentBlockDocument(doc), 'schema_invalid');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), saved);
  } finally { doc.destroy(); }
});

test('separating Markdown validation does not accept incompatible metadata types', () => {
  const doc = createRichMarkdownYDoc('Valid body', 'tiptap_blocks');
  try {
    doc.getMap('frontmatter').set('wrong', true);
    const saved = Y.encodeStateAsUpdate(doc);
    assert.equal(validateAgentBlockDocument(doc), 'schema_invalid');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), saved);
  } finally { doc.destroy(); }
});

test('a block-specific text edit does not match identical text in other blocks', () => {
  const doc = createRichMarkdownYDoc('Same\n\nSame', 'tiptap_blocks');
  try {
    const [first, second] = readAgentBlockStructure(doc);
    const targets = createRichAgentTextTargets({ doc, blockId: second.id, search: 'Same', replacement: 'Chosen' });
    assert.equal(targets.length, 1); assert.equal(targets[0].blockId, second.id);
    assert.equal(applyAgentTextTargets({ doc, targets, origin, validateClone: validateAgentBlockDocument }).status, 'applied_to_ydoc');
    const values = readAgentBlockStructure(doc);
    assert.equal(values.find((block) => block.id === first.id)?.text, 'Same');
    assert.equal(values.find((block) => block.id === second.id)?.text, 'Chosen');
    assert.throws(() => createRichAgentTextTargets({ doc, blockId: 'missing', search: 'Same', replacement: 'Wrong' }));
  } finally { doc.destroy(); }
});

test('structural target errors remain inspectable conflicts rather than retryable file failures', () => {
  const result = asAgentFileToolError(new AgentBlockEditError('target_changed'), 'edit_file', 'notes.md');
  assert.equal(result.category, 'safety_conflict');
  assert.equal(result.code, 'COLLABORATION_BLOCK_TARGET_CHANGED');
  assert.equal(result.recommendedAction, 'read_then_retry');
  assert.equal(result.safeToAutoRetry, false);
});
