import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { hashProposalEvaluationSelectionV1, verifyProposalActionFence, type ProposalFenceState } from './proposal-action-fence';
import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes,
  PROPOSAL_ACTION_RULES_V1,
  ProposalGraphContractError,
  type ProposalGraphErrorCode,
  parseProposalActionRequestV1,
  type ProposalActionReceiptV1,
  type ProposalActionRequestV1,
  type ProposalCurrentProofV1,
  type ProposalDocumentScopeV1,
  type ProposalEvaluationV1,
  type ProposalGraphSnapshotV1,
  type ProposalLifecycleV1,
  type ProposalNodeV1,
} from './contracts/proposal-graph-v1';
import { resolveProposalClosure, resolveProposalRejection } from './proposal-graph-model';
import type { FileVersionCenterTransaction } from './database';
import type { ProposalGraphStorageTransaction } from './proposal-storage';

type ActionActor = ProposalFenceState['actor'];
type DurableContentResult = { operationId: string; revisionId: string; current: ProposalCurrentProofV1 };
type DurableCandidate = {
  evaluation: ProposalEvaluationV1;
  update: Uint8Array;
};
type ResolvedLifecycle = Exclude<ProposalLifecycleV1, 'open'>;

/**
 * Runtime proof that an apply attempt stopped before its first document
 * mutation. Only this explicit signal may release an otherwise uncertain
 * graph reservation without durable candidate evidence.
 */
export class ProposalActionDefinitelyUnappliedError extends ProposalGraphContractError {
  constructor(code: ProposalGraphErrorCode, message: string) {
    super(code, message);
    this.name = 'ProposalActionDefinitelyUnappliedError';
  }
}

export type ProposalActionOrchestratorDependencies = {
  /** The graph lock is the only mutation serialisation boundary for this document scope. */
  withLockedGraph<T>(scope: ProposalDocumentScopeV1, options: { actionId?: string },
    action: (transaction: ProposalGraphStorageTransaction, sql: FileVersionCenterTransaction) => Promise<T>): Promise<T>;
  /** Reauthorization is deliberately repeated for each action; a fence is not permission. */
  authorize(input: { scope: ProposalDocumentScopeV1; proposalIds: string[]; actionType: ProposalActionRequestV1['fence']['actionType'] }): Promise<ActionActor>;
  /** Returns server-owned current proof. It must not trust client preview bytes. */
  readCurrent(scope: ProposalDocumentScopeV1): Promise<ProposalCurrentProofV1>;
  /** Exactly one existing durable collaboration apply path, injected by the runtime integration. */
  prepareDurably(input: { transaction: FileVersionCenterTransaction; scope: ProposalDocumentScopeV1; actionId: string;
    proposalIds: string[]; operationIds: string[]; current: ProposalCurrentProofV1; candidate: DurableCandidate }): Promise<void>;
  applyDurably(input: { scope: ProposalDocumentScopeV1; actionId: string; proposalIds: string[]; operationIds: string[];
    current: ProposalCurrentProofV1; candidate: DurableCandidate }): Promise<DurableContentResult>;
  /** Restart recovery may prove a persisted candidate, but must never replay a live mutation. */
  recoverDurably?(input: { scope: ProposalDocumentScopeV1; actionId: string; proposalIds: string[]; operationIds: string[];
    current: ProposalCurrentProofV1; candidate: DurableCandidate }): Promise<DurableContentResult>;
  /** Provenance service owns creation bytes; orchestrator only commits the exact approved node. */
  materializeCreation(input: { creation: NonNullable<ProposalActionRequestV1['creation']>; actorId: string; now: number;
    transaction: ProposalGraphStorageTransaction; sql: FileVersionCenterTransaction }): Promise<ProposalNodeV1>;
  signingSecret: string | Uint8Array;
  now?: () => number;
  createId?: () => string;
};

export type ProposalActionRecoveryDependencies = Pick<ProposalActionOrchestratorDependencies, 'withLockedGraph'> & {
  recoverDurably: NonNullable<ProposalActionOrchestratorDependencies['recoverDurably']>;
  now?: () => number;
};

function fail(code: typeof Codes[keyof typeof Codes], message: string): never {
  throw new ProposalGraphContractError(code, message);
}

function sameScope(left: ProposalDocumentScopeV1, right: ProposalDocumentScopeV1): boolean {
  return left.workspaceId === right.workspaceId && left.lineageId === right.lineageId && left.documentId === right.documentId
    && left.lifecycleGeneration === right.lifecycleGeneration && left.schemaVersion === right.schemaVersion;
}

function hashKey(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function closureMembers(graph: ProposalGraphSnapshotV1, ids: readonly string[]) {
  const nodes = new Map(graph.nodes.map((node) => [node.proposalId, node]));
  return ids.map((id) => {
    const node = nodes.get(id);
    if (!node) fail(Codes.sourceInvalid, 'The approved proposal closure is unavailable.');
    return { proposalId: node.proposalId, casVersion: node.casVersion, candidateHash: node.authoredCandidate.cumulativeCandidate.sha256 };
  });
}

function actionShape(graph: ProposalGraphSnapshotV1, request: ProposalActionRequestV1): {
  closureIds: string[]; applyIds: string[]; choiceResolutions: ProposalFenceState['choiceResolutions'];
} {
  const { fence } = request;
  if (fence.actionType === 'accept' || fence.actionType === 'batch_accept') {
    const closure = resolveProposalClosure({ graph, selectedProposalIds: fence.selectedProposalIds });
    if (closure.status === 'blocked') fail(closure.reasonCode, 'The proposal closure is no longer actionable.');
    return { closureIds: closure.closureProposalIds, applyIds: closure.applyProposalIds, choiceResolutions: closure.choiceResolutions };
  }
  if (fence.actionType === 'reject' || fence.actionType === 'branch_reject') {
    const rejection = resolveProposalRejection({ graph, proposalId: fence.selectedProposalIds[0]!, mode: fence.actionType === 'reject' ? 'single' : 'branch' });
    if (rejection.status === 'blocked') fail(rejection.reasonCode, 'The proposal is no longer rejectable.');
    return { closureIds: rejection.closureProposalIds, applyIds: [], choiceResolutions: [] };
  }
  const selected = graph.nodes.find((node) => node.proposalId === fence.selectedProposalIds[0]);
  if (!selected || selected.lifecycle !== 'open') fail(Codes.invalidTransition, 'The selected proposal is no longer open.');
  return { closureIds: [selected.proposalId], applyIds: [], choiceResolutions: [] };
}

/**
 * V1 evaluations were single-proposal records. Keep those records usable only
 * for their exact primary proposal; a batch must always carry the new binding.
 */
function assertEvaluationSelection(input: {
  evaluation: ProposalEvaluationV1;
  request: ProposalActionRequestV1;
  shape: ReturnType<typeof actionShape>;
  graphRevision: number;
}): void {
  const { evaluation, request, shape, graphRevision } = input;
  const selectedProposalIds = request.fence.selectedProposalIds;
  const expected = hashProposalEvaluationSelectionV1({
    selectedProposalIds,
    closureProposalIds: shape.closureIds,
    applyProposalIds: shape.applyIds,
    graphRevision,
  });
  if (evaluation.selectionHash !== undefined) {
    if (evaluation.selectionHash !== expected) {
      fail(Codes.candidateChanged, 'The displayed evaluation belongs to a different proposal selection.');
    }
    return;
  }
  if (selectedProposalIds.length !== 1 || request.fence.actionType === 'batch_accept'
    || evaluation.proposalId !== selectedProposalIds[0]) {
    fail(Codes.candidateChanged, 'The displayed evaluation is not bound to this proposal selection.');
  }
}

function expectedState(input: {
  graph: ProposalGraphSnapshotV1;
  current: ProposalCurrentProofV1 | null;
  actor: ActionActor;
  request: ProposalActionRequestV1;
  shape: ReturnType<typeof actionShape>;
}): ProposalFenceState {
  const { shape } = input;
  const { fence } = input.request;
  if (fence.applyProposalIds.join('\u0000') !== shape.applyIds.join('\u0000')
    || fence.choiceResolutions.length !== shape.choiceResolutions.length
    || fence.closure.map((member) => member.proposalId).join('\u0000') !== shape.closureIds.join('\u0000')) {
    fail(Codes.graphChanged, 'The displayed proposal closure no longer matches the graph.');
  }
  if (PROPOSAL_ACTION_RULES_V1[fence.actionType].writesContent && !fence.evaluationId) {
    fail(Codes.candidateChanged, 'A content action requires its displayed evaluation.');
  }
  return {
    scope: input.graph.scope, actor: input.actor, actionType: fence.actionType,
    current: input.current,
    graphRevision: input.graph.graphRevision, evaluationId: fence.evaluationId,
    effectiveCandidateHash: fence.effectiveCandidateHash,
    closure: closureMembers(input.graph, shape.closureIds), selectedProposalIds: fence.selectedProposalIds,
    applyProposalIds: shape.applyIds, choiceResolutions: shape.choiceResolutions,
  };
}

function pendingReceipt(input: { actionId: string; request: ProposalActionRequestV1; now: number }): ProposalActionReceiptV1 {
  return {
    contractVersion: 1, actionId: input.actionId, scope: input.request.fence.scope, actorId: input.request.fence.actor.userId,
    actionType: input.request.fence.actionType, requestDigest: input.request.fence.requestDigest,
    idempotencyKeyHash: hashKey(input.request.idempotencyKey), affectedProposalIds: input.request.fence.closure.map((member) => member.proposalId),
    operationId: null, createdAt: input.now, updatedAt: input.now, phase: 'prepared', result: null, errorCode: null,
  };
}

function resolutions(request: Pick<ProposalActionRequestV1, 'fence'>): Array<{ proposalId: string; lifecycle: ResolvedLifecycle }> {
  const { fence } = request;
  if (fence.actionType === 'accept' || fence.actionType === 'batch_accept') {
    const selected = new Set(fence.selectedProposalIds);
    return [
      ...fence.applyProposalIds.map((proposalId) => ({ proposalId, lifecycle: selected.has(proposalId) ? 'applied' as const : 'included' as const })),
      ...fence.choiceResolutions.flatMap((choice) => choice.closingProposalIds.map((proposalId) => ({ proposalId, lifecycle: 'alternative_not_selected' as const }))),
    ];
  }
  const lifecycle: Partial<Record<ProposalActionRequestV1['fence']['actionType'], ResolvedLifecycle>> = {
    reject: 'rejected', branch_reject: 'rejected', replace: 'superseded', complete_satisfied: 'satisfied_elsewhere',
  };
  const ids = fence.actionType === 'branch_reject' ? fence.closure.map((member) => member.proposalId) : fence.selectedProposalIds;
  return lifecycle[fence.actionType] ? ids.map((proposalId) => ({ proposalId, lifecycle: lifecycle[fence.actionType]! })) : [];
}

/**
 * FVRC-1004 domain boundary. It does not expose a route or turn on proposal tools.
 * Runtime integration supplies authorization/current proof and the one existing durable
 * collaboration apply implementation; all graph transitions stay behind its graph lock.
 */
export function createProposalActionOrchestrator(dependencies: ProposalActionOrchestratorDependencies) {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? randomUUID;
  return {
    async execute(value: unknown): Promise<ProposalActionReceiptV1> {
      const request = parseProposalActionRequestV1(value);
      if (request.fence.actionType === 'rebase') {
        fail(Codes.upgradeRequired, 'Rebase actions require the graph-aware evaluation service.');
      }
      const actionId = createId();
      const initial = pendingReceipt({ actionId, request, now: now() });
      const prepared = await dependencies.withLockedGraph(request.fence.scope, { actionId }, async (transaction, sql) => {
        // reserveAction resolves an exact durable retry before expiry/fence work. If this
        // is a new request and verification fails, the surrounding transaction rolls back.
        const reserved = await transaction.reserveAction(initial, { fence: request.fence, creation: request.creation });
        if (reserved.actionId !== actionId) return { receipt: reserved, current: null as ProposalCurrentProofV1 | null,
          graph: null as ProposalGraphSnapshotV1 | null, candidate: null as DurableCandidate | null };
        if (reserved.phase !== 'prepared' || reserved.result !== null) {
          fail(Codes.recoveryRequired, 'A newly reserved action did not start in the prepared phase.');
        }
        const graph = await transaction.loadGraph({ includeProposalIds: request.fence.closure.map((member) => member.proposalId) });
        if (!sameScope(graph.scope, request.fence.scope)) fail(Codes.scopeMismatch, 'The graph scope changed.');
        const actor = await dependencies.authorize({ scope: graph.scope, proposalIds: request.fence.closure.map((member) => member.proposalId), actionType: request.fence.actionType });
        const current = ['reject', 'branch_reject'].includes(request.fence.actionType)
          ? null : await dependencies.readCurrent(graph.scope);
        const shape = actionShape(graph, request);
        const expected = expectedState({ graph, current, actor, request, shape });
        verifyProposalActionFence({ fence: request.fence, token: request.fenceToken, expected, creation: request.creation,
          secret: dependencies.signingSecret, now: now() });
        let candidate: DurableCandidate | null = null;
        if (request.fence.evaluationId) {
          const evaluation = await transaction.getEvaluation(request.fence.evaluationId);
          const evaluationRule = PROPOSAL_ACTION_RULES_V1[request.fence.actionType].evaluation;
          if (!evaluation || evaluation.graphRevision !== graph.graphRevision || evaluation.expiresAt <= now()
            || !current || evaluation.current.fullStateHash !== current.fullStateHash || evaluation.effectiveCandidate?.sha256 !== request.fence.effectiveCandidateHash
            || (evaluationRule !== 'any' && !(evaluationRule as readonly string[]).includes(evaluation.status))) {
            fail(Codes.candidateChanged, 'The displayed proposal evaluation is no longer current.');
          }
          assertEvaluationSelection({ evaluation, request, shape, graphRevision: graph.graphRevision });
          if (PROPOSAL_ACTION_RULES_V1[request.fence.actionType].writesContent) {
            if (!evaluation.effectiveCandidate) fail(Codes.candidateChanged, 'The approved candidate artifact is unavailable.');
            candidate = { evaluation, update: await transaction.readArtifact(evaluation.effectiveCandidate) };
          }
        }
        if (PROPOSAL_ACTION_RULES_V1[request.fence.actionType].writesContent) {
          if (!current || !candidate) fail(Codes.candidateChanged, 'The approved candidate artifact is unavailable.');
          const operationIds = request.fence.applyProposalIds.map((id) => graph.nodes.find((node) => node.proposalId === id)!.operationId);
          await dependencies.prepareDurably({ transaction: sql, scope: graph.scope, actionId,
            proposalIds: request.fence.applyProposalIds, operationIds, current, candidate });
          const applying = { ...reserved, operationId: actionId, phase: 'applying' as const, updatedAt: now() };
          await transaction.advanceAction(applying);
          return { receipt: applying, current, graph, candidate };
        }
        return { receipt: reserved, current, graph, candidate };
      });
      if (prepared.receipt.actionId !== actionId) return prepared.receipt;
      if (!prepared.graph) return prepared.receipt;

      const contentAction = PROPOSAL_ACTION_RULES_V1[request.fence.actionType].writesContent;
      if (!contentAction) return finalizeMetadata({ dependencies, request, actionId, receipt: prepared.receipt, now: now() });
      if (!prepared.current || !prepared.candidate) fail(Codes.candidateChanged, 'The approved candidate artifact is unavailable.');
      if (prepared.receipt.phase !== 'applying' || prepared.receipt.operationId !== actionId) return prepared.receipt;
      // The action ID is the one durable collaboration-operation identity. Proposal
      // source operation IDs are provenance only and never become a compound key.
      const applying = prepared.receipt;
      let durable: DurableContentResult;
      try {
        durable = await dependencies.applyDurably({ scope: request.fence.scope, actionId, proposalIds: request.fence.applyProposalIds,
          operationIds: request.fence.applyProposalIds.map((id) => prepared.graph!.nodes.find((node) => node.proposalId === id)!.operationId),
          current: prepared.current, candidate: prepared.candidate });
      } catch (error) {
        if (error instanceof ProposalActionDefinitelyUnappliedError) {
          return failDefinitelyUnapplied({ dependencies, scope: request.fence.scope, actionId,
            requestDigest: request.fence.requestDigest, errorCode: error.code, now: now() });
        }
        // The live operation might have crossed its durability boundary. Leave an explicit
        // recovery receipt; never mark graph statuses as failed or partially applied.
        await dependencies.withLockedGraph(request.fence.scope, { actionId }, async (transaction) => {
          await transaction.advanceAction({ ...applying, phase: 'recovery_required', updatedAt: now(), errorCode: Codes.recoveryRequired });
        });
        throw new ProposalGraphContractError(Codes.recoveryRequired, 'Durable proposal apply requires recovery confirmation.');
      }
      return finalizeDurableContent({ dependencies, request, actionId, durable, now: now() });
    },

    /**
     * Completes a previously reserved content action from durable evidence only.
     * It deliberately has no path back to applyDurably, so a restart can never
     * repeat an uncertain Yjs mutation.
     */
    async recover(scope: ProposalDocumentScopeV1, actionId: string): Promise<ProposalActionReceiptV1> {
      if (!dependencies.recoverDurably) fail(Codes.upgradeRequired, 'Proposal action recovery is unavailable.');
      return recoverProposalAction({
        withLockedGraph: dependencies.withLockedGraph,
        recoverDurably: dependencies.recoverDurably,
        now,
      }, scope, actionId);
    },
  };
}

/** Internal restart entrypoint. It proves durable state and never calls a live apply path. */
export async function recoverProposalAction(
  dependencies: ProposalActionRecoveryDependencies,
  scope: ProposalDocumentScopeV1,
  actionId: string,
): Promise<ProposalActionReceiptV1> {
  const now = dependencies.now ?? Date.now;
  const pending = await dependencies.withLockedGraph(scope, { actionId }, async (transaction) => {
    const receipt = await transaction.getAction(actionId);
    const request = await transaction.getActionRequest(actionId);
    if (!receipt || !request || !sameScope(receipt.scope, scope) || receipt.actionId !== actionId
      || receipt.requestDigest !== request.fence.requestDigest) {
      fail(Codes.recoveryRequired, 'The durable proposal action receipt is unavailable.');
    }
    if (receipt.phase === 'succeeded') return { receipt, request, candidate: null as DurableCandidate | null };
    if (!['applying', 'awaiting_durability', 'recovery_required'].includes(receipt.phase)
      || receipt.operationId !== actionId || !PROPOSAL_ACTION_RULES_V1[receipt.actionType].writesContent
      || !request.fence.evaluationId || !request.fence.current) {
      fail(Codes.recoveryRequired, 'The proposal action cannot be recovered without a pinned content receipt.');
    }
    const evaluation = await transaction.getEvaluation(request.fence.evaluationId);
    if (!evaluation?.effectiveCandidate
      || evaluation.effectiveCandidate.sha256 !== request.fence.effectiveCandidateHash) {
      fail(Codes.recoveryRequired, 'The proposal action candidate is unavailable for recovery.');
    }
    return {
      receipt,
      request,
      candidate: { evaluation, update: await transaction.readArtifact(evaluation.effectiveCandidate) },
    };
  });
  if (pending.receipt.phase === 'succeeded') return pending.receipt;
  if (!pending.candidate || !pending.request.fence.current) {
    fail(Codes.recoveryRequired, 'The proposal action candidate is unavailable for recovery.');
  }
  const graph = await dependencies.withLockedGraph(scope, { actionId }, (transaction) => transaction.loadGraph({
    includeProposalIds: pending.request.fence.closure.map((member) => member.proposalId),
  }));
  const operationIds = pending.request.fence.applyProposalIds.map((proposalId) => {
    const node = graph.nodes.find((candidate) => candidate.proposalId === proposalId);
    if (!node) fail(Codes.recoveryRequired, 'A proposal operation is unavailable for recovery.');
    return node.operationId;
  });
  let durable: DurableContentResult;
  try {
    durable = await dependencies.recoverDurably({
      scope,
      actionId,
      proposalIds: pending.request.fence.applyProposalIds,
      operationIds,
      current: pending.request.fence.current,
      candidate: pending.candidate,
    });
  } catch (error) {
    if (error instanceof ProposalActionDefinitelyUnappliedError) {
      return failDefinitelyUnapplied({ dependencies, scope, actionId,
        requestDigest: pending.request.fence.requestDigest, errorCode: error.code, now: now() });
    }
    throw error;
  }
  return finalizeDurableContent({ dependencies, request: pending.request, actionId, durable, now: now() });
}

async function failDefinitelyUnapplied(input: {
  dependencies: Pick<ProposalActionOrchestratorDependencies, 'withLockedGraph'>;
  scope: ProposalDocumentScopeV1;
  actionId: string;
  requestDigest: string;
  errorCode: ProposalGraphErrorCode;
  now: number;
}): Promise<ProposalActionReceiptV1> {
  return input.dependencies.withLockedGraph(input.scope, { actionId: input.actionId }, async (transaction) => {
    let receipt = await transaction.getAction(input.actionId);
    const request = await transaction.getActionRequest(input.actionId);
    if (!receipt || !request || receipt.requestDigest !== input.requestDigest
      || request.fence.requestDigest !== input.requestDigest) {
      fail(Codes.recoveryRequired, 'The unapplied proposal action receipt changed before finalization.');
    }
    if (receipt.phase === 'failed' || receipt.phase === 'succeeded') return receipt;
    if (!['applying', 'awaiting_durability', 'recovery_required'].includes(receipt.phase)) {
      fail(Codes.recoveryRequired, 'The proposal action cannot be released from its current phase.');
    }
    if (receipt.phase !== 'recovery_required') {
      receipt = { ...receipt, phase: 'recovery_required', updatedAt: input.now, errorCode: Codes.recoveryRequired };
      await transaction.advanceAction(receipt);
    }
    const failed: ProposalActionReceiptV1 = {
      ...receipt,
      phase: 'failed',
      updatedAt: input.now,
      result: null,
      errorCode: input.errorCode,
    };
    await transaction.advanceAction(failed);
    return failed;
  });
}

async function finalizeDurableContent(input: {
  dependencies: Pick<ProposalActionOrchestratorDependencies, 'withLockedGraph'>;
  request: Pick<ProposalActionRequestV1, 'fence' | 'creation'>;
  actionId: string;
  durable: DurableContentResult;
  now: number;
}): Promise<ProposalActionReceiptV1> {
  return input.dependencies.withLockedGraph(input.request.fence.scope, { actionId: input.actionId }, async (transaction) => {
    let receipt = await transaction.getAction(input.actionId);
    const storedRequest = await transaction.getActionRequest(input.actionId);
    if (!receipt || !storedRequest || receipt.requestDigest !== input.request.fence.requestDigest
      || storedRequest.fence.requestDigest !== input.request.fence.requestDigest) {
      fail(Codes.recoveryRequired, 'The durable proposal action receipt changed before finalization.');
    }
    if (receipt.phase === 'succeeded') return receipt;
    if (input.durable.operationId !== input.actionId || receipt.operationId !== input.actionId
      || !['applying', 'awaiting_durability', 'recovery_required'].includes(receipt.phase)) {
      fail(Codes.recoveryRequired, 'Durable apply did not retain the reserved action identity.');
    }
    if (receipt.phase !== 'awaiting_durability') {
      receipt = { ...receipt, phase: 'awaiting_durability', updatedAt: input.now, errorCode: null };
      await transaction.advanceAction(receipt);
    }
    const result = {
      kind: 'content_changed' as const,
      revisionId: input.durable.revisionId,
      current: input.durable.current,
      createdProposalIds: [],
      resolutions: resolutions(input.request),
    };
    await transitionResolutions(transaction, input.request, result.resolutions);
    const succeeded: ProposalActionReceiptV1 = {
      ...receipt,
      phase: 'succeeded',
      updatedAt: input.now,
      result,
      errorCode: null,
    };
    await transaction.advanceAction(succeeded);
    await transaction.bindRevision(input.durable.revisionId, input.actionId, result.resolutions
      .filter((item) => item.lifecycle === 'applied' || item.lifecycle === 'included')
      .map((item, applicationOrder) => ({
        proposalId: item.proposalId,
        resolution: item.lifecycle as 'applied' | 'included',
        applicationOrder,
      })));
    return succeeded;
  });
}

async function transitionResolutions(transaction: ProposalGraphStorageTransaction, request: Pick<ProposalActionRequestV1, 'fence'>, entries: Array<{ proposalId: string; lifecycle: ResolvedLifecycle }>) {
  const graph = await transaction.loadGraph({ includeProposalIds: entries.map((entry) => entry.proposalId) });
  const nodes = new Map(graph.nodes.map((node) => [node.proposalId, node]));
  for (const entry of entries) {
    const node = nodes.get(entry.proposalId);
    if (!node || node.lifecycle !== 'open') fail(Codes.graphChanged, 'A proposal changed while its action was in progress.');
    await transaction.transitionProposal(entry.proposalId, node.casVersion, entry.lifecycle);
  }
  for (const choice of request.fence.choiceResolutions) {
    const group = graph.choiceGroups.find((candidate) => candidate.groupId === choice.groupId);
    if (!group || group.groupRevision !== choice.groupRevision) fail(Codes.graphChanged, 'A choice group changed while its action was in progress.');
    await transaction.putChoiceGroup({ ...group, groupRevision: group.groupRevision + 1, chosenProposalId: choice.chosenProposalId }, group.groupRevision);
  }
}

async function finalizeMetadata(input: { dependencies: ProposalActionOrchestratorDependencies; request: ProposalActionRequestV1; actionId: string; receipt: ProposalActionReceiptV1; now: number }): Promise<ProposalActionReceiptV1> {
  return input.dependencies.withLockedGraph(input.request.fence.scope, { actionId: input.actionId }, async (transaction, sql) => {
      const created = input.request.creation ? await input.dependencies.materializeCreation({ creation: input.request.creation,
        actorId: input.request.fence.actor.actorId, now: input.now, transaction, sql }) : null;
    const result = { kind: 'metadata_only' as const, revisionId: null, current: null, createdProposalIds: created ? [created.proposalId] : [], resolutions: resolutions(input.request) };
    await transitionResolutions(transaction, input.request, result.resolutions);
    if (created) await transaction.insertProposal(created);
    const succeeded: ProposalActionReceiptV1 = { ...input.receipt, phase: 'succeeded', updatedAt: input.now, result, errorCode: null };
    await transaction.advanceAction(succeeded);
    return succeeded;
  });
}
