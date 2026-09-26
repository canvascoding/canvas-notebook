import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewSessionRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { readProposalReviewSession, selectProposalReviewSession } from '../app/lib/file-version-center/proposal-review-session';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import type { FileVersionCenterAccess, ResolvedFileVersionTarget } from '../app/lib/file-version-center/query-service';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { currentProofFixture, proposalScopeFixture, rootProposalFixture } from './fixtures/proposal-graph-contract-v1';

const target: ResolvedFileVersionTarget = {
  workspaceId: proposalScopeFixture.workspaceId, lineageId: proposalScopeFixture.lineageId,
  documentId: proposalScopeFixture.documentId, path: 'review.md', latestRevisionId: null,
  latestRevisionHash: null, latestRevisionSize: 0,
};
const workspace: WorkspaceContext = {
  workspaceId: target.workspaceId, workspaceType: 'team', rootPath: '/tmp', organizationId: 'org', legacy: false,
  actor: { userId: 'reviewer', role: 'member' } as WorkspaceContext['actor'],
  permissions: { canRead: true, canWrite: true, canDelete: false, canCreatePublicLinks: false,
    canManageWorkspace: false, canRunAgent: true },
};
const access: FileVersionCenterAccess = {
  userId: 'reviewer', authenticatedWorkspaceId: target.workspaceId, requestedWorkspaceId: target.workspaceId,
  membership: 'active', permissionsResolved: true, canRead: true, canWrite: true, canManageWorkspace: false,
};

function fakeDatabase(rows: Array<{ operation_id: string; proposal_id: string | null }>): FileVersionCenterDatabase {
  return { transaction: async (action) => action({ query: async () => ({ rows }) } as never) };
}

function cleanResult(selectedProposalIds: string[]) {
  return {
    status: 'clean', reasonCode: null, current: currentProofFixture, graphRevision: 7,
    selectedProposalIds, dependencyProposalIds: [], applyProposalIds: selectedProposalIds,
    prerequisiteProposalIds: [], closureProposalIds: selectedProposalIds, selectionHash: 'a'.repeat(64),
    actionability: 'accept', evaluation: { evaluationId: 'evaluation-1' },
    candidateContent: 'candidate', candidateProof: currentProofFixture, appliedProposalIds: selectedProposalIds,
    satisfiedProposalIds: [],
  };
}

const request = (selection: ProposalReviewSessionRequestV1['selection']): ProposalReviewSessionRequestV1 => ({
  contractVersion: 1, target: { kind: 'document', workspaceId: target.workspaceId, documentId: target.documentId! }, selection,
});

test('select all rejects more than the complete selection limit instead of silently taking a page-sized subset', async () => {
  const rows = Array.from({ length: 33 }, (_, index) => ({ operation_id: `op-${index}`, proposal_id: `p-${index}` }));
  await assert.rejects(selectProposalReviewSession({ selection: { kind: 'all' }, target, workspace, access,
    database: fakeDatabase(rows) }), (error: unknown) => error instanceof ProposalGraphContractError
      && error.code === Codes.limitExceeded && /no subset/u.test(error.message));
});

test('a mixed graph and legacy all-selection is rejected as a whole', async () => {
  await assert.rejects(selectProposalReviewSession({ selection: { kind: 'all' }, target, workspace, access,
    database: fakeDatabase([{ operation_id: 'graph-op', proposal_id: 'p1' }, { operation_id: 'legacy-op', proposal_id: null }]) }),
  (error: unknown) => error instanceof ProposalGraphContractError && error.code === Codes.legacyBlocked);
});

test('a foreign operation selection is rejected when it is outside the authorized document/owner query', async () => {
  await assert.rejects(selectProposalReviewSession({ selection: { kind: 'operation', operationId: 'foreign-op' }, target, workspace, access,
    database: fakeDatabase([]) }), (error: unknown) => error instanceof ProposalGraphContractError && error.code === Codes.sourceInvalid);
});

test('only an authorized single operation with no graph proposal may use the explicit legacy fallback', async () => {
  const selected = await selectProposalReviewSession({ selection: { kind: 'operation', operationId: 'legacy-op' }, target, workspace, access,
    database: fakeDatabase([{ operation_id: 'legacy-op', proposal_id: null }]) });
  assert.deepEqual(selected, { kind: 'legacy' });
});

function compare(status: string, selectedProposalIds: string[]) {
  return { contractVersion: 1, binding: { evaluationId: 'evaluation-1', selectionHash: 'a'.repeat(64),
    selectedProposalIds, current: currentProofFixture, graphRevision: 7 }, status,
  candidate: { contentAvailable: false, noEffect: false }, summary: { additions: 0, deletions: 0, unchanged: 0 },
  hunks: [], page: { hasMore: false, nextCursor: null },
  diagnosis: { availability: 'unavailable', reasonCode: Codes.batchConflict } } as const;
}

function context(selectedProposalIds: string[]) {
  return { graphRevision: 7, selectedProposalIds, dependencyProposalIds: [], applyProposalIds: selectedProposalIds,
    closingAlternativeProposalIds: [], reasonCode: null,
    proposals: selectedProposalIds.map(proposalId => ({ proposalId, operationId: `op-${proposalId}`, rootProposalId: proposalId,
      parentProposalId: null, relation: 'root', relationships: rootProposalFixture.relationships, lifecycle: 'open',
      createdAt: 1_800_000_000_000, createdByActorId: 'reviewer' })) };
}

function conflictedResult(selectedProposalIds: string[], withEvaluation: boolean) {
  return { ...cleanResult(selectedProposalIds), status: 'conflicted', reasonCode: Codes.batchConflict,
    actionability: 'none', evaluation: withEvaluation ? { evaluationId: 'evaluation-1' } : null,
    current: withEvaluation ? currentProofFixture : null, graphRevision: withEvaluation ? 7 : null,
    selectionHash: withEvaluation ? 'a'.repeat(64) : null };
}

test('a concrete conflicted evaluation and compare diagnosis survive session projection', async () => {
  const selectedProposalIds = ['p1'];
  const result = conflictedResult(selectedProposalIds, true);
  const session = await readProposalReviewSession({ request: request({ kind: 'proposals', proposalIds: selectedProposalIds }), target,
    workspace, access, dependencies: { database: fakeDatabase([]), writesEnabled: () => false,
      createReview: (async () => ({ evaluateSelection: async () => result, readContext: async () => context(selectedProposalIds),
        createCompareService: () => ({ compare: async () => compare('conflicted', selectedProposalIds) }) })) as never } });
  assert.equal(session.mode, 'graph');
  if (session.mode !== 'graph') return;
  assert.equal(session.status, 'conflicted');
  assert.equal(session.reasonCode, Codes.batchConflict);
  assert.equal(session.compare?.status, 'conflicted');
  assert.equal(session.compare?.diagnosis.reasonCode, Codes.batchConflict);
  assert.deepEqual(session.context?.selectedProposalIds, selectedProposalIds);
  assert.ok(session.compare?.binding, 'the stored evaluation remains bound even when the candidate cannot be compared');
});

test('a conflict with no evaluation binding retains its concrete reason instead of becoming a generic null result', async () => {
  const selectedProposalIds = ['p1'];
  const result = conflictedResult(selectedProposalIds, false);
  const session = await readProposalReviewSession({ request: request({ kind: 'proposals', proposalIds: selectedProposalIds }), target,
    workspace, access, dependencies: { database: fakeDatabase([]), writesEnabled: () => false,
      createReview: (async () => ({ evaluateSelection: async () => result,
        createCompareService: () => ({ compare: async () => { throw new Error('compare must not run without an evaluation binding'); } }) })) as never } });
  assert.equal(session.mode, 'graph');
  if (session.mode !== 'graph') return;
  assert.equal(session.status, 'conflicted');
  assert.equal(session.reasonCode, Codes.batchConflict);
  assert.equal(session.compare, null);
});

test('capability off keeps the session readable and never creates or calls an action service', async () => {
  const selectedProposalIds = ['p1'];
  const result = cleanResult(selectedProposalIds);
  let createActionCalls = 0;
  const session = await readProposalReviewSession({ request: request({ kind: 'proposals', proposalIds: selectedProposalIds }), target,
    workspace, access, dependencies: { database: fakeDatabase([]), writesEnabled: () => false,
      createReview: (async () => ({ evaluateSelection: async () => result, readContext: async () => context(selectedProposalIds),
        createCompareService: () => ({ compare: async () => ({ ...compare('clean', selectedProposalIds),
          candidate: { contentAvailable: true, noEffect: false }, diagnosis: { availability: 'available', reasonCode: null } }) }) })) as never,
      createActions: (async () => { createActionCalls++; throw new Error('writes disabled'); }) as never } });
  assert.equal(session.mode, 'graph');
  if (session.mode !== 'graph') return;
  assert.equal(session.capability.write, false);
  assert.deepEqual(session.actions, {});
  assert.equal(createActionCalls, 0);
});

test('inaccessible relationship details do not turn a valid selected comparison into a transport failure', async () => {
  const selectedProposalIds = ['p1'];
  const session = await readProposalReviewSession({ request: request({ kind: 'proposals', proposalIds: selectedProposalIds }),
    target, workspace, access, dependencies: { database: fakeDatabase([]), writesEnabled: () => false,
      createReview: (async () => ({ evaluateSelection: async () => cleanResult(selectedProposalIds),
        readContext: async () => ({ ...context(selectedProposalIds), proposals: [], applyProposalIds: [], reasonCode: Codes.accessDenied }),
        createCompareService: () => ({ compare: async () => ({ ...compare('clean', selectedProposalIds),
          candidate: { contentAvailable: true, noEffect: false }, diagnosis: { availability: 'available', reasonCode: null } }) }) })) as never } });
  assert.equal(session.mode, 'graph');
  if (session.mode !== 'graph') return;
  assert.equal(session.compare?.diagnosis.availability, 'available');
  assert.equal(session.context?.reasonCode, Codes.accessDenied);
  assert.deepEqual(session.context?.proposals, []);
});

test('graph context races request a fresh comparison instead of combining generations', async () => {
  await assert.rejects(readProposalReviewSession({ request: request({ kind: 'proposals', proposalIds: ['p1'] }),
    target, workspace, access, dependencies: { database: fakeDatabase([]), writesEnabled: () => false,
      createReview: (async () => ({ evaluateSelection: async () => cleanResult(['p1']),
        readContext: async () => { throw new ProposalGraphContractError(Codes.graphChanged, 'changed'); },
        createCompareService: () => ({ compare: async () => compare('clean', ['p1']) }) })) as never } }),
  (error: unknown) => error instanceof ProposalGraphContractError && error.code === Codes.graphChanged);
});

test('historical terminal proposals remain readable without preparing new actions', async () => {
  const selectedProposalIds = ['p1'];
  const historical = context(selectedProposalIds);
  historical.proposals[0]!.lifecycle = 'superseded';
  let createActionCalls = 0;
  const session = await readProposalReviewSession({ request: request({ kind: 'proposals', proposalIds: selectedProposalIds }),
    target, workspace, access, dependencies: { database: fakeDatabase([]), writesEnabled: () => true,
      createReview: (async () => ({ evaluateSelection: async () => conflictedResult(selectedProposalIds, true),
        readContext: async () => historical,
        createCompareService: () => ({ compare: async () => compare('conflicted', selectedProposalIds) }) })) as never,
      createActions: (async () => { createActionCalls++; throw new Error('terminal proposals cannot be rejected again'); }) as never } });
  assert.equal(session.mode, 'graph');
  if (session.mode !== 'graph') return;
  assert.equal(session.context?.proposals[0]?.lifecycle, 'superseded');
  assert.deepEqual(session.actions, {});
  assert.equal(createActionCalls, 0);
});
