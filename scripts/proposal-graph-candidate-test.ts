import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import { Y } from '../app/lib/collaboration/server-runtime';
import type * as YTypes from 'yjs';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { readAgentBlockStructure } from '../app/lib/collaboration/agent-block-structure';
import { prepareAgentBlockEdit, type AgentBlockEditRequest } from '../app/lib/collaboration/agent-block-edits';
import { createAgentTextTarget, createRichAgentTextTargets, createRichMarkdownReviewTarget, type AgentTextTarget } from '../app/lib/collaboration/agent-operations';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions } from '../app/lib/collaboration/markdown-state';
import {
  authorProposalYjsCandidate, composeProposalYjsCandidate, proposalYjsCurrentProof,
  type AuthoredProposalYjsCandidate, type ProposalYjsCompositionEntry, type ProposalYjsRepresentation,
} from '../app/lib/file-version-center/proposal-yjs-candidate';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, PROPOSAL_GRAPH_LIMITS as Limits } from '../app/lib/file-version-center/contracts/proposal-graph-v1';

const schema = getSchema(richMarkdownSchemaExtensions());
const encode = (doc: YTypes.Doc) => Y.encodeStateAsUpdate(doc);
function reopen(update: Uint8Array): YTypes.Doc {
  const doc = new Y.Doc({ gc: false }); Y.applyUpdate(doc, update); return doc;
}
function edit(source: Uint8Array, search: string, replacement: string, representation: ProposalYjsRepresentation = 'plain_text'): AuthoredProposalYjsCandidate {
  const doc = reopen(source);
  try {
    const text = representation === 'plain_text' ? doc.getText('content') : null;
    const targets = representation === 'plain_text'
      ? [createAgentTextTarget({ text: text!, from: text!.toString().indexOf(search), to: text!.toString().indexOf(search) + search.length, replacement })]
      : createRichAgentTextTargets({ doc, search, replacement });
    return authorProposalYjsCandidate({ sourceUpdate: source, representation, targets });
  } finally { doc.destroy(); }
}
function entry(id: string, sourceUpdate: Uint8Array, artifacts: AuthoredProposalYjsCandidate, dependencyProposalId: string | null = null,
  mode: 'apply' | 'prerequisite' = 'apply'): ProposalYjsCompositionEntry {
  return { proposalId: id, sourceUpdate, artifacts, dependencyProposalId, mode };
}
function compose(currentUpdate: Uint8Array, ordered: ProposalYjsCompositionEntry[], representation: ProposalYjsRepresentation = 'plain_text') {
  return composeProposalYjsCandidate({ currentUpdate, ordered, representation, revisionId: 'rev-current' });
}
function good(result: ReturnType<typeof compose>, expected: string) {
  assert.ok('content' in result, JSON.stringify(result));
  assert.equal(result.content, expected); return result;
}
function blockEdit(source: Uint8Array, requests: (doc: YTypes.Doc) => AgentBlockEditRequest[]): AuthoredProposalYjsCandidate {
  const doc = reopen(source);
  try {
    const prepared = prepareAgentBlockEdit(doc, requests(doc));
    const target: AgentTextTarget = { kind: 'block_edit', targetId: 'block', groupId: 'block', startAnchor: '', endAnchor: '',
      baseTargetHash: '', replacement: prepared.afterText, blockEdit: prepared, boundaryPolicy: 'exclude_external' };
    return authorProposalYjsCandidate({ representation: 'tiptap_blocks', sourceUpdate: source, targets: [target] });
  } finally { doc.destroy(); }
}

test('stored deltas preserve child anchors across restart and do not mutate current input', () => {
  const doc = createPlainTextYDoc('Insurance: 50. Tail.');
  try {
    const v1 = encode(doc); const p1 = edit(v1, '50', '100'); const p2 = edit(p1.cumulativeCandidate, '100', '150');
    const result = good(compose(v1, [entry('p1', v1, p1), entry('p2', p1.cumulativeCandidate, p2, 'p1')]), 'Insurance: 150. Tail.');
    assert.equal(result.status, 'clean'); assert.deepEqual(result.appliedProposalIds, ['p1', 'p2']);
    assert.deepEqual(encode(doc), v1); assert.equal(doc.getText('content').toString(), 'Insurance: 50. Tail.');
    const reopened = reopen(result.candidateUpdate);
    try { assert.equal(reopened.getText('content').toString(), 'Insurance: 150. Tail.'); }
    finally { reopened.destroy(); }
  } finally { doc.destroy(); }
});

test('disjoint edits preserve manual current content in either independent proposal order', () => {
  const doc = createPlainTextYDoc('A=1 B=2 C=3');
  try {
    const base = encode(doc); const a = edit(base, 'A=1', 'A=10'); const b = edit(base, 'B=2', 'B=20');
    doc.getText('content').insert(doc.getText('content').length, ' user'); const current = encode(doc);
    for (const ordered of [[entry('a', base, a), entry('b', base, b)], [entry('b', base, b), entry('a', base, a)]]) {
      const result = good(compose(current, ordered), 'A=10 B=20 C=3 user'); assert.equal(result.status, 'clean_rebased');
    }
    assert.deepEqual(encode(doc), current);
  } finally { doc.destroy(); }
});

test('overlapping replacements, same-gap insertion and changed formats fail closed', () => {
  const doc = createPlainTextYDoc('AB');
  try {
    const base = encode(doc); const a = edit(base, 'A', 'one'); const b = edit(base, 'A', 'two');
    assert.equal(compose(base, [entry('a', base, a), entry('b', base, b)]).status, 'conflicted');
    const target = createAgentTextTarget({ text: doc.getText('content'), from: 1, to: 1, replacement: 'X' });
    const insert = authorProposalYjsCandidate({ representation: 'plain_text', sourceUpdate: base, targets: [target] });
    doc.getText('content').insert(1, 'Y');
    assert.equal(compose(encode(doc), [entry('insert', base, insert)]).status, 'conflicted');
    const restored = reopen(base);
    try { restored.getText('content').format(0, 1, { bold: true }); assert.equal(compose(encode(restored), [entry('a', base, a)]).status, 'conflicted'); }
    finally { restored.destroy(); }
  } finally { doc.destroy(); }
});

test('accepted P1=100 then P2=150 forms one net prerequisite for pending P3', () => {
  const doc = createPlainTextYDoc('Insurance 50. Keep.');
  try {
    const base = encode(doc); const p1 = edit(base, '50', '100'); const p2 = edit(p1.cumulativeCandidate, '100', '150');
    const p3 = edit(p2.cumulativeCandidate, 'Keep', 'Keep plus child');
    const ordered = [entry('p1', base, p1, null, 'prerequisite'), entry('p2', p1.cumulativeCandidate, p2, 'p1', 'prerequisite'),
      entry('p3', p2.cumulativeCandidate, p3, 'p2')];
    const current = reopen(p2.cumulativeCandidate);
    try {
      current.getText('content').insert(current.getText('content').length, ' user');
      const saved = encode(current);
      good(compose(saved, ordered), 'Insurance 150. Keep plus child. user');
      const index = current.getText('content').toString().indexOf('150'); current.getText('content').delete(index, 3); current.getText('content').insert(index, '100');
      assert.equal(compose(encode(current), ordered).status, 'prerequisite_lost', 'manual reversion must not replay accepted effects');
      current.getText('content').delete(index, 3); current.getText('content').insert(index, '150');
      assert.equal(compose(encode(current), ordered).status, 'prerequisite_lost', 'retyped equal-looking text does not recreate child identities');
    } finally { current.destroy(); }
  } finally { doc.destroy(); }
});

test('accepting parent first permits child later, but deleting accepted insertion blocks it', () => {
  const doc = createPlainTextYDoc('Base.');
  try {
    const base = encode(doc); const p1 = edit(base, 'Base', 'Base added'); const p2 = edit(p1.cumulativeCandidate, 'added', 'added child');
    const accepted = good(compose(base, [entry('p1', base, p1)]), 'Base added.');
    const entries = [entry('p1', base, p1, null, 'prerequisite'), entry('p2', p1.cumulativeCandidate, p2, 'p1')];
    good(compose(accepted.candidateUpdate, entries), 'Base added child.');
    const current = reopen(accepted.candidateUpdate);
    try { current.getText('content').delete(5, 5); assert.equal(compose(encode(current), entries).status, 'prerequisite_lost'); }
    finally { current.destroy(); }
  } finally { doc.destroy(); }
});

test('accepted deletion has an anchored absence witness and cannot be manually undone', () => {
  const doc = createPlainTextYDoc('A obsolete B tail');
  try {
    const base = encode(doc); const p1 = edit(base, 'obsolete ', ''); const p2 = edit(p1.cumulativeCandidate, 'tail', 'child');
    const entries = [entry('p1', base, p1, null, 'prerequisite'), entry('p2', p1.cumulativeCandidate, p2, 'p1')];
    good(compose(p1.cumulativeCandidate, entries), 'A B child');
    const current = reopen(p1.cumulativeCandidate);
    try { current.getText('content').insert(2, 'obsolete '); assert.equal(compose(encode(current), entries).status, 'prerequisite_lost'); }
    finally { current.destroy(); }
  } finally { doc.destroy(); }
});

for (const deletedEffect of [false, true]) {
  test(`independent branch snapshots cannot hide a manually ${deletedEffect ? 'undone deletion' : 'deleted insertion'}`, () => {
    const doc = createPlainTextYDoc('A old B tail');
    try {
      const base = encode(doc); const p1 = edit(base, 'old ', deletedEffect ? '' : 'added ');
      const p2 = edit(p1.cumulativeCandidate, 'tail', 'P-child');
      const manual = reopen(p1.cumulativeCandidate);
      try {
        if (deletedEffect) manual.getText('content').insert(2, 'old ');
        else manual.getText('content').delete(2, 6);
        const qSource = encode(manual); const q = edit(qSource, 'B', 'Q'); const qChild = edit(q.cumulativeCandidate, 'Q', 'Q-child');
        const result = compose(q.cumulativeCandidate, [entry('p1', base, p1, null, 'prerequisite'),
          entry('q', qSource, q, null, 'prerequisite'), entry('p2', p1.cumulativeCandidate, p2, 'p1'),
          entry('q-child', q.cumulativeCandidate, qChild, 'q')]);
        assert.equal(result.status, 'prerequisite_lost', JSON.stringify(result));
        assert.ok('proposalIds' in result && result.proposalIds.includes('p1'));
      } finally { manual.destroy(); }
    } finally { doc.destroy(); }
  });
}

test('independent same effect is metadata-only; its original-identity child stays blocked', () => {
  const doc = createPlainTextYDoc('A=1 Tail');
  try {
    const base = encode(doc); const first = edit(base, 'A=1', 'A=2'); const second = edit(base, 'A=1', 'A=2');
    const satisfied = good(compose(first.cumulativeCandidate, [entry('same', base, second)]), 'A=2 Tail');
    assert.equal(satisfied.status, 'satisfied_elsewhere'); assert.deepEqual(satisfied.appliedProposalIds, []);
    assert.deepEqual(satisfied.candidateUpdate, first.cumulativeCandidate);
    const child = edit(second.cumulativeCandidate, 'A=2', 'A=3');
    assert.equal(compose(first.cumulativeCandidate, [entry('same', base, second), entry('child', second.cumulativeCandidate, child, 'same')]).status, 'prerequisite_lost');
  } finally { doc.destroy(); }
});

test('empty net chain is distinct from a satisfied no-op and emits no acceptance recommendation', () => {
  const doc = createPlainTextYDoc('A');
  try {
    const base = encode(doc); const p1 = edit(base, 'A', 'B'); const p2 = edit(p1.cumulativeCandidate, 'B', 'A');
    assert.equal(good(compose(base, [entry('p1', base, p1), entry('p2', p1.cumulativeCandidate, p2, 'p1')]), 'A').status, 'empty_effect');
    assert.throws(() => edit(base, 'A', 'A'), (error: unknown) => (error as { code: string }).code === Codes.noEffect);
  } finally { doc.destroy(); }
});

for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation} preserves rich marks, frontmatter, Unicode and cumulative child edits`, () => {
    const doc = createRichMarkdownYDoc('---\ntitle: Original\n---\n\n**Grüße 👋**\n\nKeep', representation);
    try {
      const base = encode(doc); const p1 = edit(base, 'Original', 'Updated', representation); const p2 = edit(p1.cumulativeCandidate, 'Grüße', 'Danke', representation);
      const result = good(compose(base, [entry('p1', base, p1), entry('p2', p1.cumulativeCandidate, p2, 'p1')], representation),
        '---\ntitle: Updated\n---\n\n**Danke 👋**\n\nKeep');
      const p3 = edit(result.candidateUpdate, 'Keep', 'Kept', representation);
      good(compose(result.candidateUpdate, [entry('p1', base, p1, null, 'prerequisite'), entry('p2', p1.cumulativeCandidate, p2, 'p1', 'prerequisite'),
        entry('p3', result.candidateUpdate, p3, 'p2')], representation), '---\ntitle: Updated\n---\n\n**Danke 👋**\n\nKept');
    } finally { doc.destroy(); }
  });
}

test('new rich block identities survive restart and a child edit; deletion does not resurrect it', () => {
  const doc = createRichMarkdownYDoc('Keep', 'tiptap_blocks');
  try {
    const base = encode(doc); const p1 = blockEdit(base, () => [{ kind: 'insert_blocks', parentId: null, beforeId: null,
      blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Insurance 100' }] }] }]);
    const p2 = edit(p1.cumulativeCandidate, '100', '150', 'tiptap_blocks');
    const result = good(compose(base, [entry('p1', base, p1), entry('p2', p1.cumulativeCandidate, p2, 'p1')], 'tiptap_blocks'), 'Keep\n\nInsurance 150');
    const authored = reopen(p1.cumulativeCandidate); const applied = reopen(result.candidateUpdate);
    try {
      const insertedId = readAgentBlockStructure(authored).find((block) => block.text === 'Insurance 100')!.id;
      assert.equal(readAgentBlockStructure(applied).find((block) => block.text === 'Insurance 150')!.id, insertedId);
      const p3 = edit(p2.cumulativeCandidate, 'Keep', 'Kept', 'tiptap_blocks');
      const entries = [entry('p1', base, p1, null, 'prerequisite'), entry('p2', p1.cumulativeCandidate, p2, 'p1', 'prerequisite'), entry('p3', p2.cumulativeCandidate, p3, 'p2')];
      good(compose(result.candidateUpdate, entries, 'tiptap_blocks'), 'Kept\n\nInsurance 150');
      new CollaborationBlockTree(applied, schema).delete(insertedId, 'manual-delete', 'user');
      assert.equal(compose(encode(applied), entries, 'tiptap_blocks').status, 'prerequisite_lost');
    } finally { authored.destroy(); applied.destroy(); }
  } finally { doc.destroy(); }
});

test('rich block same-gap insertions and delete-versus-format conflict; disjoint move and text edits compose', () => {
  const doc = createRichMarkdownYDoc('# Heading\n\nA\n\nB', 'tiptap_blocks');
  try {
    const base = encode(doc);
    const insert = (text: string) => blockEdit(base, (scratch) => [{ kind: 'insert_blocks', parentId: null,
      beforeId: readAgentBlockStructure(scratch).find((block) => block.text === 'B')!.id,
      blocks: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }]);
    const left = insert('Left'); const right = insert('Right');
    assert.equal(compose(base, [entry('left', base, left), entry('right', base, right)], 'tiptap_blocks').status, 'conflicted');
    const deletion = blockEdit(base, (scratch) => {
      const heading = readAgentBlockStructure(scratch)[0]; return [{ kind: 'delete_block', blockId: heading.id, subtreeHash: heading.subtreeHash }];
    });
    const format = blockEdit(base, (scratch) => [{ kind: 'format_block', blockId: readAgentBlockStructure(scratch)[0].id,
      beforeAttrs: { level: 1 }, afterAttrs: { level: 2 } }]);
    for (const entries of [[entry('delete', base, deletion), entry('format', base, format)], [entry('format', base, format), entry('delete', base, deletion)]]) {
      assert.equal(compose(base, entries, 'tiptap_blocks').status, 'conflicted');
    }
    const move = blockEdit(base, (scratch) => {
      const a = readAgentBlockStructure(scratch).find((block) => block.text === 'A')!;
      return [{ kind: 'move_block', blockId: a.id, placementHash: a.placementHash, parentId: null, beforeId: null }];
    });
    const text = edit(base, 'Heading', 'Title', 'tiptap_blocks');
    good(compose(base, [entry('move', base, move), entry('text', base, text)], 'tiptap_blocks'), '# Title\n\nB\n\nA');
  } finally { doc.destroy(); }
});

test('legacy Markdown structural patches use their existing strict identity fence and stored new IDs', () => {
  const doc = createRichMarkdownYDoc('A\n\nB', 'tiptap_xml');
  try {
    const base = encode(doc); const target = createRichMarkdownReviewTarget({ doc, currentMarkdown: 'A\n\nB', proposedMarkdown: '# A\n\nB\n\nNew',
      edits: [{ oldText: 'A\n\nB', newText: '# A\n\nB\n\nNew', expectedOccurrences: 1 }] });
    const p1 = authorProposalYjsCandidate({ sourceUpdate: base, representation: 'tiptap_xml', targets: [target] });
    const p2 = edit(p1.cumulativeCandidate, 'New', 'Child', 'tiptap_xml');
    good(compose(base, [entry('p1', base, p1), entry('p2', p1.cumulativeCandidate, p2, 'p1')], 'tiptap_xml'), '# A\n\nB\n\nChild');
    const manual = edit(base, 'B', 'Manual', 'tiptap_xml');
    assert.equal(compose(manual.cumulativeCandidate, [entry('p1', base, p1)], 'tiptap_xml').status, 'conflicted');
    const changed = edit(p1.cumulativeCandidate, 'B', 'Unrelated', 'tiptap_xml');
    const unavailable = compose(changed.cumulativeCandidate, [entry('p1', base, p1, null, 'prerequisite'),
      entry('p2', p1.cumulativeCandidate, p2, 'p1')], 'tiptap_xml');
    assert.equal(unavailable.status, 'unavailable', 'legacy whole-document evidence does not justify reporting a lost scoped prerequisite');
    assert.ok('reasonCode' in unavailable && unavailable.reasonCode === Codes.upgradeRequired);
  } finally { doc.destroy(); }
});

test('current proof changes on deletion even when the state vector does not', () => {
  const doc = createPlainTextYDoc('ABC');
  try {
    const before = proposalYjsCurrentProof({ update: encode(doc), representation: 'plain_text', revisionId: 'r1' });
    doc.getText('content').delete(1, 1);
    const after = proposalYjsCurrentProof({ update: encode(doc), representation: 'plain_text', revisionId: 'r1' });
    assert.equal(before.stateVectorHash, after.stateVectorHash); assert.notEqual(before.deleteSetHash, after.deleteSetHash);
    assert.notEqual(before.contentHash, after.contentHash); assert.notEqual(before.fullStateHash, after.fullStateHash);
  } finally { doc.destroy(); }
});

test('pending structs, pending deletion sets, malformed artifacts, oversized bytes and bad order fail closed', () => {
  const doc = createPlainTextYDoc('AB');
  try {
    const base = encode(doc); const p1 = edit(base, 'A', 'X'); const pending = reopen(base);
    try {
      const vector = Y.encodeStateVector(pending); pending.getText('content').insert(1, 'N');
      const delta = Y.encodeStateAsUpdate(pending, vector);
      assert.throws(() => proposalYjsCurrentProof({ update: delta, representation: 'plain_text', revisionId: null }));
      pending.getText('content').delete(0, 1);
      const onlyDelete = Y.encodeStateAsUpdate(pending, Y.encodeStateVector(pending));
      assert.throws(() => proposalYjsCurrentProof({ update: onlyDelete, representation: 'plain_text', revisionId: null }));
    } finally { pending.destroy(); }
    assert.equal(compose(base, [entry('p1', base, p1, 'missing')]).status, 'unavailable');
    assert.equal(compose(base, [entry('p1', base, { ...p1, anchorMap: Buffer.from('{}') })]).status, 'unavailable');
    const oversized = compose(new Uint8Array(Limits.candidateBytes + 1), [entry('p1', base, p1)]);
    assert.ok('reasonCode' in oversized && oversized.reasonCode === Codes.limitExceeded);
    assert.equal(compose(base, [entry('p1', base, p1), entry('p1', base, p1)]).status, 'unavailable');
    assert.equal(compose(base, [entry('p1', base, { ...p1, effectPreconditions: Buffer.from('{"version":1,"introduced":[],"deleted":[]}') })]).status, 'unavailable');
  } finally { doc.destroy(); }
});
