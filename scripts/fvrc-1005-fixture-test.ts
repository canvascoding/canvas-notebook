import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';

import { composeProposalYjsCandidate, type ProposalYjsCompositionEntry } from '../app/lib/file-version-center/proposal-yjs-candidate';
import {
  author, BASE_TEXT, createBaseUpdate, oracleFor, PROPOSALS, PROPOSAL_IDS,
  type FixtureProposal,
} from './fixtures/fvrc-1005-proposals';

function content(update: Uint8Array): string {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, update);
  const value = doc.getText('content').toString();
  doc.destroy();
  return value;
}

function entry(proposal: FixtureProposal, sourceUpdate: Uint8Array, dependencyProposalId: string | null = null,
  mode: 'apply' | 'prerequisite' = 'apply'): ProposalYjsCompositionEntry {
  return { proposalId: proposal.id, dependencyProposalId, mode, sourceUpdate, artifacts: author(sourceUpdate, proposal) };
}

function compose(currentUpdate: Uint8Array, ordered: ProposalYjsCompositionEntry[]) {
  return composeProposalYjsCandidate({ currentUpdate, ordered, representation: 'plain_text', revisionId: 'fixture-rev' });
}

function successful(result: ReturnType<typeof compose>) {
  assert.ok('candidateUpdate' in result, JSON.stringify(result));
  return result;
}

test('MR-01: ten independent proposals remain applicable as 3 then 7 without losing content', () => {
  assert.equal(new Set(PROPOSAL_IDS).size, 10);
  const base = createBaseUpdate();
  const entries = PROPOSALS.map((proposal) => entry(proposal, base));
  const firstIds = ['p01', 'p04', 'p07'] as const;
  const remainingIds = PROPOSAL_IDS.filter((id) => !firstIds.includes(id as typeof firstIds[number]));
  const first = successful(compose(base, entries.filter((item) => firstIds.includes(item.proposalId as typeof firstIds[number]))));
  assert.equal(content(first.candidateUpdate), oracleFor(firstIds));

  let current = first.candidateUpdate;
  for (const id of remainingIds) {
    const result = successful(compose(current, [entries.find((item) => item.proposalId === id)!]));
    assert.ok(result.status === 'clean' || result.status === 'clean_rebased');
    current = result.candidateUpdate;
  }
  assert.equal(content(current), oracleFor(PROPOSAL_IDS));
  assert.equal(remainingIds.length, 7);
});

test('MR-01/MR-05: the remaining seven compose in deterministic orders after a foreign insertion', () => {
  const base = createBaseUpdate();
  const entries = PROPOSALS.map((proposal) => entry(proposal, base));
  const firstIds = ['p01', 'p04', 'p07'] as const;
  const first = successful(compose(base, entries.filter((item) => firstIds.includes(item.proposalId as typeof firstIds[number]))));
  const moved = new Y.Doc({ gc: false });
  Y.applyUpdate(moved, first.candidateUpdate);
  moved.getText('content').insert(0, 'USER|');
  const current = Y.encodeStateAsUpdate(moved);
  moved.destroy();
  const remaining = PROPOSAL_IDS.filter((id) => !firstIds.includes(id as typeof firstIds[number]));
  for (const order of [remaining, [...remaining].reverse(), [remaining[3], remaining[0], remaining[6], remaining[2], remaining[5], remaining[1], remaining[4]]]) {
    const result = successful(compose(current, order.map((id) => entries.find((item) => item.proposalId === id)!)));
    assert.equal(result.status, 'clean_rebased');
    assert.equal(content(result.candidateUpdate), `USER|${oracleFor(PROPOSAL_IDS)}`);
  }
});

test('MR-06/MR-07: disjoint edits compose while overlap and the same insertion gap fail closed', () => {
  const base = createBaseUpdate();
  const disjoint = successful(compose(base, [entry(PROPOSALS[0], base), entry(PROPOSALS[1], base)]));
  assert.equal(content(disjoint.candidateUpdate), oracleFor(['p01', 'p02']));

  const first: FixtureProposal = { id: 'overlap-a', from: 'A0', replacement: 'AX', parentId: null };
  const second: FixtureProposal = { id: 'overlap-b', from: 'A0', replacement: 'AY', parentId: null };
  assert.equal(compose(base, [entry(first, base), entry(second, base)]).status, 'conflicted');

  const gapA: FixtureProposal = { id: 'gap-a', from: '|B0', replacement: 'X|B0', parentId: null };
  const gapB: FixtureProposal = { id: 'gap-b', from: '|B0', replacement: 'Y|B0', parentId: null };
  assert.equal(compose(base, [entry(gapA, base), entry(gapB, base)]).status, 'conflicted');
});

test('MR-08: delete and text-identical recreation never satisfy the original Yjs identity', () => {
  const base = createBaseUpdate();
  const anchored: FixtureProposal = { id: 'anchored-c', from: 'C0', replacement: 'C1', parentId: null };
  const anchoredEntry = entry(anchored, base);
  const currentDoc = new Y.Doc({ gc: false });
  Y.applyUpdate(currentDoc, base);
  const text = currentDoc.getText('content');
  const index = text.toString().indexOf('C0');
  text.delete(index, 2);
  text.insert(index, 'C0');
  const current = Y.encodeStateAsUpdate(currentDoc);
  currentDoc.destroy();
  const result = compose(current, [anchoredEntry]);
  assert.ok(result.status === 'conflicted' || result.status === 'prerequisite_lost', result.status);
});

test('MR-09/MR-10: child closure includes an open parent once and detects a lost prerequisite', () => {
  const base = createBaseUpdate();
  const parent: FixtureProposal = { id: 'parent', from: 'A0', replacement: 'A1', parentId: null };
  const parentArtifacts = author(base, parent);
  const child: FixtureProposal = { id: 'child', from: 'B0', replacement: 'B1', parentId: 'parent' };
  const childArtifacts = author(parentArtifacts.cumulativeCandidate, child);
  const parentEntry: ProposalYjsCompositionEntry = { proposalId: 'parent', dependencyProposalId: null, mode: 'apply', sourceUpdate: base, artifacts: parentArtifacts };
  const childEntry: ProposalYjsCompositionEntry = { proposalId: 'child', dependencyProposalId: 'parent', mode: 'apply', sourceUpdate: parentArtifacts.cumulativeCandidate, artifacts: childArtifacts };
  const together = successful(compose(base, [parentEntry, childEntry]));
  assert.deepEqual(together.appliedProposalIds, ['parent', 'child']);
  assert.equal(content(together.candidateUpdate), BASE_TEXT.replace('A0', 'A1').replace('B0', 'B1'));

  const parentAccepted = successful(compose(base, [parentEntry]));
  const afterParent = successful(compose(parentAccepted.candidateUpdate, [{ ...parentEntry, mode: 'prerequisite' }, childEntry]));
  assert.deepEqual(afterParent.appliedProposalIds, ['child']);

  const reverted = new Y.Doc({ gc: false });
  Y.applyUpdate(reverted, parentAccepted.candidateUpdate);
  const text = reverted.getText('content');
  text.delete(0, 2);
  text.insert(0, 'A0');
  const lost = compose(Y.encodeStateAsUpdate(reverted), [{ ...parentEntry, mode: 'prerequisite' }, childEntry]);
  reverted.destroy();
  assert.ok(lost.status === 'prerequisite_lost' || lost.status === 'conflicted', lost.status);
});

console.log('fvrc-1005-fixture-test: ok');
