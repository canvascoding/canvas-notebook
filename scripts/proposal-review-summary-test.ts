import 'server-only';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProposalGraphContractError, PROPOSAL_GRAPH_ERROR_CODES as Codes, PROPOSAL_GRAPH_LIMITS } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { parseProposalReviewSummaryRequestV1, parseProposalReviewSummaryResponseV1,
  type ProposalReviewSummaryRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-summary-v1';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import { readProposalReviewSummary } from '../app/lib/file-version-center/proposal-review-summary';
import type { FileVersionCenterAccess, ResolvedFileVersionTarget } from '../app/lib/file-version-center/query-service';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { currentProofFixture, proposalScopeFixture, rootProposalFixture } from './fixtures/proposal-graph-contract-v1';

const target: ResolvedFileVersionTarget = {
  workspaceId: proposalScopeFixture.workspaceId, lineageId: proposalScopeFixture.lineageId,
  documentId: proposalScopeFixture.documentId, path: 'summary-secret-path.md', latestRevisionId: null,
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
const requestTarget = { kind: 'document' as const, workspaceId: target.workspaceId, documentId: target.documentId! };
const makeRequest = (operationIds: string[]): ProposalReviewSummaryRequestV1 => ({
  contractVersion: 1, target: requestTarget, operationIds,
});

type Row = { operation_id: string; proposal_id: string | null };
type CapturedQuery = { sql: string; values: unknown[] };

function fakeDatabase(rowsByOperation: Record<string, Row[]>, captured: CapturedQuery[] = []): FileVersionCenterDatabase {
  return { transaction: async (action) => action({ query: async (sql: string, values: unknown[] = []) => {
    captured.push({ sql, values });
    const operationId = values[5];
    return { rows: typeof operationId === 'string' ? rowsByOperation[operationId] ?? [] : [] };
  } } as never) };
}

function proposal(operationId: string, proposalId: string) {
  return {
    proposalId, operationId, rootProposalId: proposalId, parentProposalId: null,
    relation: 'root' as const, relationships: rootProposalFixture.relationships, lifecycle: 'open' as const,
    createdAt: 1_800_000_000_000, createdByActorId: 'reviewer',
  };
}

function operationForProposalId(proposalId: string): string {
  return proposalId.startsWith('proposal-') ? `operation-${proposalId.slice('proposal-'.length)}` : `operation-${proposalId}`;
}

function evaluation(proposalId: string, changes: Record<string, unknown> = {}) {
  return {
    status: 'clean', reasonCode: null, current: currentProofFixture, graphRevision: 7,
    selectedProposalIds: [proposalId], dependencyProposalIds: [], applyProposalIds: [proposalId],
    prerequisiteProposalIds: [], closureProposalIds: [proposalId], selectionHash: 'a'.repeat(64),
    actionability: 'accept', evaluation: { evaluationId: `evaluation-${proposalId}` },
    candidateContent: 'PRIVATE CANDIDATE CONTENT MUST NOT LEAK', candidateProof: currentProofFixture,
    appliedProposalIds: [proposalId], satisfiedProposalIds: [], ...changes,
  };
}

function createReview(input: {
  onEvaluate?: (proposalId: string, index: number) => Record<string, unknown>;
  onContext?: (selectedProposalIds: readonly string[], expectedGraphRevision: number) => unknown;
}) {
  const evaluated: string[][] = [];
  const contexts: Array<{ selectedProposalIds: string[]; expectedGraphRevision: number }> = [];
  let creates = 0;
  const service = {
    evaluateSelection: async ({ selectedProposalIds }: { selectedProposalIds: readonly string[] }) => {
      const ids = [...selectedProposalIds];
      evaluated.push(ids);
      const proposalId = ids[0]!;
      return input.onEvaluate?.(proposalId, evaluated.length - 1) ?? evaluation(proposalId);
    },
    readContext: async ({ selectedProposalIds, expectedGraphRevision }: {
      selectedProposalIds: readonly string[]; expectedGraphRevision: number;
    }) => {
      const ids = [...selectedProposalIds];
      contexts.push({ selectedProposalIds: ids, expectedGraphRevision });
      return input.onContext?.(ids, expectedGraphRevision) ?? {
        graphRevision: expectedGraphRevision, selectedProposalIds: ids, dependencyProposalIds: [],
        applyProposalIds: ids, closingAlternativeProposalIds: [], reasonCode: null,
        proposals: ids.map((id) => proposal(operationForProposalId(id), id)),
      };
    },
  };
  return {
    create: (async () => { creates += 1; return service; }) as never,
    service, evaluated, contexts, get createCalls() { return creates; },
  };
}

function graphRow(operationId: string, proposalId = `proposal-${operationId}`): Row[] {
  return [{ operation_id: operationId, proposal_id: proposalId }];
}

test('summary request and response contracts are strict and bounded', () => {
  const parsed = parseProposalReviewSummaryRequestV1(makeRequest(['operation-a', 'operation-b']));
  assert.deepEqual(parsed.operationIds, ['operation-a', 'operation-b']);
  assert.throws(() => parseProposalReviewSummaryRequestV1({ ...makeRequest([]), operationIds: [] }));
  assert.throws(() => parseProposalReviewSummaryRequestV1({ ...makeRequest(['operation-a', 'operation-a']) }));
  assert.throws(() => parseProposalReviewSummaryRequestV1(makeRequest(
    Array.from({ length: PROPOSAL_GRAPH_LIMITS.batchMembers + 1 }, (_, index) => `operation-${index}`),
  )));
  assert.throws(() => parseProposalReviewSummaryRequestV1({ ...makeRequest(['operation-a']), cursor: 'page-2' }));

  const valid = {
    contractVersion: 1, target: { workspaceId: target.workspaceId, lineageId: target.lineageId, documentId: target.documentId },
    current: currentProofFixture, graphRevision: 7, checkedAt: 1_800_000_000_000,
    items: [{ mode: 'graph', operationId: 'operation-a', proposal: proposal('operation-a', 'proposal-a'),
      status: 'clean', reasonCode: null }],
  };
  assert.deepEqual(parseProposalReviewSummaryResponseV1(valid), valid);
  assert.throws(() => parseProposalReviewSummaryResponseV1({ ...valid, unexpected: true }));
  assert.throws(() => parseProposalReviewSummaryResponseV1({ ...valid, items: [valid.items[0], valid.items[0]] }));
  assert.throws(() => parseProposalReviewSummaryResponseV1({ ...valid, items: [{ ...valid.items[0],
    proposal: proposal('different-operation', 'proposal-a') }] }));
  assert.throws(() => parseProposalReviewSummaryResponseV1({ ...valid, items: [{ ...valid.items[0],
    proposal: null, reasonCode: null }] }));
});

test('summary mixes authorized legacy and graph cards in exact requested order without compare/actions/content', async () => {
  const operationIds = ['legacy-operation', 'graph-operation'];
  const captured: CapturedQuery[] = [];
  const review = createReview({ onContext: (ids, graphRevision) => ({ graphRevision,
    selectedProposalIds: [...ids], dependencyProposalIds: [], applyProposalIds: [...ids], closingAlternativeProposalIds: [],
    reasonCode: null, proposals: ids.map((id) => proposal('graph-operation', id)),
  }) });
  const response = await readProposalReviewSummary({ request: makeRequest(operationIds), target, workspace, access,
    dependencies: { database: fakeDatabase({
      'legacy-operation': [{ operation_id: 'legacy-operation', proposal_id: null }],
      'graph-operation': graphRow('graph-operation', 'graph-proposal'),
    }, captured), createReview: review.create, now: () => 1_800_000_000_123 } });

  assert.deepEqual(response.items.map((item) => [item.mode, item.operationId]), [
    ['legacy', 'legacy-operation'], ['graph', 'graph-operation'],
  ]);
  assert.equal(response.items[1]?.mode, 'graph');
  if (response.items[1]?.mode === 'graph') {
    assert.equal(response.items[1].status, 'clean');
    assert.equal(response.items[1].proposal?.proposalId, 'graph-proposal');
  }
  assert.equal(response.checkedAt, 1_800_000_000_123);
  assert.equal(response.graphRevision, 7);
  assert.equal(response.current?.fullStateHash, currentProofFixture.fullStateHash);
  assert.equal(review.createCalls, 1);
  assert.deepEqual(review.evaluated, [['graph-proposal']]);
  assert.deepEqual(review.contexts, [{ selectedProposalIds: ['graph-proposal'], expectedGraphRevision: 7 }]);
  assert.equal(captured.length, 2);
  for (const query of captured) {
    assert.match(query.sql, /operation\.workspace_id=\$1/u);
    assert.match(query.sql, /document\.lineage_id=\$2/u);
    assert.match(query.sql, /document\.id=\$3/u);
    assert.match(query.sql, /operation\.initiated_by_user_id=\$4/u);
    assert.match(query.sql, /operation\.operation_id=\$6/u);
    assert.deepEqual(query.values.slice(0, 6), [target.workspaceId, target.lineageId, target.documentId,
      access.userId, false, query.values[5]]);
  }

  const json = JSON.stringify(response);
  assert.doesNotMatch(json, /PRIVATE CANDIDATE CONTENT MUST NOT LEAK|summary-secret-path|compare|actions|candidateContent|candidateProof/u);
  assert.deepEqual(Object.keys(response).sort(), ['checkedAt', 'contractVersion', 'current', 'graphRevision', 'items', 'target'].sort());
  assert.deepEqual(Object.keys(response.items[1]!).sort(), ['mode', 'operationId', 'proposal', 'reasonCode', 'status'].sort());
});

test('request authorization and database selection remain scoped to the resolved document and reviewer', async () => {
  let queryCalls = 0;
  const database: FileVersionCenterDatabase = { transaction: async (action) => action({ query: async () => {
    queryCalls += 1;
    return { rows: graphRow('foreign-operation') };
  } } as never) };
  await assert.rejects(readProposalReviewSummary({ request: makeRequest(['foreign-operation']), target, workspace,
    access: { ...access, authenticatedWorkspaceId: 'other-workspace' }, dependencies: { database } }),
  (error: unknown) => error instanceof ProposalGraphContractError && error.code === Codes.accessDenied);
  assert.equal(queryCalls, 0, 'authorization must precede database selection');

  const captured: CapturedQuery[] = [];
  await assert.rejects(readProposalReviewSummary({ request: makeRequest(['foreign-operation']), target, workspace, access,
    dependencies: { database: fakeDatabase({}, captured) } }),
  (error: unknown) => error instanceof ProposalGraphContractError && error.code === Codes.sourceInvalid);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]!.values.slice(0, 6), [target.workspaceId, target.lineageId, target.documentId,
    access.userId, false, 'foreign-operation']);
});

test('summary rejects graph generations that change between selected rows', async () => {
  const review = createReview({ onEvaluate: (proposalId, index) => evaluation(proposalId, { graphRevision: 7 + index }) });
  await assert.rejects(readProposalReviewSummary({ request: makeRequest(['operation-a', 'operation-b']), target, workspace, access,
    dependencies: { database: fakeDatabase({ 'operation-a': graphRow('operation-a', 'proposal-a'),
      'operation-b': graphRow('operation-b', 'proposal-b') }), createReview: review.create } }),
  (error: unknown) => error instanceof ProposalGraphContractError && error.code === Codes.graphChanged);
  assert.deepEqual(review.evaluated, [['proposal-a'], ['proposal-b']]);
  assert.equal(review.contexts.length, 1, 'a mismatched graph generation must fail before reading later context');
});

test('summary rejects document-current proof changes between selected rows', async () => {
  const secondCurrent = { ...currentProofFixture, fullStateHash: 'f'.repeat(64) };
  const review = createReview({ onEvaluate: (proposalId, index) => evaluation(proposalId,
    index === 0 ? {} : { current: secondCurrent }) });
  await assert.rejects(readProposalReviewSummary({ request: makeRequest(['operation-a', 'operation-b']), target, workspace, access,
    dependencies: { database: fakeDatabase({ 'operation-a': graphRow('operation-a', 'proposal-a'),
      'operation-b': graphRow('operation-b', 'proposal-b') }), createReview: review.create } }),
  (error: unknown) => error instanceof ProposalGraphContractError && error.code === Codes.currentChanged);
  assert.deepEqual(review.evaluated, [['proposal-a'], ['proposal-b']]);
});

test('missing or foreign context degrades to unavailable without exposing unrelated IDs', async () => {
  const cases = [
    { context: null, reasonCode: Codes.contentUnavailable },
    { context: {
      graphRevision: 7, selectedProposalIds: ['proposal-selected'], dependencyProposalIds: [], applyProposalIds: [],
      closingAlternativeProposalIds: [], reasonCode: Codes.accessDenied,
      proposals: [proposal('foreign-operation', 'foreign-proposal')],
    }, reasonCode: Codes.accessDenied },
  ];
  for (const item of cases) {
    const review = createReview({ onContext: () => item.context });
    const response = await readProposalReviewSummary({ request: makeRequest(['selected-operation']), target, workspace, access,
      dependencies: { database: fakeDatabase({ 'selected-operation': graphRow('selected-operation', 'proposal-selected') }),
        createReview: review.create, now: () => 9 } });
    assert.deepEqual(response.items, [{ mode: 'graph', operationId: 'selected-operation', proposal: null,
      status: 'unavailable', reasonCode: item.reasonCode }]);
    const responseText = JSON.stringify(response);
    assert.doesNotMatch(responseText, /foreign-operation|foreign-proposal/u);
  }
});

test('summary response preserves exact requested order, not database/context iteration order', async () => {
  const operationIds = ['operation-c', 'operation-a', 'operation-b'];
  const review = createReview({ onContext: (selected) => ({
    graphRevision: 7, selectedProposalIds: [...selected], dependencyProposalIds: [], applyProposalIds: [...selected],
    closingAlternativeProposalIds: [], reasonCode: null,
    proposals: [proposal('operation-b', 'proposal-b'), proposal('operation-c', 'proposal-c'), proposal('operation-a', 'proposal-a')],
  }) });
  const response = await readProposalReviewSummary({ request: makeRequest(operationIds), target, workspace, access,
    dependencies: { database: fakeDatabase({
      'operation-a': graphRow('operation-a', 'proposal-a'),
      'operation-b': graphRow('operation-b', 'proposal-b'),
      'operation-c': graphRow('operation-c', 'proposal-c'),
    }), createReview: review.create } });
  assert.deepEqual(response.items.map((item) => item.operationId), operationIds);
  assert.deepEqual(review.evaluated, [['proposal-c'], ['proposal-a'], ['proposal-b']]);
});
