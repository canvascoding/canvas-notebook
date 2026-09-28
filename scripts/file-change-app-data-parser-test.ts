import assert from 'node:assert/strict';

import {
  fileChangeAppStatusMessageKey,
  readFileChangeAppData,
  type FileChangeAppEntryState,
} from '../app/lib/tool-apps/file-change-data';
import en from '../messages/en.json';
import de from '../messages/de.json';

const entry = {
  id: 'entry-1', ordinal: 0, pathHint: 'docs/plan.md', state: 'review_required',
  operationId: 'operation-1', revisionId: null, additions: null, deletions: null,
};
const base = {
  contractVersion: 1, id: `fvcg-${'a'.repeat(64)}`, workspaceId: 'workspace-1',
  operation: 'edit_file', status: 'review_required', createdAt: '2026-09-26T10:00:00.000Z',
  entries: [entry],
};
const proposal = {
  contractVersion: 1, proposalId: 'proposal-1', rootProposalId: 'proposal-1',
  lineageId: 'lineage-1', graphRevision: 7, lifecycle: 'open', status: 'clean_rebased',
  successors: [
    { proposalId: 'proposal-2', operationId: 'operation-2', relation: 'extends', lifecycle: 'open' },
    { proposalId: 'proposal-3', operationId: 'operation-3', relation: 'replaces', lifecycle: 'superseded' },
  ],
  moreSuccessors: false,
};

assert.deepEqual(readFileChangeAppData(base), base, 'legacy payloads keep their exact shape');
const annotated = { ...base, entries: [{ ...entry, proposal }] };
assert.deepEqual(readFileChangeAppData(annotated), annotated,
  'an authorized annotation is additive and preserves the original operation and revision references');

const graphStates: FileChangeAppEntryState[] = [
  'included', 'alternative_not_selected', 'blocked_by_parent', 'satisfied_elsewhere', 'unavailable', 'expired',
];
for (const state of graphStates) {
  assert.equal(readFileChangeAppData({ ...annotated, status: state, entries: [{ ...entry, state, proposal }] })?.status, state,
    `${state} is a valid explicit current state`);
}
assert.equal(fileChangeAppStatusMessageKey('superseded'), 'fileChangeStatus_superseded',
  'legacy revision supersession retains its existing label');
assert.equal(fileChangeAppStatusMessageKey('superseded', true), 'fileChangeStatus_graph_superseded',
  'graph supersession has a proposal-specific label');
for (const messages of [en, de]) {
  const labels = messages.chat.toolApp as Record<string, string>;
  for (const state of [...graphStates, 'superseded'] as FileChangeAppEntryState[]) {
    assert.ok(labels[fileChangeAppStatusMessageKey(state, true)], `graph state ${state} has a translation`);
  }
  for (const lifecycle of ['open', 'applied', 'included', 'rejected', 'superseded',
    'alternative_not_selected', 'satisfied_elsewhere', 'expired']) {
    assert.ok(labels[`fileChangeProposalLifecycle_${lifecycle}`], `${lifecycle} has a lifecycle label`);
  }
  for (const status of ['rebase_pending', 'clean', 'clean_rebased', 'blocked_by_parent',
    'prerequisite_lost', 'conflicted', 'stale_lifecycle', 'unavailable', 'satisfied_elsewhere', 'empty_effect']) {
    assert.ok(labels[`fileChangeProposalStatus_${status}`], `${status} has an evaluation label`);
  }
  for (const relation of ['extends', 'replaces']) {
    assert.ok(labels[`fileChangeSuccessorRelation_${relation}`], `${relation} has a relation label`);
  }
}

const malformed = [
  { ...annotated, extra: true },
  { ...base, entries: [{ ...entry, extra: true }] },
  { ...base, entries: [{ ...entry, proposal: null }] },
  { ...base, entries: [{ ...entry, operationId: null, proposal }] },
  { ...base, entries: [{ ...entry, proposal: { ...proposal, extra: true } }] },
  { ...base, entries: [{ ...entry, proposal: { ...proposal, proposalId: '../foreign' } }] },
  { ...base, entries: [{ ...entry, proposal: { ...proposal, rootProposalId: '' } }] },
  { ...base, entries: [{ ...entry, proposal: { ...proposal, lineageId: 'foreign/lineage' } }] },
  { ...base, entries: [{ ...entry, proposal: { ...proposal, graphRevision: -1 } }] },
  { ...base, entries: [{ ...entry, proposal: { ...proposal, status: 'approve_now' } }] },
  { ...base, entries: [{ ...entry, proposal: { ...proposal, successors: [
    proposal.successors[0], { ...proposal.successors[1], proposalId: proposal.successors[0].proposalId },
  ] } }] },
  { ...base, entries: [{ ...entry, proposal: { ...proposal, successors: [
    proposal.successors[0], { ...proposal.successors[1], operationId: proposal.successors[0].operationId },
  ] } }] },
  { ...base, entries: [{ ...entry, proposal: { ...proposal, successors: [
    { ...proposal.successors[0], relation: 'automatic_choice' },
  ] } }] },
  { ...base, entries: [{ ...entry, proposal: { ...proposal, successors: [
    { ...proposal.successors[0], hidden: true },
  ] } }] },
];
for (const [index, value] of malformed.entries()) {
  assert.equal(readFileChangeAppData(value), null, `forged annotation ${index} is rejected`);
}

console.log('File-change app proposal annotation parser and legacy compatibility passed.');
