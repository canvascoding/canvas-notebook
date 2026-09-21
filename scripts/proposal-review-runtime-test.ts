import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes,
  ProposalGraphContractError,
} from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { createRuntimeProposalReviewService } from '../app/lib/file-version-center/proposal-review-runtime';
import { proposalYjsCurrentProof } from '../app/lib/file-version-center/proposal-yjs-candidate';
import type { ProposalReviewEvaluationInput } from '../app/lib/file-version-center/proposal-review-evaluation';
import { Y } from '../app/lib/collaboration/server-runtime';
import type { FileVersionCenterDatabase, FileVersionCenterTransaction } from '../app/lib/file-version-center/database';
import type { ProposalGraphStorageTransaction } from '../app/lib/file-version-center/proposal-storage';
import type { FileVersionCenterAccess, ResolvedFileVersionTarget } from '../app/lib/file-version-center/query-service';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';

const target: ResolvedFileVersionTarget = {
  workspaceId: 'workspace-review', lineageId: 'lineage-review', documentId: 'document-review', path: 'review.md',
  latestRevisionId: null, latestRevisionHash: null, latestRevisionSize: 0,
};
const workspace: WorkspaceContext = {
  workspaceId: target.workspaceId, workspaceType: 'team', rootPath: '/tmp', organizationId: 'org-review', legacy: false,
  permissions: { canRead: true, canWrite: false, canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false },
};
const access = (userId = 'owner'): FileVersionCenterAccess => ({
  userId, authenticatedWorkspaceId: target.workspaceId, requestedWorkspaceId: target.workspaceId,
  membership: 'active', permissionsResolved: true, canRead: true, canManageWorkspace: false,
});
const state = (): PersistedCollaborationState => ({
  documentId: target.documentId!, workspaceId: target.workspaceId, organizationId: 'org-review', path: target.path,
  representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, yjsState: new Uint8Array(), stateVector: new Uint8Array(),
  documentSequence: 4, persistedAt: 1, checkpointedAt: null, checkpointSequence: 0, canonicalHash: null, serializedHash: null,
  newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active',
});
const identity = (sequence = 4) => ({
  lineage_id: target.lineageId, document_workspace_id: target.workspaceId, document_path: target.path, document_status: 'active', provider: 'yjs',
  lineage_workspace_id: target.workspaceId, lineage_path: target.path, lineage_status: 'active', workspace_id: target.workspaceId,
  organization_id: 'org-review', path: target.path, representation: 'plain_text' as const, lifecycle_generation: 1, schema_version: 1,
  document_sequence: sequence, status: 'active', degraded: false,
});

function harness(input: { proposalOwners?: Array<{ proposal_id: string; initiated_by_user_id: string }>; state?: PersistedCollaborationState | null; current?: () => Uint8Array }) {
  const writes: string[] = [];
  const sql: FileVersionCenterTransaction = {
    query: async <Row>(statement: string) => {
      if (statement.includes('FROM collaboration_documents')) return { rows: [identity()] as Row[] };
      if (statement.includes('FROM file_change_proposals')) return { rows: (input.proposalOwners ?? []) as Row[] };
      throw new Error(`Unexpected query: ${statement.slice(0, 60)}`);
    },
  };
  const database: FileVersionCenterDatabase = { transaction: async (action) => action(sql) };
  const storage = { withLockedGraph: async <T>(_scope: unknown, _options: unknown,
    action: (transaction: ProposalGraphStorageTransaction, tx: FileVersionCenterTransaction) => Promise<T>) =>
    action({
      loadGraph: async () => { throw new Error('evaluation hook must stop before graph reads'); },
      putArtifact: async () => { writes.push('artifact'); throw new Error('not expected'); },
      putEvaluation: async () => { writes.push('evaluation'); },
    } as unknown as ProposalGraphStorageTransaction, sql), };
  return { database, storage, writes };
}

async function service(input: {
  owners?: Array<{ proposal_id: string; initiated_by_user_id: string }>;
  requestedAccess?: FileVersionCenterAccess;
  requestedWorkspace?: WorkspaceContext;
  requestedState?: PersistedCollaborationState | null;
  current?: () => Uint8Array;
  evaluate?: (input: ProposalReviewEvaluationInput) => Promise<never>;
}) {
  const h = harness({ proposalOwners: input.owners, state: input.requestedState, current: input.current });
  return createRuntimeProposalReviewService({ target, workspace: input.requestedWorkspace ?? workspace,
    access: input.requestedAccess ?? access(), dependencies: {
      database: h.database, storage: h.storage, loadState: async () => input.requestedState === undefined ? state() : input.requestedState,
      readCurrent: async () => input.current?.() ?? new Uint8Array([1]), evaluate: input.evaluate,
    } });
}

function successfulEvaluation() {
  return async (input: ProposalReviewEvaluationInput) => {
    await input.authorize({ scope: input.scope, proposalIds: ['p1'] });
    return { status: 'clean', actionability: 'accept' } as never;
  };
}

test('read-only owner can evaluate their proposal without agent permission or graph mutations', async () => {
  const review = await service({ owners: [{ proposal_id: 'p1', initiated_by_user_id: 'owner' }], evaluate: successfulEvaluation() });
  const result = await review.evaluateSelection({ selectedProposalIds: ['p1'] });
  assert.equal(result.status, 'clean');
});

test('workspace manager can evaluate another user proposal', async () => {
  const manager = { ...access('manager'), canManageWorkspace: true };
  const managerWorkspace = { ...workspace, permissions: { ...workspace.permissions, canManageWorkspace: true } };
  const review = await service({ owners: [{ proposal_id: 'p1', initiated_by_user_id: 'other' }], requestedAccess: manager,
    requestedWorkspace: managerWorkspace,
    evaluate: successfulEvaluation() });
  assert.equal((await review.evaluateSelection({ selectedProposalIds: ['p1'] })).status, 'clean');
});

test('a mismatched manager claim cannot authorize another user proposal', async () => {
  const managerClaim = { ...access('manager'), canManageWorkspace: true };
  const review = await service({ owners: [{ proposal_id: 'p1', initiated_by_user_id: 'other' }], requestedAccess: managerClaim,
    evaluate: successfulEvaluation() });
  await assert.rejects(review.evaluateSelection({ selectedProposalIds: ['p1'] }), (error: unknown) =>
    error instanceof ProposalGraphContractError && error.code === Codes.accessDenied);
});

test('non-manager is denied before graph artifacts can be read for another user proposal', async () => {
  const review = await service({ owners: [{ proposal_id: 'p1', initiated_by_user_id: 'other' }], evaluate: successfulEvaluation() });
  await assert.rejects(review.evaluateSelection({ selectedProposalIds: ['p1'] }), (error: unknown) =>
    error instanceof ProposalGraphContractError && error.code === Codes.accessDenied);
});

test('cross-workspace collaboration state fails closed before graph access', async () => {
  await assert.rejects(service({ requestedState: { ...state(), workspaceId: 'other-workspace' }, evaluate: successfulEvaluation() }),
    (error: unknown) => error instanceof ProposalGraphContractError && error.code === Codes.staleLifecycle);
});

test('a live current change is delivered to the evaluator confirmation fence', async () => {
  let call = 0;
  const review = await service({ owners: [{ proposal_id: 'p1', initiated_by_user_id: 'owner' }], current: () => {
    const doc = new Y.Doc();
    try { doc.getText('content').insert(0, String(++call)); return Y.encodeStateAsUpdate(doc); } finally { doc.destroy(); }
  },
    evaluate: async (input) => {
      const first = await input.loadCurrent();
      const firstProof = proposalYjsCurrentProof({ update: first.update, representation: first.representation, revisionId: first.revisionId });
      const second = await input.confirmCurrent!(firstProof);
      const secondProof = proposalYjsCurrentProof({ update: second.update, representation: second.representation, revisionId: second.revisionId });
      if (firstProof.fullStateHash !== secondProof.fullStateHash) throw new ProposalGraphContractError(Codes.currentChanged, 'changed');
      return {} as never;
    } });
  await assert.rejects(review.evaluateSelection({ selectedProposalIds: ['p1'] }), (error: unknown) =>
    error instanceof ProposalGraphContractError && error.code === Codes.currentChanged);
});

test('the runtime exposes a read-only graph-aware comparison entry point', async () => {
  const document = new Y.Doc();
  document.getText('content').insert(0, 'base\n');
  const update = Y.encodeStateAsUpdate(document);
  document.destroy();
  const review = await service({ owners: [{ proposal_id: 'p1', initiated_by_user_id: 'owner' }], current: () => update,
    evaluate: async (input) => {
      await input.authorize({ scope: input.scope, proposalIds: ['p1'] });
      const current = await input.loadCurrent();
      const currentProof = proposalYjsCurrentProof({ update: current.update, representation: current.representation, revisionId: current.revisionId });
      const candidate = new Y.Doc(); candidate.getText('content').insert(0, 'base\nproposal\n');
      const candidateUpdate = Y.encodeStateAsUpdate(candidate); candidate.destroy();
      const candidateProof = proposalYjsCurrentProof({ update: candidateUpdate, representation: current.representation, revisionId: null });
      return { status: 'clean', reasonCode: null, current: currentProof, graphRevision: 0, selectedProposalIds: ['p1'],
        dependencyProposalIds: [], applyProposalIds: ['p1'], prerequisiteProposalIds: [], closureProposalIds: ['p1'], selectionHash: 'a'.repeat(64),
        actionability: 'accept', effectiveCandidate: { ref: 'candidate', sha256: 'b'.repeat(64), sizeBytes: 1, encoding: 'yjs_full_update_v1' },
        candidateContent: 'base\nproposal\n', candidateProof, appliedProposalIds: ['p1'], satisfiedProposalIds: [],
        evaluation: { contractVersion: 1, evaluationId: 'eval-runtime', proposalId: 'p1', scope: input.scope, current: currentProof, graphRevision: 0,
          status: 'clean', reasonCode: null, effectiveCandidate: { ref: 'candidate', sha256: 'b'.repeat(64), sizeBytes: 1, encoding: 'yjs_full_update_v1' },
          anchorMap: { ref: 'anchor', sha256: 'c'.repeat(64), sizeBytes: 1 }, effectPreconditions: { ref: 'effect', sha256: 'd'.repeat(64), sizeBytes: 1 },
          selectionHash: 'a'.repeat(64), evaluatedAt: 1, expiresAt: Date.now() + 60_000 },
      } as never;
    } });
  const result = await review.createCompareService().compare({ selectedProposalIds: ['p1'] });
  assert.equal(result.diagnosis.availability, 'available');
  assert.equal(result.summary.additions, 1);
});
