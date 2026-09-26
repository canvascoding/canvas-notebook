import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { applyProposalGraphCandidateOperation, prepareProposalAgentOperation, prepareProposalGraphActionOperation, recoverProposalGraphCandidateOperation } from '../collaboration/agent-operations';
import { readCurrentCollaborationDocument } from '../collaboration/document-access';
import { loadCollaborationState, type PersistedCollaborationState } from '../collaboration/persistence';
import { Y } from '../collaboration/server-runtime';
import { resolveExistingPostgresWorkspaceForActor } from '../workspaces/postgres-runtime';
import type { WorkspaceContext } from '../workspaces/types';
import { resolveAuthSecret } from '../security/auth-secret';
import { buildProposalActionFence, hashProposalEvaluationSelectionV1, hashProposalValue, signProposalActionFence } from './proposal-action-fence';
import { createProposalActionOrchestrator, type ProposalActionOrchestratorDependencies } from './proposal-action-orchestrator';
import { createProposalProvenanceService, persistProposalSourceSnapshot,
  proposalSourceView } from './proposal-provenance-service';
import { proposalReviewWritesEnabled } from './proposal-review-capability';
import { observeProposalGraph } from './observability';
import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes,
  PROPOSAL_GRAPH_LIMITS as Limits,
  ProposalGraphContractError,
  parseProposalActionRequestV1,
  type ProposalActionFenceV1,
  type ProposalActionReceiptV1,
  type ProposalActionRequestV1,
  type ProposalCurrentProofV1,
  type ProposalDocumentScopeV1,
  type ProposalEvaluationV1,
  parseProposalNodeV1,
} from './contracts/proposal-graph-v1';
import { parseProposalReviewTransformResponseV1, type ProposalReviewTransformRequestV1 } from './contracts/proposal-review-transform-v1';
import type { ProposalReviewCompareBindingV1 } from './contracts/proposal-review-compare-v1';
import { createRuntimeFileVersionCenterDatabase, type FileVersionCenterDatabase, type FileVersionCenterTransaction } from './database';
import { resolveProposalClosure, resolveProposalRejection } from './proposal-graph-model';
import { lockProposalDocumentIdentityRows } from './proposal-document-identity-lock';
import { createProposalGraphStorage } from './proposal-storage';
import { loadVerifiedProposalTargets, prepareProposalReviewTransformation } from './proposal-review-transform-service';
import { proposalYjsCurrentProof, type ProposalYjsRepresentation } from './proposal-yjs-candidate';
import type { FileVersionCenterAccess, ResolvedFileVersionTarget } from './query-service';
import { resolveFileVersionRolloutV1 } from './policy-v1';

type ActionType = 'accept' | 'batch_accept' | 'reject' | 'branch_reject' | 'complete_satisfied';
type AuthorizedActionType = ActionType | 'detach' | 'replace';
type Storage = Pick<ReturnType<typeof createProposalGraphStorage>, 'withLockedGraph'>;
type IdentityRow = {
  lineage_id: string; document_workspace_id: string; document_path: string; document_status: string; provider: string;
  lineage_workspace_id: string; lineage_path: string; lineage_status: string;
  workspace_id: string; organization_id: string | null; path: string; representation: ProposalYjsRepresentation;
  lifecycle_generation: number | string; schema_version: number | string; document_sequence: number | string;
  status: string; degraded: boolean | number;
};
type ActiveTransaction = { sql: FileVersionCenterTransaction; currentUpdate: Uint8Array | null; sequence: number | null;
  representation: ProposalYjsRepresentation | null };

export type RuntimeProposalReviewActionDependencies = {
  database?: FileVersionCenterDatabase;
  storage?: Storage;
  loadState?: (documentId: string) => Promise<PersistedCollaborationState | null>;
  readCurrent?: (documentId: string, workspaceId: string) => Promise<Uint8Array>;
  readWorkspace?: typeof resolveExistingPostgresWorkspaceForActor;
  signingSecret?: string | Uint8Array;
  writesEnabled?: () => boolean;
  rolloutWritable?: () => boolean;
  prepareDurably?: typeof prepareProposalGraphActionOperation;
  prepareCreatedOperation?: typeof prepareProposalAgentOperation;
  applyDurably?: typeof applyProposalGraphCandidateOperation;
  recoverDurably?: typeof recoverProposalGraphCandidateOperation;
  now?: () => number;
  createId?: () => string;
};

function fail(code: typeof Codes[keyof typeof Codes], message: string): never {
  throw new ProposalGraphContractError(code, message);
}

function sameScope(left: ProposalDocumentScopeV1, right: ProposalDocumentScopeV1): boolean {
  return isDeepStrictEqual(left, right);
}

function sameProof(left: ProposalCurrentProofV1, right: ProposalCurrentProofV1): boolean {
  return isDeepStrictEqual(left, right);
}

function assertActionType(value: string): asserts value is AuthorizedActionType {
  if (!['accept', 'batch_accept', 'reject', 'branch_reject', 'complete_satisfied', 'detach', 'replace'].includes(value)) {
    fail(Codes.upgradeRequired, 'This proposal action is not available in the review runtime.');
  }
}

function assertSelection(ids: readonly string[], actionType: ActionType): void {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > Limits.batchMembers
    || new Set(ids).size !== ids.length || (actionType !== 'batch_accept' && ids.length !== 1)
    || ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id))) {
    fail(Codes.invalidRequest, 'An action requires one exact, bounded proposal selection.');
  }
}

function assertBinding(input: { binding: ProposalReviewCompareBindingV1; evaluation: ProposalEvaluationV1;
  scope: ProposalDocumentScopeV1; selectionHash: string; selectedProposalIds: readonly string[];
  current: ProposalCurrentProofV1; graphRevision: number }): void {
  const { binding, evaluation, selectedProposalIds } = input;
  if (binding.evaluationId !== evaluation.evaluationId || binding.selectionHash !== input.selectionHash
    || binding.graphRevision !== input.graphRevision || evaluation.graphRevision !== input.graphRevision
    || !sameProof(binding.current, input.current) || !sameProof(evaluation.current, input.current)
    || !sameScope(evaluation.scope, input.scope)
    || evaluation.proposalId !== selectedProposalIds[0]
    || binding.selectedProposalIds.length !== selectedProposalIds.length
    || binding.selectedProposalIds.some((id, index) => id !== selectedProposalIds[index])
    || evaluation.selectionHash !== input.selectionHash) {
    fail(Codes.candidateChanged, 'The displayed comparison is not bound to this proposal action.');
  }
}

function stateVector(update: Uint8Array): string {
  const document = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(document, update);
    return Buffer.from(Y.encodeStateVector(document)).toString('base64');
  } finally {
    document.destroy();
  }
}

/** User review action integration. All content changes pass through the graph action orchestrator and one durable Yjs operation. */
export async function createRuntimeProposalReviewActionService(input: {
  target: ResolvedFileVersionTarget;
  workspace: WorkspaceContext;
  access: FileVersionCenterAccess;
  reviewerSessionId?: string;
  dependencies?: RuntimeProposalReviewActionDependencies;
}) {
  const { target, workspace, access } = input;
  const deps = input.dependencies;
  const enabled = deps?.writesEnabled ?? (() => proposalReviewWritesEnabled({ workspaceId: workspace.workspaceId }));
  const rolloutWritable = deps?.rolloutWritable ?? (() => resolveFileVersionRolloutV1(process.env.FILE_VERSION_CENTER_MODE).restore);
  const loadState = deps?.loadState ?? loadCollaborationState;
  const readUpdate = deps?.readCurrent ?? ((documentId: string, workspaceId: string) =>
    readCurrentCollaborationDocument({ documentId, workspaceId, read: (document) => Y.encodeStateAsUpdate(document) }));
  const readWorkspace = deps?.readWorkspace ?? resolveExistingPostgresWorkspaceForActor;
  const database = deps?.database ?? createRuntimeFileVersionCenterDatabase();
  const storage = deps?.storage ?? createProposalGraphStorage({ database });
  const now = deps?.now ?? Date.now;
  const createId = deps?.createId ?? randomUUID;
  const signingSecret = deps?.signingSecret ?? resolveAuthSecret();
  const active = new AsyncLocalStorage<ActiveTransaction>();

  const assertEnabled = () => {
    if (!enabled() || !rolloutWritable()) fail(Codes.upgradeRequired, 'Proposal review actions are not enabled yet.');
  };
  const freshWorkspace = async (): Promise<WorkspaceContext> => {
    if (!access.canWrite || !access.canRead || access.membership !== 'active' || !access.permissionsResolved
      || access.authenticatedWorkspaceId !== workspace.workspaceId || access.requestedWorkspaceId !== workspace.workspaceId
      || access.userId !== workspace.actor?.userId || !workspace.permissions.canWrite || workspace.legacy) {
      fail(Codes.accessDenied, 'The active user cannot change proposals in this workspace.');
    }
    const fresh = await readWorkspace(workspace.actor!, workspace.workspaceId);
    if (!fresh || fresh.workspaceId !== workspace.workspaceId || (fresh.organizationId ?? null) !== (workspace.organizationId ?? null)
      || fresh.legacy || !fresh.permissions.canRead || !fresh.permissions.canWrite) {
      fail(Codes.accessDenied, 'Workspace write access changed before the proposal action.');
    }
    return fresh;
  };
  if (!target.documentId || target.workspaceId !== workspace.workspaceId || target.lineageId.length < 1) {
    fail(Codes.scopeMismatch, 'The proposal action requires an exact collaborative document target.');
  }
  await freshWorkspace();
  const initial = await loadState(target.documentId);
  if (!initial || initial.documentId !== target.documentId || initial.workspaceId !== workspace.workspaceId
    || initial.organizationId !== (workspace.organizationId ?? null) || initial.path !== target.path
    || initial.status !== 'active' || initial.degraded || !Number.isSafeInteger(initial.lifecycleGeneration)
    || !Number.isSafeInteger(initial.schemaVersion)) {
    fail(Codes.staleLifecycle, 'The collaborative document lifecycle is unavailable.');
  }
  const scope: ProposalDocumentScopeV1 = { workspaceId: workspace.workspaceId, lineageId: target.lineageId,
    documentId: target.documentId, lifecycleGeneration: initial.lifecycleGeneration, schemaVersion: initial.schemaVersion };

  const checkedIdentity = async (sql: FileVersionCenterTransaction): Promise<{ row: IdentityRow; state: PersistedCollaborationState }> => {
    const state = await loadState(scope.documentId);
    const lockedLineageId = await lockProposalDocumentIdentityRows(sql, {
      documentId: scope.documentId, workspaceId: scope.workspaceId,
    });
    const row = (await sql.query<IdentityRow>(`SELECT document.lineage_id,document.workspace_id AS document_workspace_id,
      document.path AS document_path,document.status AS document_status,document.provider,
      lineage.workspace_id AS lineage_workspace_id,lineage.path AS lineage_path,lineage.status AS lineage_status,
      state.workspace_id,state.organization_id,state.path,state.representation,state.lifecycle_generation,
      state.schema_version,state.document_sequence,state.status,state.degraded
      FROM collaboration_documents document
      JOIN file_collaboration_lineages lineage ON lineage.id=document.lineage_id
      JOIN collaboration_yjs_states state ON state.document_id=document.id
      WHERE document.id=$1 AND document.workspace_id=$2 AND lineage.workspace_id=$2 AND state.workspace_id=$2`,
    [scope.documentId, scope.workspaceId])).rows[0];
    if (!state || !row || state.documentId !== scope.documentId || state.workspaceId !== scope.workspaceId
      || lockedLineageId !== scope.lineageId
      || state.organizationId !== (workspace.organizationId ?? null) || state.path !== target.path
      || state.status !== 'active' || state.degraded || row.lineage_id !== scope.lineageId
      || row.document_workspace_id !== scope.workspaceId || row.lineage_workspace_id !== scope.workspaceId
      || row.workspace_id !== scope.workspaceId || row.organization_id !== (workspace.organizationId ?? null)
      || row.path !== target.path || row.document_path !== target.path || row.lineage_path !== target.path
      || row.document_status !== 'active' || row.lineage_status !== 'active' || row.status !== 'active'
      || row.degraded === true || Number(row.degraded) === 1 || row.provider !== 'yjs'
      || row.representation !== state.representation || Number(row.lifecycle_generation) !== scope.lifecycleGeneration
      || Number(row.schema_version) !== scope.schemaVersion || state.lifecycleGeneration !== scope.lifecycleGeneration
      || state.schemaVersion !== scope.schemaVersion) {
      fail(Codes.staleLifecycle, 'The collaborative document identity changed during review.');
    }
    return { row, state };
  };

  const withLockedGraph: Storage['withLockedGraph'] = (requestedScope, options, action) => {
    if (!sameScope(scope, requestedScope)) fail(Codes.scopeMismatch, 'The action belongs to another document.');
    return storage.withLockedGraph(scope, options, (transaction, sql) =>
      active.run({ sql, currentUpdate: null, sequence: null, representation: null }, () => action(transaction, sql)));
  };

  const authorize = async (requested: { scope: ProposalDocumentScopeV1; proposalIds: string[]; actionType: ProposalActionRequestV1['fence']['actionType'] }) => {
    assertActionType(requested.actionType);
    if (!sameScope(scope, requested.scope) || requested.proposalIds.length < 1
      || new Set(requested.proposalIds).size !== requested.proposalIds.length) {
      fail(Codes.scopeMismatch, 'Proposal authorization is outside this document closure.');
    }
    const fresh = await freshWorkspace();
    const context = active.getStore();
    if (!context) fail(Codes.accessDenied, 'Proposal authorization requires the graph lock.');
    await checkedIdentity(context.sql);
    const rows = (await context.sql.query<{ proposal_id: string; initiated_by_user_id: string }>(`SELECT proposal.proposal_id,operation.initiated_by_user_id
      FROM file_change_proposals proposal
      JOIN file_proposal_graphs graph ON graph.graph_id=proposal.graph_id
      JOIN collaboration_agent_operations operation ON operation.operation_id=proposal.operation_id
      WHERE graph.workspace_id=$1 AND graph.lineage_id=$2 AND graph.document_id=$3
        AND graph.lifecycle_generation=$4 AND graph.schema_version=$5
        AND proposal.proposal_id=ANY($6::text[])`,
    [scope.workspaceId, scope.lineageId, scope.documentId, scope.lifecycleGeneration, scope.schemaVersion, requested.proposalIds])).rows;
    if (rows.length !== requested.proposalIds.length || new Set(rows.map((row) => row.proposal_id)).size !== rows.length) {
      fail(Codes.sourceInvalid, 'The selected proposal closure is unavailable.');
    }
    if (!(access.canManageWorkspace && workspace.permissions.canManageWorkspace && fresh.permissions.canManageWorkspace)
      && rows.some((row) => row.initiated_by_user_id !== access.userId)) {
      fail(Codes.accessDenied, 'Only a workspace manager may change another user’s proposal.');
    }
    return { userId: access.userId, actorId: access.userId,
      authorizationRevision: hashProposalValue({ workspaceId: scope.workspaceId, userId: access.userId,
        role: fresh.actor?.role ?? null,
        canManage: Boolean(access.canManageWorkspace && workspace.permissions.canManageWorkspace && fresh.permissions.canManageWorkspace),
        canWrite: fresh.permissions.canWrite }) };
  };

  const readCurrent = async (requestedScope: ProposalDocumentScopeV1): Promise<ProposalCurrentProofV1> => {
    if (!sameScope(scope, requestedScope)) fail(Codes.scopeMismatch, 'Current document proof belongs to another scope.');
    const context = active.getStore();
    if (!context) fail(Codes.currentChanged, 'Current proof requires the graph lock.');
    const { row, state } = await checkedIdentity(context.sql);
    const update = await readUpdate(scope.documentId, scope.workspaceId);
    const after = await checkedIdentity(context.sql);
    if (Number(after.row.document_sequence) !== Number(row.document_sequence)) {
      fail(Codes.currentChanged, 'The document changed while preparing the action.');
    }
    context.currentUpdate = update;
    context.sequence = Number(row.document_sequence);
    context.representation = state.representation;
    return proposalYjsCurrentProof({ update, representation: state.representation, revisionId: null });
  };

  const orchestratorDependencies: ProposalActionOrchestratorDependencies = {
    withLockedGraph,
    authorize: async (requested) => {
      assertEnabled();
      return authorize(requested);
    },
    readCurrent,
    signingSecret,
    now,
    createId,
    materializeCreation: async ({ creation, actorId, now: createdAt, transaction, sql }) => {
      if (!['replacement', 'detached'].includes(creation.creationKind) || !sameScope(creation.scope, scope)) {
        fail(Codes.sourceInvalid, 'Only an explicitly approved transformation may create a review proposal.');
      }
      const kind = creation.creationKind === 'replacement' ? 'replace' : 'detach';
      const originalId = kind === 'replace' ? creation.relationships.replacesProposalId : creation.detachedFromProposalId;
      if (!originalId) fail(Codes.sourceInvalid, 'The original transformation proposal is unavailable.');
      const graph = await transaction.loadGraph({ includeProposalIds: [originalId] });
      const original = graph.nodes.find((node) => node.proposalId === originalId);
      if (!original || original.lifecycle !== 'open') fail(Codes.graphChanged, 'The original proposal changed before creation.');
      const required = new Set([originalId]);
      let parentId = original.relationships.dependency?.proposalId;
      while (parentId) {
        if (required.has(parentId) || required.size >= Limits.closureNodes) fail(Codes.cycle, 'Proposal ancestry is invalid.');
        required.add(parentId);
        const parent = graph.nodes.find((node) => node.proposalId === parentId);
        if (!parent) fail(Codes.sourceInvalid, 'The original prerequisite is unavailable.');
        parentId = parent.relationships.dependency?.proposalId;
      }
      const choice = original.relationships.choiceGroupId
        ? graph.choiceGroups.find((group) => group.groupId === original.relationships.choiceGroupId) : null;
      if (kind === 'replace' && original.relationships.choiceGroupId
        && (!choice || choice.chosenProposalId !== null || !choice.memberProposalIds.includes(originalId))) {
        fail(Codes.choiceConflict, 'The alternative group changed before replacement.');
      }
      if (kind === 'replace') for (const id of choice?.memberProposalIds ?? []) required.add(id);
      await authorize({ scope, proposalIds: [...required], actionType: kind });
      if (kind === 'replace'
        ? !isDeepStrictEqual(creation.relationships.dependency, original.relationships.dependency)
          || creation.relationships.choiceGroupId !== original.relationships.choiceGroupId
        : creation.relationships.dependency !== null || creation.relationships.choiceGroupId !== null) {
        fail(Codes.sourceInvalid, 'The transformation changed its declared prerequisite or alternative group.');
      }
      const current = await readCurrent(scope);
      const context = active.getStore();
      if (!context?.currentUpdate || !context.representation || context.sequence === null
        || !sameProof(current, creation.source.current)) {
        fail(Codes.currentChanged, 'The transformed source no longer matches current content.');
      }
      const sourceUpdate = await transaction.readArtifact(creation.source.snapshot);
      const receiptRefs = await persistProposalSourceSnapshot(transaction, sourceUpdate, context.representation);
      if (!isDeepStrictEqual(receiptRefs.snapshot, creation.source.snapshot)
        || !isDeepStrictEqual(receiptRefs.anchorMap, creation.source.anchorMap)) {
        fail(Codes.sourceInvalid, 'The transformed source identity receipt changed.');
      }
      if (creation.source.kind === 'authoritative') {
        if ((kind !== 'detach' && original.relationships.dependency !== null)
          || !sameProof(proposalYjsCurrentProof({ update: sourceUpdate, representation: context.representation, revisionId: null }), current)) {
          fail(Codes.sourceInvalid, 'The transformation did not use the exact authoritative source.');
        }
      } else {
        const parentSource = creation.source;
        const parent = graph.nodes.find((node) => node.proposalId === parentSource.proposalId);
        if (kind !== 'replace' || !parent || parent.proposalId !== original.relationships.dependency?.proposalId
          || parent.casVersion !== creation.source.proposalCasVersion
          || parent.authoredCandidate.cumulativeCandidate.sha256 !== creation.source.authoredCandidateHash
          || creation.source.evaluationId === null) {
          fail(Codes.parentChanged, 'The replacement prerequisite changed.');
        }
        const evaluation = await transaction.getEvaluation(creation.source.evaluationId);
        if (!evaluation || evaluation.proposalId !== parent.proposalId || evaluation.graphRevision !== graph.graphRevision
          || !sameProof(evaluation.current, current)
          || !isDeepStrictEqual(evaluation.effectiveCandidate, creation.source.snapshot)
          || !isDeepStrictEqual(evaluation.anchorMap, creation.source.anchorMap)) {
          fail(Codes.parentChanged, 'The replacement source evaluation is unavailable.');
        }
      }
      const targets = await loadVerifiedProposalTargets({ transaction, node: original, representation: context.representation });
      const node = parseProposalNodeV1({ contractVersion: 1, proposalId: creation.proposalId,
        operationId: creation.operationId, scope: creation.scope, source: creation.source,
        relationships: creation.relationships, authoredCandidate: creation.authoredCandidate,
        casVersion: 1, lifecycle: 'open', createdAt, createdByActorId: actorId });
      const transformedTargets = await loadVerifiedProposalTargets({ transaction, node, representation: context.representation });
      if (!isDeepStrictEqual(targets, transformedTargets)
        || kind === 'replace' && creation.authoredCandidate.cumulativeCandidate.sha256 === original.authoredCandidate.cumulativeCandidate.sha256) {
        fail(Codes.candidateChanged, 'The reviewed transformed candidate changed.');
      }
      if (!sameProof(await readCurrent(scope), current) || active.getStore()?.sequence !== context.sequence) {
        fail(Codes.currentChanged, 'Current content changed during proposal creation.');
      }
      if (!input.reviewerSessionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.reviewerSessionId)) {
        fail(Codes.accessDenied, 'An active reviewer session is required for proposal creation.');
      }
      const sourceContent = proposalSourceView(sourceUpdate, context.representation).content;
      const proposedContent = proposalSourceView(await transaction.readArtifact(creation.authoredCandidate.cumulativeCandidate),
        context.representation).content;
      await (deps?.prepareCreatedOperation ?? prepareProposalAgentOperation)({ transaction: sql,
        operationId: creation.operationId, documentId: scope.documentId, workspace: await freshWorkspace(),
        initiatedByUserId: access.userId, actorId, actorSessionId: input.reviewerSessionId,
        idempotencyKey: creation.operationId,
        targets, documentPath: target.path, documentRepresentation: context.representation,
        documentLifecycleGeneration: scope.lifecycleGeneration, documentSchemaVersion: scope.schemaVersion,
        baseStateVector: stateVector(sourceUpdate), baseDocumentSequence: context.sequence,
        fileEditRequest: { fingerprint: hashProposalValue({ creation, actorId }),
          beforeSha256: createHash('sha256').update(sourceContent, 'utf8').digest('hex'),
          proposedSha256: createHash('sha256').update(proposedContent, 'utf8').digest('hex') } });
      await transaction.insertProposal(node);
      if (kind === 'replace' && choice) await transaction.putChoiceGroup({ ...choice, groupRevision: choice.groupRevision + 1,
        memberProposalIds: [...choice.memberProposalIds, creation.proposalId] }, choice.groupRevision);
      return node;
    },
    prepareDurably: async ({ transaction, scope: requestedScope, actionId, current }) => {
      if (!input.reviewerSessionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.reviewerSessionId)) {
        fail(Codes.accessDenied, 'An active reviewer session is required for content application.');
      }
      const context = active.getStore();
      if (!context || !sameScope(scope, requestedScope) || !context.currentUpdate || context.sequence === null || !context.representation) {
        fail(Codes.currentChanged, 'The prepared document proof is unavailable.');
      }
      const checked = await checkedIdentity(context.sql);
      if (Number(checked.row.document_sequence) !== context.sequence
        || !sameProof(proposalYjsCurrentProof({ update: context.currentUpdate,
          representation: context.representation, revisionId: null }), current)) {
        fail(Codes.currentChanged, 'The document changed before durable preparation.');
      }
      await (deps?.prepareDurably ?? prepareProposalGraphActionOperation)({ transaction, actionId, scope,
        workspace: await freshWorkspace(), initiatedByUserId: access.userId, actorId: access.userId,
        actorSessionId: input.reviewerSessionId,
        documentPath: target.path, documentRepresentation: context.representation,
        baseStateVector: stateVector(context.currentUpdate), baseDocumentSequence: context.sequence });
    },
    applyDurably: async ({ scope: requestedScope, actionId, current, candidate }) => {
      if (!sameScope(scope, requestedScope)) fail(Codes.scopeMismatch, 'The durable apply belongs to another document.');
      const fresh = await freshWorkspace();
      if (!input.reviewerSessionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.reviewerSessionId)) {
        fail(Codes.accessDenied, 'An active reviewer session is required for content application.');
      }
      const state = await loadState(scope.documentId);
      if (!state || state.lifecycleGeneration !== scope.lifecycleGeneration || state.schemaVersion !== scope.schemaVersion
        || state.status !== 'active' || state.degraded || state.path !== target.path) {
        fail(Codes.staleLifecycle, 'The document lifecycle changed before durable apply.');
      }
      return (deps?.applyDurably ?? applyProposalGraphCandidateOperation)({ actionId, scope, workspace: fresh,
        initiatedByUserId: access.userId, actorId: access.userId, actorDisplayName: fresh.actor?.email || access.userId,
        actorType: 'user', actorSessionId: input.reviewerSessionId,
        representation: state.representation, expectedCurrent: current, candidateUpdate: candidate.update,
        candidateSha256: candidate.evaluation.effectiveCandidate!.sha256, baseRevisionId: current.revisionId });
    },
    recoverDurably: async ({ scope: requestedScope, actionId, current, candidate }) => {
      if (!sameScope(scope, requestedScope)) fail(Codes.scopeMismatch, 'The recovery belongs to another document.');
      const fresh = await freshWorkspace();
      const state = await loadState(scope.documentId);
      if (!state || state.lifecycleGeneration !== scope.lifecycleGeneration || state.schemaVersion !== scope.schemaVersion) {
        fail(Codes.staleLifecycle, 'The document lifecycle changed before recovery.');
      }
      return (deps?.recoverDurably ?? recoverProposalGraphCandidateOperation)({ actionId, scope, workspace: fresh,
        initiatedByUserId: access.userId, actorId: access.userId, actorDisplayName: fresh.actor?.email || access.userId,
        representation: state.representation, expectedCurrent: current, candidateUpdate: candidate.update,
        candidateSha256: candidate.evaluation.effectiveCandidate!.sha256, baseRevisionId: current.revisionId });
    },
  };
  const orchestrator = createProposalActionOrchestrator(orchestratorDependencies);
  // Rollback blocks new approvals, not completion of an already reserved action.
  // Recovery still checks fresh authorization and immutable durable receipts. Only
  // its recovery methods are used: never execute or replay the live mutation.
  const recoveryOrchestrator = createProposalActionOrchestrator({ ...orchestratorDependencies, authorize });
  const observedAction = async (phase: 'apply' | 'recovery', run: () => Promise<ProposalActionReceiptV1>,
    counts: { selectionCount?: number; closureCount?: number; applyCount?: number } = {}) => {
    const startedAt = Date.now();
    try {
      const receipt = await run();
      observeProposalGraph({ phase, startedAt, ...counts,
        outcome: receipt.phase === 'succeeded' ? 'succeeded' : receipt.phase === 'failed' ? 'failed' : 'pending',
        ...(receipt.errorCode ? { reasonCode: receipt.errorCode } : {}) });
      return receipt;
    } catch (error) {
      observeProposalGraph({ phase, startedAt, ...counts,
        outcome: error instanceof ProposalGraphContractError && error.code === Codes.recoveryRequired ? 'pending' : 'failed',
        ...(error instanceof ProposalGraphContractError ? { reasonCode: error.code } : {}) });
      throw error;
    }
  };

  const prepare = async (selection: { selectedProposalIds: readonly string[]; actionType: ActionType;
    binding?: ProposalReviewCompareBindingV1 }): Promise<{ fence: ProposalActionFenceV1; fenceToken: string }> => {
    assertEnabled();
    assertActionType(selection.actionType);
    assertSelection(selection.selectedProposalIds, selection.actionType);
    if (!['reject', 'branch_reject'].includes(selection.actionType) && !selection.binding) {
      fail(Codes.candidateChanged, 'The displayed comparison binding is required for this action.');
    }
    await freshWorkspace();
    return withLockedGraph(scope, {}, async (transaction, sql) => {
      await checkedIdentity(sql);
      const graph = await transaction.loadGraph({ includeProposalIds: selection.selectedProposalIds });
      if (!sameScope(scope, graph.scope)) fail(Codes.scopeMismatch, 'Proposal graph belongs to another document.');
      if (selection.actionType === 'complete_satisfied'
        && graph.nodes.find((node) => node.proposalId === selection.selectedProposalIds[0])?.lifecycle !== 'open') {
        fail(Codes.invalidTransition, 'The selected proposal is no longer open.');
      }
      const closure = selection.actionType === 'reject' || selection.actionType === 'branch_reject'
        ? resolveProposalRejection({ graph, proposalId: selection.selectedProposalIds[0]!,
          mode: selection.actionType === 'branch_reject' ? 'branch' : 'single' })
        : selection.actionType === 'complete_satisfied' ? null
          : resolveProposalClosure({ graph, selectedProposalIds: [...selection.selectedProposalIds] });
      if (closure?.status === 'blocked') fail(closure.reasonCode, 'The selected proposal closure is no longer actionable.');
      const evaluatedClosure = selection.actionType === 'complete_satisfied'
        ? resolveProposalClosure({ graph, selectedProposalIds: [...selection.selectedProposalIds] }) : null;
      if (evaluatedClosure?.status === 'blocked') {
        fail(evaluatedClosure.reasonCode, 'The evaluated proposal closure is no longer actionable.');
      }
      const closureIds = closure?.closureProposalIds ?? [selection.selectedProposalIds[0]!];
      const applyIds = closure && 'applyProposalIds' in closure ? closure.applyProposalIds : [];
      const choiceResolutions = closure && 'choiceResolutions' in closure ? closure.choiceResolutions : [];
      const actor = await authorize({ scope, proposalIds: closureIds, actionType: selection.actionType });
      if (evaluatedClosure?.status === 'ready') {
        await authorize({ scope, proposalIds: evaluatedClosure.closureProposalIds, actionType: selection.actionType });
      }
      const current = ['reject', 'branch_reject'].includes(selection.actionType) ? null : await readCurrent(scope);
      let evaluation: ProposalEvaluationV1 | null = null;
      if (selection.binding) {
        if (!current) {
          // Reject does not need current proof for its metadata transition, but a supplied binding must still be checked.
          const proof = await readCurrent(scope);
          evaluation = await transaction.getEvaluation(selection.binding.evaluationId);
          if (!evaluation) fail(Codes.candidateChanged, 'The displayed evaluation is unavailable.');
          assertBinding({ binding: selection.binding, evaluation, scope,
            selectionHash: hashProposalEvaluationSelectionV1({ selectedProposalIds: selection.selectedProposalIds,
              closureProposalIds: evaluatedClosure?.closureProposalIds ?? closureIds,
              applyProposalIds: evaluatedClosure?.applyProposalIds ?? applyIds, graphRevision: graph.graphRevision }),
            selectedProposalIds: selection.selectedProposalIds, current: proof, graphRevision: graph.graphRevision });
        } else {
          evaluation = await transaction.getEvaluation(selection.binding.evaluationId);
          if (!evaluation) fail(Codes.candidateChanged, 'The displayed evaluation is unavailable.');
          assertBinding({ binding: selection.binding, evaluation, scope,
            selectionHash: hashProposalEvaluationSelectionV1({ selectedProposalIds: selection.selectedProposalIds,
              closureProposalIds: evaluatedClosure?.closureProposalIds ?? closureIds,
              applyProposalIds: evaluatedClosure?.applyProposalIds ?? applyIds, graphRevision: graph.graphRevision }),
            selectedProposalIds: selection.selectedProposalIds, current, graphRevision: graph.graphRevision });
        }
        if (evaluation.expiresAt <= now()) fail(Codes.fenceExpired, 'The displayed evaluation expired.');
      }
      if (selection.actionType === 'accept' || selection.actionType === 'batch_accept') {
        if (!evaluation || !['clean', 'clean_rebased'].includes(evaluation.status) || !evaluation.effectiveCandidate) {
          fail(Codes.candidateChanged, 'Accept requires a current clean candidate.');
        }
      }
      if (selection.actionType === 'complete_satisfied') {
        if (!evaluation || !['satisfied_elsewhere', 'empty_effect'].includes(evaluation.status)
          || !evaluation.effectiveCandidate || !current) {
          fail(Codes.candidateChanged, 'Completion requires stored proof of a null effect.');
        }
        const update = await transaction.readArtifact(evaluation.effectiveCandidate);
        const representation = active.getStore()?.representation;
        if (!representation || !sameProof(proposalYjsCurrentProof({ update, representation, revisionId: null }), current)) {
          fail(Codes.candidateChanged, 'The evaluated candidate no longer proves a null effect.');
        }
      }
      const nodes = new Map(graph.nodes.map((node) => [node.proposalId, node]));
      const fence = buildProposalActionFence({ state: {
        scope, actor, actionType: selection.actionType, current, graphRevision: graph.graphRevision,
        evaluationId: ['reject', 'branch_reject'].includes(selection.actionType) ? null : evaluation!.evaluationId,
        effectiveCandidateHash: ['reject', 'branch_reject'].includes(selection.actionType) ? null : evaluation!.effectiveCandidate!.sha256,
        closure: closureIds.map((id) => {
          const node = nodes.get(id);
          if (!node) fail(Codes.sourceInvalid, 'A proposal in the approved closure is unavailable.');
          return { proposalId: node.proposalId, casVersion: node.casVersion,
            candidateHash: node.authoredCandidate.cumulativeCandidate.sha256 };
        }),
        selectedProposalIds: [...selection.selectedProposalIds], applyProposalIds: applyIds, choiceResolutions,
      }, fenceId: createId(), now: now(), expiresAt: evaluation?.expiresAt });
      return { fence, fenceToken: signProposalActionFence(fence, signingSecret) };
    });
  };

  const prepareTransform = async (request: Omit<ProposalReviewTransformRequestV1, 'contractVersion' | 'target'>) => {
    assertEnabled();
    if (request.kind !== 'detach' && request.kind !== 'replace') fail(Codes.invalidRequest, 'Unknown proposal transformation.');
    await freshWorkspace();
    return withLockedGraph(scope, {}, async (transaction, sql) => {
      await checkedIdentity(sql);
      const graph = await transaction.loadGraph({ includeProposalIds: [request.sourceProposalId] });
      if (!sameScope(graph.scope, scope)) fail(Codes.scopeMismatch, 'The proposal graph belongs to another document.');
      const current = await readCurrent(scope);
      const context = active.getStore();
      if (!context?.currentUpdate || !context.representation) fail(Codes.contentUnavailable, 'Current content is unavailable for transformation.');
      const provenance = createProposalProvenanceService({
        authorize: async ({ scope: requestedScope, proposalIds }) => {
          if (!sameScope(scope, requestedScope)) fail(Codes.scopeMismatch, 'The transformation source belongs to another document.');
          if (proposalIds.length) await authorize({ scope, proposalIds, actionType: request.kind });
          else await freshWorkspace();
        },
        withTransaction: async (requestedScope, action) => {
          if (!sameScope(scope, requestedScope)) fail(Codes.scopeMismatch, 'The transformation source belongs to another document.');
          return action({ graph: transaction, loadCurrent: async () => {
            const proof = await readCurrent(scope);
            if (!sameProof(proof, current) || !context.currentUpdate || !context.representation) {
              fail(Codes.currentChanged, 'Current content changed while authoring the transformation.');
            }
            return { scope, representation: context.representation, revisionId: null, update: context.currentUpdate };
          }, lookupOperation: async () => fail(Codes.invalidRequest, 'Transformation preview cannot resolve an agent operation.'),
          insertPreparedOperation: async () => fail(Codes.invalidRequest, 'Transformation preview cannot create an agent operation.') });
        },
        now, createId,
      });
      const transformed = await prepareProposalReviewTransformation({ scope, graph, transaction,
        kind: request.kind, sourceProposalId: request.sourceProposalId,
        expectedGraphRevision: request.expectedGraphRevision, current,
        representation: context.representation, actorId: access.userId, createId,
        authorize: async (proposalIds) => { await authorize({ scope, proposalIds, actionType: request.kind }); },
        readSource: async (proposalId) => {
          const read = await provenance.readExact({ scope, proposalId });
          return { source: read.metadata.source, content: read.content };
        },
      });
      if (!sameProof(await readCurrent(scope), current)) fail(Codes.currentChanged, 'Current content changed before signing transformation.');
      const original = graph.nodes.find((node) => node.proposalId === request.sourceProposalId)!;
      const actor = await authorize({ scope, proposalIds: [original.proposalId], actionType: request.kind });
      const evaluation = transformed.creation.source.kind === 'proposal' && transformed.creation.source.evaluationId
        ? await transaction.getEvaluation(transformed.creation.source.evaluationId) : null;
      if (transformed.creation.source.kind === 'proposal' && (!evaluation || evaluation.expiresAt <= now())) {
        fail(Codes.parentChanged, 'The transformed prerequisite evaluation expired.');
      }
      const fence = buildProposalActionFence({ state: { scope, actor, actionType: request.kind, current,
        graphRevision: graph.graphRevision, evaluationId: null, effectiveCandidateHash: null,
        closure: [{ proposalId: original.proposalId, casVersion: original.casVersion,
          candidateHash: original.authoredCandidate.cumulativeCandidate.sha256 }],
        selectedProposalIds: [original.proposalId], applyProposalIds: [], choiceResolutions: [] },
      creation: transformed.creation, fenceId: createId(), now: now(), expiresAt: evaluation?.expiresAt });
      return parseProposalReviewTransformResponseV1({ contractVersion: 1, kind: request.kind,
        sourceProposalId: original.proposalId, beforeContent: transformed.beforeContent,
        proposedContent: transformed.proposedContent, beforeSha256: transformed.beforeSha256,
        proposedSha256: transformed.proposedSha256,
        prepared: { fence, fenceToken: signProposalActionFence(fence, signingSecret), creation: transformed.creation } });
    });
  };

  const execute = async (value: unknown): Promise<ProposalActionReceiptV1> => {
    assertEnabled();
    const action = parseProposalActionRequestV1(value);
    assertActionType(action.fence.actionType);
    if (!sameScope(scope, action.fence.scope)
      || (action.creation !== null) !== ['detach', 'replace'].includes(action.fence.actionType)) {
      fail(Codes.scopeMismatch, 'The approved action is outside this review scope.');
    }
    if (['accept', 'batch_accept', 'detach', 'replace'].includes(action.fence.actionType)
      && (!input.reviewerSessionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.reviewerSessionId))) {
      fail(Codes.accessDenied, 'An active reviewer session is required before reserving this action.');
    }
    await freshWorkspace();
    return observedAction('apply', () => orchestrator.execute(action), {
      selectionCount: action.fence.selectedProposalIds.length,
      closureCount: action.fence.closure.length, applyCount: action.fence.applyProposalIds.length,
    });
  };

  const recover = async (actionId: string, identity: { keyHash: string; requestDigest: string }): Promise<ProposalActionReceiptV1> => {
    await freshWorkspace();
    await withLockedGraph(scope, { actionId }, async (transaction) => {
      const receipt = await transaction.getAction(actionId);
      const request = await transaction.getActionRequest(actionId);
      if (!receipt || !request || receipt.actorId !== access.userId || request.fence.actor.userId !== access.userId
        || receipt.idempotencyKeyHash !== identity.keyHash || receipt.requestDigest !== identity.requestDigest
        || request.fence.requestDigest !== identity.requestDigest
        || !sameScope(receipt.scope, scope) || !sameScope(request.fence.scope, scope)) {
        fail(Codes.accessDenied, 'The durable action is unavailable for this reviewer.');
      }
      // Status and recovery use separate graph transactions. Recheck proposal
      // ownership/manager authority, not only workspace write access, here too.
      await authorize({ scope, proposalIds: request.fence.closure.map((member) => member.proposalId),
        actionType: receipt.actionType });
    });
    return observedAction('recovery', () => recoveryOrchestrator.recover(scope, actionId));
  };

  const status = async (identity: { idempotencyKey: string; requestDigest: string }): Promise<ProposalActionReceiptV1 | null> => {
    if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(identity.idempotencyKey)
      || !/^[a-f0-9]{64}$/u.test(identity.requestDigest)) {
      fail(Codes.invalidRequest, 'The action status identity is invalid.');
    }
    await freshWorkspace();
    const keyHash = createHash('sha256').update(identity.idempotencyKey, 'utf8').digest('hex');
    const receipt = await withLockedGraph(scope, {}, async (transaction, sql) => {
      await checkedIdentity(sql);
      const row = (await sql.query<{ action_id: string }>(`SELECT action_id FROM file_proposal_action_receipts
        WHERE actor_id=$1 AND idempotency_key_hash=$2`, [access.userId, keyHash])).rows[0];
      if (!row) return null;
      const stored = await transaction.getAction(row.action_id);
      const request = await transaction.getActionRequest(row.action_id);
      if (!stored || !request || stored.actorId !== access.userId || stored.idempotencyKeyHash !== keyHash
        || stored.requestDigest !== identity.requestDigest || request.fence.requestDigest !== identity.requestDigest
        || request.fence.actor.userId !== access.userId || !sameScope(stored.scope, scope)
        || !sameScope(request.fence.scope, scope)) {
        fail(Codes.idempotencyMismatch, 'The action status identity belongs to another approved request.');
      }
      assertActionType(stored.actionType);
      await authorize({ scope, proposalIds: request.fence.closure.map((member) => member.proposalId), actionType: stored.actionType });
      return stored;
    });
    if (receipt && ['applying', 'awaiting_durability', 'recovery_required'].includes(receipt.phase)) {
      return recover(receipt.actionId, { keyHash, requestDigest: identity.requestDigest });
    }
    if (receipt?.phase === 'prepared') {
      return observedAction('recovery', () => recoveryOrchestrator.recoverMetadata(scope, receipt.actionId));
    }
    return receipt;
  };

  return { scope, prepare, prepareTransform, execute, status };
}
