import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError,
  type ProposalGraphSnapshotV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { FileVersionCenterDatabase, FileVersionCenterTransaction } from '../app/lib/file-version-center/database';
import { createRuntimeProposalReviewService } from '../app/lib/file-version-center/proposal-review-runtime';
import type { ProposalGraphStorageTransaction } from '../app/lib/file-version-center/proposal-storage';
import type { FileVersionCenterAccess, ResolvedFileVersionTarget } from '../app/lib/file-version-center/query-service';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { alternativeChildFixture, childProposalFixture, independentProposalFixture,
  proposalScopeFixture, rootProposalFixture } from './fixtures/proposal-graph-contract-v1';

const target: ResolvedFileVersionTarget = { workspaceId: proposalScopeFixture.workspaceId,
  lineageId: proposalScopeFixture.lineageId, documentId: proposalScopeFixture.documentId, path: 'review.md',
  latestRevisionId: null, latestRevisionHash: null, latestRevisionSize: 0 };
const workspace: WorkspaceContext = { workspaceId: target.workspaceId, workspaceType: 'team', rootPath: '/unused',
  organizationId: 'org-review', legacy: false, permissions: { canRead: true, canWrite: false, canDelete: false,
    canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false } };
const access: FileVersionCenterAccess = { userId: 'reviewer', authenticatedWorkspaceId: target.workspaceId,
  requestedWorkspaceId: target.workspaceId, membership: 'active', permissionsResolved: true, canRead: true,
  canWrite: false, canManageWorkspace: false };
const state: PersistedCollaborationState = { documentId: target.documentId!, workspaceId: target.workspaceId,
  organizationId: 'org-review', path: target.path, representation: 'plain_text', lifecycleGeneration: 1,
  schemaVersion: 1, yjsState: new Uint8Array(), stateVector: new Uint8Array(), documentSequence: 4,
  persistedAt: 1, checkpointedAt: null, checkpointSequence: 0, canonicalHash: null, serializedHash: null,
  newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };

function graph(nodes: ProposalGraphSnapshotV1['nodes'], choice = true): ProposalGraphSnapshotV1 {
  return { contractVersion: 1, scope: proposalScopeFixture, graphRevision: 3, nodes,
    choiceGroups: choice ? [{ groupId: 'choice-insurance', groupRevision: 1,
      dependencyProposalId: 'p1', memberProposalIds: ['p2', 'p3'], chosenProposalId: null }] : [] };
}

async function review(snapshot: ProposalGraphSnapshotV1, ownerById: Record<string, string> = {}) {
  const sql: FileVersionCenterTransaction = { query: async <Row>(statement: string, parameters: unknown[] = []) => {
    if (statement.includes('SELECT id FROM file_collaboration_lineages')) return { rows: [{ id: target.lineageId }] as Row[] };
    if (statement.includes('SELECT document_id FROM collaboration_yjs_states')) return { rows: [{ document_id: target.documentId }] as Row[] };
    if (statement.includes('FROM collaboration_documents')) return { rows: [{
      lineage_id: target.lineageId, document_workspace_id: target.workspaceId, document_path: target.path,
      document_status: 'active', provider: 'yjs', lineage_workspace_id: target.workspaceId,
      lineage_path: target.path, lineage_status: 'active', workspace_id: target.workspaceId,
      organization_id: 'org-review', path: target.path, representation: 'plain_text', lifecycle_generation: 1,
      schema_version: 1, document_sequence: 4, status: 'active', degraded: false,
    }] as Row[] };
    if (statement.includes('FROM file_change_proposals proposal')) {
      const ids = parameters[5] as string[];
      return { rows: ids.map((id) => ({ proposal_id: id, initiated_by_user_id: ownerById[id] ?? 'reviewer' })) as Row[] };
    }
    throw new Error(`Unexpected SQL: ${statement.slice(0, 70)}`);
  } };
  const database = { transaction: async <T>(action: (tx: FileVersionCenterTransaction) => Promise<T>) => action(sql) } as FileVersionCenterDatabase;
  const storage = { withLockedGraph: async <T>(_scope: unknown, _options: unknown,
    action: (transaction: ProposalGraphStorageTransaction, tx: FileVersionCenterTransaction) => Promise<T>) =>
    action({ loadGraph: async () => snapshot } as ProposalGraphStorageTransaction, sql) };
  return createRuntimeProposalReviewService({ target, workspace, access, dependencies: {
    database, storage, loadState: async () => state,
  } });
}

test('context projects authorized dependency hierarchy and alternative closure without candidate content', async () => {
  const runtime = await review(graph([rootProposalFixture, childProposalFixture, alternativeChildFixture] as ProposalGraphSnapshotV1['nodes']));
  const context = await runtime.readContext({ selectedProposalIds: ['p2'], expectedGraphRevision: 3 });
  assert.deepEqual(context.scope, proposalScopeFixture);
  assert.equal(context.reasonCode, null);
  assert.deepEqual(context.selectedProposalIds, ['p2']);
  assert.deepEqual(context.dependencyProposalIds, ['p1']);
  assert.deepEqual(context.applyProposalIds, ['p1', 'p2']);
  assert.deepEqual(context.closingAlternativeProposalIds, ['p3']);
  assert.deepEqual(context.proposals.map((node) => node.proposalId), ['p1', 'p2', 'p3']);
  assert.equal(context.proposals[1]?.parentProposalId, 'p1');
  assert.equal(JSON.stringify(context).includes('increment-p2'), false);
});

test('an applied exact root remains the anchor while its open children require explicit selection', async () => {
  const appliedRoot = { ...rootProposalFixture, lifecycle: 'applied' as const };
  const snapshot = graph([appliedRoot, childProposalFixture, alternativeChildFixture] as ProposalGraphSnapshotV1['nodes']);
  const runtime = await review(snapshot);

  const rootContext = await runtime.readContext({ selectedProposalIds: ['p1'], expectedGraphRevision: 3 });
  assert.deepEqual(rootContext.scope, proposalScopeFixture);
  assert.deepEqual(rootContext.selectedProposalIds, ['p1']);
  assert.equal(rootContext.reasonCode, Codes.invalidTransition);
  assert.deepEqual(rootContext.applyProposalIds, []);
  assert.deepEqual(rootContext.proposals.map((node) => [node.proposalId, node.rootProposalId, node.lifecycle]), [
    ['p1', 'p1', 'applied'], ['p2', 'p1', 'open'], ['p3', 'p1', 'open'],
  ]);
  assert.equal(rootContext.proposals[0]?.operationId, 'operation-p1');

  for (const childId of ['p2', 'p3']) {
    const selectedChild = await runtime.readContext({ selectedProposalIds: [childId], expectedGraphRevision: 3 });
    assert.deepEqual(selectedChild.selectedProposalIds, [childId]);
    assert.equal(selectedChild.reasonCode, null);
    assert.deepEqual(selectedChild.dependencyProposalIds, ['p1']);
    assert.deepEqual(selectedChild.applyProposalIds, [childId]);
    assert.deepEqual(new Set(selectedChild.proposals.map((node) => node.proposalId)), new Set(['p1', 'p2', 'p3']));
  }
  assert.equal(snapshot.graphRevision, 3);
  assert.equal(snapshot.nodes[0]?.lifecycle, 'applied');
  assert.equal(snapshot.nodes[1]?.lifecycle, 'open');
  assert.equal(snapshot.nodes[2]?.lifecycle, 'open');
});

test('foreign alternative is not exposed in context or effect IDs', async () => {
  const runtime = await review(graph([rootProposalFixture, childProposalFixture, alternativeChildFixture] as ProposalGraphSnapshotV1['nodes']),
    { p3: 'other-user' });
  const context = await runtime.readContext({ selectedProposalIds: ['p2'], expectedGraphRevision: 3 });
  assert.deepEqual(context.scope, proposalScopeFixture);
  assert.deepEqual(context.proposals, []);
  assert.deepEqual(context.closingAlternativeProposalIds, []);
  assert.equal(context.reasonCode, Codes.accessDenied);
});

test('conflicting alternative selection shows authorized nodes without claiming apply effects', async () => {
  const runtime = await review(graph([rootProposalFixture, childProposalFixture, alternativeChildFixture] as ProposalGraphSnapshotV1['nodes']));
  const context = await runtime.readContext({ selectedProposalIds: ['p2', 'p3'], expectedGraphRevision: 3 });
  assert.equal(context.reasonCode, Codes.choiceConflict);
  assert.deepEqual(context.applyProposalIds, []);
  assert.deepEqual(context.closingAlternativeProposalIds, []);
  assert.deepEqual(context.proposals.map((node) => node.proposalId), ['p1', 'p2', 'p3']);
});

test('independent selected roots each project without single-root scope mismatch', async () => {
  const runtime = await review(graph([rootProposalFixture, independentProposalFixture] as ProposalGraphSnapshotV1['nodes'], false));
  const context = await runtime.readContext({ selectedProposalIds: ['p1', 'q'], expectedGraphRevision: 3 });
  assert.equal(context.reasonCode, null);
  assert.deepEqual(context.proposals.map((node) => node.rootProposalId), ['p1', 'q']);
  assert.deepEqual(context.applyProposalIds, ['p1', 'q']);
});

test('an independent replacement exposes its authorized predecessor without treating it as an apply dependency', async () => {
  const original = { ...independentProposalFixture, lifecycle: 'superseded' as const };
  const replacement = { ...independentProposalFixture, proposalId: 'replacement', operationId: 'op-replacement',
    createdAt: original.createdAt + 1, relationships: { ...original.relationships, replacesProposalId: original.proposalId } };
  const runtime = await review(graph([original, replacement] as ProposalGraphSnapshotV1['nodes'], false));
  const context = await runtime.readContext({ selectedProposalIds: ['replacement'], expectedGraphRevision: 3 });
  assert.equal(context.reasonCode, null);
  assert.deepEqual(new Set(context.proposals.map((node) => node.proposalId)), new Set(['replacement', original.proposalId]));
  assert.equal(context.proposals.find((node) => node.proposalId === 'replacement')?.relation, 'replacement');
  assert.deepEqual(context.dependencyProposalIds, []);
  assert.deepEqual(context.applyProposalIds, ['replacement']);
});

test('independent alternatives are grouped only when every displayed root is authorized', async () => {
  const first = { ...independentProposalFixture, relationships: { ...independentProposalFixture.relationships,
    choiceGroupId: 'independent-choice' } };
  const second = { ...independentProposalFixture, proposalId: 'other-choice', operationId: 'op-other-choice',
    createdAt: first.createdAt + 1, relationships: { ...first.relationships } };
  const snapshot = { ...graph([first, second] as ProposalGraphSnapshotV1['nodes'], false),
    choiceGroups: [{ groupId: 'independent-choice', groupRevision: 1, dependencyProposalId: null,
      memberProposalIds: [first.proposalId, second.proposalId], chosenProposalId: null }] } as ProposalGraphSnapshotV1;
  const visible = await review(snapshot);
  const grouped = await visible.readContext({ selectedProposalIds: [first.proposalId], expectedGraphRevision: 3 });
  assert.equal(grouped.reasonCode, null);
  assert.deepEqual(new Set(grouped.proposals.map((node) => node.proposalId)), new Set([first.proposalId, second.proposalId]));
  assert.deepEqual(grouped.closingAlternativeProposalIds, [second.proposalId]);
  const hidden = await review(snapshot, { [second.proposalId]: 'other-user' });
  const denied = await hidden.readContext({ selectedProposalIds: [first.proposalId], expectedGraphRevision: 3 });
  assert.deepEqual(denied.proposals, []);
  assert.deepEqual(denied.closingAlternativeProposalIds, []);
  assert.equal(denied.reasonCode, Codes.accessDenied);
});

test('context refuses to mix a fresh graph with a stale evaluation revision', async () => {
  const runtime = await review(graph([rootProposalFixture] as ProposalGraphSnapshotV1['nodes'], false));
  await assert.rejects(runtime.readContext({ selectedProposalIds: ['p1'], expectedGraphRevision: 2 }),
    (error: unknown) => error instanceof ProposalGraphContractError && error.code === Codes.graphChanged);
});
