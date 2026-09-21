import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FileVersionCenterDatabase, FileVersionCenterTransaction } from '../app/lib/file-version-center/database';
import type { ProposalGraphSnapshotV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { readProposalReviewProjection } from '../app/lib/file-version-center/proposal-review-read-service';
import { rootProposalFixture } from './fixtures/proposal-graph-contract-v1';

const workspaceData = { workspaceId: 'ws-1', organizationId: 'org-1', permissions: { canRead: true, canWrite: false,
  canManageWorkspace: false }, legacy: false };
const workspace = workspaceData as never;
const target = { workspaceId: 'ws-1', lineageId: 'lin-1', documentId: 'doc-1', path: 'note.md',
  latestRevisionId: null, latestRevisionHash: null, latestRevisionSize: 0 };
const accessData = { userId: 'user-1', authenticatedWorkspaceId: 'ws-1', requestedWorkspaceId: 'ws-1', membership: 'active',
  permissionsResolved: true, canRead: true, canWrite: false, canRunAgent: false, canManageWorkspace: false };
const access = accessData as never;
const request = { contractVersion: 1 as const, target: { kind: 'document' as const, workspaceId: 'ws-1', lineageId: 'lin-1',
  documentId: 'doc-1' }, rootProposalId: 'p-1', selectedProposalIds: ['p-1'] };
const stateData = { documentId: 'doc-1', workspaceId: 'ws-1', organizationId: 'org-1', path: 'note.md', status: 'active',
  degraded: false, lifecycleGeneration: 1, schemaVersion: 1, representation: 'plain_text' };
const state = stateData as never;

function harness(ownerId: string) {
  const transaction: FileVersionCenterTransaction = {
    query: async <Row>(sql: string) => {
      if (sql.includes('FROM file_proposal_graphs')) return { rows: [{ graph_id: 'graph-1', graph_revision: 2 }] as Row[] };
      if (sql.includes('FROM file_change_proposals')) return { rows: [{ proposal_id: 'p-1', initiated_by_user_id: ownerId }] as Row[] };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  };
  const database: FileVersionCenterDatabase = { transaction: async (action) => action(transaction) };
  const graph: ProposalGraphSnapshotV1 = {
    contractVersion: 1,
    scope: { workspaceId: 'ws-1', lineageId: 'lin-1', documentId: 'doc-1', lifecycleGeneration: 1, schemaVersion: 1 },
    graphRevision: 2,
    nodes: [{ ...rootProposalFixture, proposalId: 'p-1', operationId: 'operation-p-1',
      scope: { workspaceId: 'ws-1', lineageId: 'lin-1', documentId: 'doc-1', lifecycleGeneration: 1, schemaVersion: 1 } }] as never,
    choiceGroups: [],
  };
  return { database, loadGraph: async () => graph as never };
}

test('read-only owner can inspect their proposal without write actionability', async () => {
  const dependencies = harness('user-1');
  const page = await readProposalReviewProjection({ request, target, workspace, access, loadState: async () => state, ...dependencies });
  assert.deepEqual(page.items.map((item) => item.proposalId), ['p-1']);
  assert.equal(page.actionability.read, 'available');
  assert.equal(page.actionability.accept, 'denied');
});

test('non-manager cannot learn a foreign proposal id while a manager can inspect it', async () => {
  const dependencies = harness('other-user');
  const denied = await readProposalReviewProjection({ request, target, workspace, access, loadState: async () => state, ...dependencies });
  assert.deepEqual(denied.items, []);
  assert.deepEqual(denied.authorizedProposalIds, []);
  assert.equal(denied.diagnosis.reasonCode, 'access_denied');

  const managerWorkspace = { ...workspaceData, permissions: { ...workspaceData.permissions, canManageWorkspace: true } } as never;
  const managerAccess = { ...accessData, userId: 'manager', canManageWorkspace: true } as never;
  const allowed = await readProposalReviewProjection({ request, target, workspace: managerWorkspace, access: managerAccess,
    loadState: async () => state, ...dependencies });
  assert.deepEqual(allowed.items.map((item) => item.proposalId), ['p-1']);
});

test('cross-workspace access is rejected before state or graph reads', async () => {
  let stateReads = 0;
  await assert.rejects(() => readProposalReviewProjection({ request: { ...request, target: { ...request.target, workspaceId: 'other' } },
    target, workspace, access, loadState: async () => { stateReads += 1; return state; } }), /not available/);
  assert.equal(stateReads, 0);
});

test('organization and lifecycle proof mismatches fail closed', async () => {
  await assert.rejects(() => readProposalReviewProjection({ request, target, workspace, access,
    loadState: async () => ({ ...stateData, organizationId: 'other' } as never) }), /no longer active/);
  await assert.rejects(() => readProposalReviewProjection({ request, target, workspace, access,
    loadState: async () => ({ ...stateData, lifecycleGeneration: 0 } as never) }), /no longer active/);
  await assert.rejects(() => readProposalReviewProjection({ request, target, workspace, access,
    loadState: async () => ({ ...stateData, schemaVersion: 0 } as never) }), /no longer active/);
});
