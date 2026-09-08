import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { BLOCK_TREE_KEY, CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { applyAgentTextTargets, createRichAgentTextTargets } from '../app/lib/collaboration/agent-operations';
import { createRichMarkdownYDoc, richMarkdownFromYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { agentTargetDecorationPluginKey, createAgentTargetDecorationPlugin } from '../app/lib/collaboration/agent-target-decorations';

const schema = getSchema(richMarkdownSchemaExtensions());
const origin = { actorType: 'agent' as const, actorId: 'agent', initiatedByUserId: 'user', operationId: 'operation' };
const apply = (doc: Y.Doc, targets: Parameters<typeof applyAgentTextTargets>[0]['targets']) => applyAgentTextTargets({
  doc, targets, origin, validateClone: (clone) => validateRichMarkdownYDoc(clone).code ?? null,
});

test('prepared agent targets follow a moved block, including binary reopening and revert', () => {
  const doc = createRichMarkdownYDoc('AAA\n\nBBB\n\nCCC', 'tiptap_blocks');
  const reopened = new Y.Doc();
  try {
    const targets = createRichAgentTextTargets({ doc, search: 'BBB', replacement: 'NEW' });
    const tree = new CollaborationBlockTree(doc, schema);
    const id = tree.read().child(1).attrs.id as string;
    tree.move({ blockId: id, parentId: null, beforeId: null, operationId: 'move' }, 'user');
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(doc));
    const result = apply(reopened, targets);
    assert.equal(result.status, 'applied_to_ydoc', JSON.stringify(result.conflicts));
    assert.equal(richMarkdownFromYDoc(reopened), 'AAA\n\nCCC\n\nNEW');
    assert.equal(apply(reopened, result.reverseTargets).status, 'applied_to_ydoc');
    assert.equal(richMarkdownFromYDoc(reopened), 'AAA\n\nCCC\n\nBBB');
  } finally { doc.destroy(); reopened.destroy(); }
});

test('deleted block content remains recoverable but cannot receive an agent patch', () => {
  const doc = createRichMarkdownYDoc('AAA\n\nBBB\n\nCCC', 'tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc, schema);
    const id = tree.read().child(1).attrs.id as string;
    const targets = createRichAgentTextTargets({ doc, search: 'BBB', replacement: 'NEW' });
    tree.delete(id, 'delete', 'user');
    const saved = Y.encodeStateAsUpdate(doc);
    const result = apply(doc, targets);
    assert.equal(result.status, 'needs_review');
    assert.ok(result.conflicts.some((conflict) => conflict.code === 'target_changed'));
    assert.equal(tree.content(id).toString(), 'BBB');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), saved);
    assert.throws(() => createRichAgentTextTargets({ doc, search: 'BBB', replacement: 'NEW' }));
  } finally { doc.destroy(); }
});

test('duplicate visible text requires an explicit occurrence count and preserves separate identities', () => {
  const doc = createRichMarkdownYDoc('Same\n\nSame', 'tiptap_blocks');
  try {
    assert.throws(() => createRichAgentTextTargets({ doc, search: 'Same', replacement: 'Changed' }));
    const targets = createRichAgentTextTargets({ doc, search: 'Same', replacement: 'Changed', expectedOccurrences: 2 });
    assert.equal(targets.length, 2);
    assert.notEqual(targets[0].startAnchor, targets[1].startAnchor);
    assert.equal(apply(doc, targets).status, 'applied_to_ydoc');
    assert.equal(richMarkdownFromYDoc(doc), 'Changed\n\nChanged');
  } finally { doc.destroy(); }
});

test('prepared targets on transferred split and join text require review instead of borrowing a new identity', () => {
  const doc = createRichMarkdownYDoc('AlphaBeta\n\nKeep', 'tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc, schema);
    const before = tree.read();
    const originalTarget = createRichAgentTextTargets({ doc, search: 'Beta', replacement: 'Changed' });
    const alpha = before.firstChild!.type.create(before.firstChild!.attrs, schema.text('Alpha'));
    const beta = schema.nodes.paragraph.create({ id: 'split-beta' }, schema.text('Beta'));
    tree.applyDocumentChange(before, schema.topNodeType.create(null, [alpha, beta, before.child(1)]), 'user');
    const splitState = Y.encodeStateAsUpdate(doc);
    assert.equal(apply(doc, originalTarget).status, 'needs_review');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), splitState);
    const betaTarget = createRichAgentTextTargets({ doc, search: 'Beta', replacement: 'Changed' });
    const split = tree.read();
    const joined = alpha.type.create(alpha.attrs, schema.text('AlphaBeta'));
    tree.applyDocumentChange(split, schema.topNodeType.create(null, [joined, split.child(2)]), 'user');
    const joinedState = Y.encodeStateAsUpdate(doc);
    assert.equal(apply(doc, betaTarget).status, 'needs_review');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), joinedState);
    assert.equal(richMarkdownFromYDoc(doc), 'AlphaBeta\n\nKeep');
  } finally { doc.destroy(); }
});

test('frontmatter and marked Unicode text remain addressable in the block format', () => {
  const doc = createRichMarkdownYDoc('---\ntitle: Original\n---\n\n**Grüße 👋**\n\nKeep', 'tiptap_blocks');
  try {
    assert.equal(apply(doc, createRichAgentTextTargets({ doc, search: 'Original', replacement: 'Updated' })).status, 'applied_to_ydoc');
    assert.equal(apply(doc, createRichAgentTextTargets({ doc, search: 'Grüße 👋', replacement: 'Danke 🌍' })).status, 'applied_to_ydoc');
    assert.equal(richMarkdownFromYDoc(doc), '---\ntitle: Updated\n---\n\n**Danke 🌍**\n\nKeep');
  } finally { doc.destroy(); }
});

test('review highlights follow the same moved identity and disappear after deletion', () => {
  const doc = createRichMarkdownYDoc('AAA\n\nBBB\n\nCCC', 'tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc, schema);
    const id = tree.read().child(1).attrs.id as string;
    const target = { ...createRichAgentTextTargets({ doc, search: 'BBB', replacement: 'NEW' })[0], operationId: 'review' };
    let state = EditorState.create({ doc: tree.read(), plugins: [createAgentTargetDecorationPlugin(doc)] });
    state = state.apply(state.tr.setMeta(agentTargetDecorationPluginKey, [target]));
    const ranges = () => agentTargetDecorationPluginKey.getState(state)!.decorations.find().map(({ from, to }) => [from, to]);
    assert.deepEqual(ranges(), [[6, 9]]);
    tree.move({ blockId: id, parentId: null, beforeId: null, operationId: 'move' }, 'user');
    state = state.apply(state.tr.replaceWith(0, state.doc.content.size, tree.read().content));
    assert.deepEqual(ranges(), [[11, 14]]);
    state = state.apply(state.tr.setMeta(agentTargetDecorationPluginKey, [{ ...target, blockId: tree.read().firstChild!.attrs.id }]));
    assert.deepEqual(ranges(), [], 'a different block ID cannot borrow a valid relative anchor');
    state = state.apply(state.tr.setMeta(agentTargetDecorationPluginKey, [target]));
    tree.delete(id, 'delete', 'user');
    state = state.apply(state.tr.replaceWith(0, state.doc.content.size, tree.read().content));
    assert.deepEqual(ranges(), []);
    assert.equal(doc.share.has('body'), false, 'rendering review highlights never creates a legacy writer');
    doc.getMap(BLOCK_TREE_KEY).set('version', 99);
    state = state.apply(state.tr.setMeta(agentTargetDecorationPluginKey, [target]));
    assert.deepEqual(ranges(), [], 'recovery-state rendering must not crash on an unsupported format');
  } finally { doc.destroy(); }
});
