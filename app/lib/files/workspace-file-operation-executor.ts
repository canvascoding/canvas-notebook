import 'server-only';

import { createHash } from 'node:crypto';

import type { WorkspaceFileOperationPreview } from '@/app/lib/markdown/workspace-file-operation-planner';
import type { WorkspaceLinkWritePreflight } from '@/app/lib/markdown/workspace-link-write-executor';
import { groupWorkspaceLinkWrites, type WorkspaceLinkWriteGroup } from '@/app/lib/markdown/workspace-link-write-groups';
import type {
  WorkspaceOperationActor,
  WorkspaceOperationJournal,
  WorkspaceOperationRequest,
  WorkspaceOperationStepRecord,
  WorkspaceOperationWithSteps,
} from './workspace-operation-journal';
import type { WorkspaceOperationStage, WorkspaceOperationStaging } from './workspace-operation-staging';

export type WorkspaceOperationProbe = 'before' | 'after' | 'unknown';
export type WorkspaceOperationExecutionStatus = 'complete' | 'needs_recovery' | 'failed';

export type WorkspaceOperationExecutionResult = {
  operationId: string;
  planId: string;
  status: WorkspaceOperationExecutionStatus;
  completedSteps: string[];
  pendingSteps: string[];
  errorCode: string | null;
};

type StageIdentity = WorkspaceOperationStage['identity'];
type OriginalDocument = WorkspaceOperationStage['originalDocuments'][number];
type PathSelection = WorkspaceOperationRequest['selections'][number];
type JournalPort = Pick<WorkspaceOperationJournal,
  'get' | 'prepare' | 'beginStep' | 'finishStep' | 'complete' | 'fail' | 'resume'>;
type StagingPort = Pick<WorkspaceOperationStaging, 'stage' | 'load' | 'removeCompleted'>;

export type WorkspaceOperationExecutorAdapters = {
  /** Rebuild from authoritative state while the caller holds all workspace locks. */
  rebuildPlan: (input: {
    request: WorkspaceOperationRequest;
    preview: WorkspaceFileOperationPreview;
    sourceWorkspaceId: string;
    destinationWorkspaceId: string;
  }) => Promise<WorkspaceFileOperationPreview>;
  path: {
    /** Compare path identities, not mutable Markdown content. */
    probe: (stage: WorkspaceOperationStage, evidence: { pathReceiptApplied: boolean }) => Promise<WorkspaceOperationProbe>;
    /** Must recheck its own preconditions and return a durable-service receipt after mutation. */
    apply: (stage: WorkspaceOperationStage) => Promise<Record<string, unknown>>;
    /** Copy selections are journaled independently; never replay a whole batch. */
    probeSelection?: (stage: WorkspaceOperationStage, selection: PathSelection,
      evidence: { pathReceiptApplied: boolean }) => Promise<WorkspaceOperationProbe>;
    applySelection?: (stage: WorkspaceOperationStage, selection: PathSelection) => Promise<Record<string, unknown>>;
  };
  links: {
    /** Check original content/Yjs fences before staging and any path mutation. */
    preflight: (stage: WorkspaceOperationStage) => Promise<WorkspaceLinkWritePreflight | null>;
    /** Read the authoritative final-path content, including a live Yjs room. */
    probe: (group: WorkspaceLinkWriteGroup, stage: WorkspaceOperationStage) => Promise<WorkspaceOperationProbe>;
    /** Must recheck the live before fence inside its own atomic write boundary. */
    apply: (group: WorkspaceLinkWriteGroup, stage: WorkspaceOperationStage) => Promise<void>;
  };
};

export type ExecuteWorkspaceFileOperationInput = {
  operationId: string;
  actor: WorkspaceOperationActor;
  request: WorkspaceOperationRequest;
  preview: WorkspaceFileOperationPreview;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  originalDocuments: ReadonlyArray<OriginalDocument>;
};

export class WorkspaceOperationExecutorConflictError extends Error {
  readonly status = 409;
  constructor(readonly code: 'PLAN_STALE' | 'OPERATION_ID_CONFLICT', message: string) {
    super(message);
    this.name = 'WorkspaceOperationExecutorConflictError';
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function pathFences(preview: WorkspaceFileOperationPreview): { beforeFence: string; afterFence: string } {
  return {
    beforeFence: digest({ planId: preview.planId, state: 'before', paths: preview.expectedPathState }),
    afterFence: digest({ planId: preview.planId, state: 'after', mappings: preview.pathMappings }),
  };
}

function copyPathStepKey(identity: StageIdentity, selection: PathSelection): string {
  return `path:${digest([identity.sourceWorkspaceId, selection.sourcePath,
    identity.destinationWorkspaceId, selection.destinationPath])}`;
}

function pathSteps(identity: StageIdentity, request: WorkspaceOperationRequest,
  preview: WorkspaceFileOperationPreview): Array<{
    key: string; selection: PathSelection | null; beforeFence: string; afterFence: string;
  }> {
  if (request.kind !== 'copy') return [{ key: 'path:all', selection: null, ...pathFences(preview) }];
  return request.selections.map((selection) => ({
    key: copyPathStepKey(identity, selection), selection,
    beforeFence: digest({ planId: preview.planId, selection, state: 'before' }),
    afterFence: digest({ planId: preview.planId, selection, state: 'after' }),
  }));
}

function linkStepKey(group: WorkspaceLinkWriteGroup): string {
  return `link:${digest([group.workspaceId, group.path])}`;
}

function stepKeys(identity: StageIdentity, groups: WorkspaceLinkWriteGroup[], record: WorkspaceOperationWithSteps | null): string[] {
  if (record?.status === 'completed' && record.steps.length > 0) return record.steps.map((step) => step.stepKey);
  if (record) {
    try {
      const request = JSON.parse(record.requestJson) as WorkspaceOperationRequest;
      if (request.kind === 'copy' && Array.isArray(request.selections)) {
        return [...request.selections.map((selection) => copyPathStepKey(identity, selection)), ...groups.map(linkStepKey)];
      }
    } catch { /* A corrupt journal request is handled by drive(). */ }
  }
  return ['path:all', ...groups.map(linkStepKey)];
}

function assertLinkPreflight(stage: WorkspaceOperationStage, groups: WorkspaceLinkWriteGroup[]): void {
  const fences = stage.linkPreflight;
  if (groups.length === 0 && fences === null) return;
  if (!fences || fences.planId !== stage.identity.planId || !Array.isArray(fences.sources)
    || fences.sources.length !== groups.length) {
    throw new Error('MISSING_SOURCE_DOCUMENT_FENCES');
  }
  for (const [index, group] of groups.entries()) {
    const source = fences.sources[index];
    if (!source || source.sourceWorkspaceId !== group.sourceWorkspaceId
      || source.sourcePathBefore !== group.sourcePathBefore || source.beforeSha256 !== group.beforeSha256
      || (source.mode !== 'active-yjs' && source.mode !== 'plain-file')
      || (source.mode === 'active-yjs' && !source.documentId)
      || (source.mode === 'plain-file' && source.documentId !== null)) {
      throw new Error('SOURCE_DOCUMENT_FENCE_MISMATCH');
    }
  }
}

function result(
  identity: StageIdentity,
  groups: WorkspaceLinkWriteGroup[],
  status: WorkspaceOperationExecutionStatus,
  record: WorkspaceOperationWithSteps | null,
  errorCode: string | null,
): WorkspaceOperationExecutionResult {
  const applied = new Set(record?.steps.filter((step) => step.status === 'applied').map((step) => step.stepKey) ?? []);
  const keys = stepKeys(identity, groups, record);
  return {
    operationId: identity.operationId,
    planId: identity.planId,
    status,
    completedSteps: keys.filter((key) => applied.has(key)),
    pendingSteps: keys.filter((key) => !applied.has(key)),
    errorCode,
  };
}

function isSameRequest(actual: WorkspaceOperationWithSteps, input: ExecuteWorkspaceFileOperationInput): boolean {
  let durableRequest: WorkspaceOperationRequest;
  try {
    durableRequest = JSON.parse(actual.requestJson) as WorkspaceOperationRequest;
  } catch {
    return false;
  }
  return actual.planId === input.preview.planId
    && actual.sourceWorkspaceId === input.sourceWorkspaceId
    && actual.destinationWorkspaceId === input.destinationWorkspaceId
    && actual.actor.type === input.actor.type
    && actual.actor.id === input.actor.id
    && durableRequest.kind === input.request.kind
    && durableRequest.selections.length === input.request.selections.length
    && durableRequest.selections.every((selection, index) =>
      selection.sourcePath === input.request.selections[index].sourcePath
      && selection.destinationPath === input.request.selections[index].destinationPath);
}

function stepByKey(record: WorkspaceOperationWithSteps, key: string): WorkspaceOperationStepRecord | undefined {
  return record.steps.find((step) => step.stepKey === key);
}

/** Orchestrates durable intents; the caller owns ordered workspace locks and authorization. */
export function createWorkspaceFileOperationExecutor(input: {
  journal: JournalPort;
  staging: StagingPort;
  adapters: WorkspaceOperationExecutorAdapters;
}) {
  const { journal, staging, adapters } = input;

  const failRecoverably = async (
    identity: StageIdentity,
    groups: WorkspaceLinkWriteGroup[],
    errorCode: string,
  ): Promise<WorkspaceOperationExecutionResult> => {
    let current = await journal.get(identity.operationId).catch(() => null);
    if (current && current.status !== 'completed' && current.status !== 'recovery_required') {
      await journal.fail({ operationId: identity.operationId, errorCode, recoveryRequired: true }).catch(() => undefined);
      current = await journal.get(identity.operationId).catch(() => current);
    }
    return result(identity, groups, current?.status === 'completed' ? 'complete' : 'needs_recovery', current,
      current?.status === 'completed' ? null : errorCode);
  };

  const ensureStep = async (params: {
    identity: StageIdentity;
    stage: WorkspaceOperationStage;
    record: WorkspaceOperationWithSteps;
    key: string;
    phase: 'path' | 'link';
    beforeFence: string;
    afterFence: string;
    probe: (receiptApplied: boolean) => Promise<WorkspaceOperationProbe>;
    apply: () => Promise<Record<string, unknown>>;
  }): Promise<WorkspaceOperationWithSteps> => {
    const existing = stepByKey(params.record, params.key);
    const observed = await params.probe(existing?.status === 'applied' && existing.receiptJson !== null);
    if (observed === 'unknown' || (existing?.status === 'applied' && observed !== 'after')
      || (!existing && params.phase === 'path' && observed !== 'before')) {
      throw new Error(`UNPROVEN_${params.phase.toUpperCase()}_STATE`);
    }
    if (existing && (existing.phase !== params.phase || existing.beforeFence !== params.beforeFence
      || existing.afterFence !== params.afterFence || existing.backupRef !== params.identity.operationId)) {
      throw new Error('JOURNAL_STEP_FENCE_MISMATCH');
    }
    if (existing?.status === 'applied') return params.record;
    if (!existing) {
      await journal.beginStep({ operationId: params.identity.operationId, stepKey: params.key,
        phase: params.phase, beforeFence: params.beforeFence, afterFence: params.afterFence,
        backupRef: params.identity.operationId });
    }
    let receipt: Record<string, unknown> = { stepKey: params.key, observed: 'after' };
    if (observed === 'before') {
      receipt = await params.apply();
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('MISSING_MUTATION_RECEIPT');
      if (await params.probe(true) !== 'after') throw new Error(`UNPROVEN_${params.phase.toUpperCase()}_RESULT`);
    } else if (params.phase === 'path') {
      // A path intent without a persisted service receipt cannot prove projected metadata/Yjs state.
      throw new Error('UNPROVEN_PATH_RECEIPT');
    }
    await journal.finishStep({ operationId: params.identity.operationId, stepKey: params.key,
      beforeFence: params.beforeFence, afterFence: params.afterFence,
      receipt });
    const updated = await journal.get(params.identity.operationId);
    if (!updated) throw new Error('JOURNAL_STEP_MISSING');
    return updated;
  };

  const drive = async (stage: WorkspaceOperationStage, record: WorkspaceOperationWithSteps): Promise<WorkspaceOperationExecutionResult> => {
    const { identity, preview } = stage;
    const groups = groupWorkspaceLinkWrites(preview);
    if (record.planId !== identity.planId || record.sourceWorkspaceId !== identity.sourceWorkspaceId
      || record.destinationWorkspaceId !== identity.destinationWorkspaceId) {
      throw new WorkspaceOperationExecutorConflictError('OPERATION_ID_CONFLICT', 'Journal and staged plan differ.');
    }
    if (record.status === 'completed') return result(identity, groups, 'complete', record, null);
    if (record.status === 'failed') return result(identity, groups, 'failed', record, record.errorCode);

    try {
      assertLinkPreflight(stage, groups);
      const request = JSON.parse(record.requestJson) as WorkspaceOperationRequest;
      if (!request || request.kind !== preview.kind || !Array.isArray(request.selections)
        || request.selections.length < 1) throw new Error('JOURNAL_REQUEST_INVALID');
      const plannedPaths = pathSteps(identity, request, preview);
      if (request.kind === 'copy' && record.steps.some((step) => step.stepKey === 'path:all')) {
        throw new Error('LEGACY_COPY_PATH_STEP_REQUIRES_MANUAL_RECOVERY');
      }
      if (record.expectedStepCount !== plannedPaths.length + groups.length) {
        throw new Error('JOURNAL_STEP_COUNT_MISMATCH');
      }
      const probePath = (pathStep: (typeof plannedPaths)[number], receiptApplied: boolean) => {
        if (pathStep.selection) {
          if (!adapters.path.probeSelection) throw new Error('COPY_SELECTION_PROBE_REQUIRED');
          return adapters.path.probeSelection(stage, pathStep.selection, { pathReceiptApplied: receiptApplied });
        }
        return adapters.path.probe(stage, { pathReceiptApplied: receiptApplied });
      };
      if (record.status === 'recovery_required') {
        // Prove all existing receipts and pending intents before reopening the journal.
        let allPathsAfter = true;
        for (const pathStep of plannedPaths) {
          const journalStep = stepByKey(record, pathStep.key);
          const pathState = await probePath(pathStep,
            journalStep?.status === 'applied' && journalStep.receiptJson !== null);
          if (pathState === 'unknown' || (journalStep?.status === 'applied' && pathState !== 'after')
            || (!journalStep && pathState !== 'before')) throw new Error('UNPROVEN_PATH_STATE');
          if (pathState !== 'after') allPathsAfter = false;
        }
        if (allPathsAfter) {
          for (const group of groups) {
            const observed = await adapters.links.probe(group, stage);
            const step = stepByKey(record, linkStepKey(group));
            if (observed === 'unknown' || (step?.status === 'applied' && observed !== 'after')) {
              throw new Error('UNPROVEN_LINK_STATE');
            }
          }
        }
        await journal.resume({ operationId: identity.operationId, expectedRevision: record.revision });
        record = (await journal.get(identity.operationId))!;
      }

      for (const pathStep of plannedPaths) {
        record = await ensureStep({ identity, stage, record, key: pathStep.key, phase: 'path',
          beforeFence: pathStep.beforeFence, afterFence: pathStep.afterFence,
          probe: (pathReceiptApplied) => probePath(pathStep, pathReceiptApplied),
          apply: () => {
            if (pathStep.selection) {
              if (!adapters.path.applySelection) throw new Error('COPY_SELECTION_APPLY_REQUIRED');
              return adapters.path.applySelection(stage, pathStep.selection);
            }
            return adapters.path.apply(stage);
          } });
      }
      for (const group of groups) {
        record = await ensureStep({ identity, stage, record, key: linkStepKey(group), phase: 'link',
          beforeFence: group.beforeSha256, afterFence: group.afterSha256,
          probe: () => adapters.links.probe(group, stage),
          apply: async () => { await adapters.links.apply(group, stage); return { stepKey: linkStepKey(group), observed: 'after' }; } });
      }
      await journal.complete(identity.operationId);
      record = (await journal.get(identity.operationId))!;
      await staging.removeCompleted(identity).catch(() => undefined);
      return result(identity, groups, 'complete', record, null);
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 128) : 'OPERATION_STEP_FAILED';
      return failRecoverably(identity, groups, code);
    }
  };

  const recover = async (identity: StageIdentity): Promise<WorkspaceOperationExecutionResult> => {
    const record = await journal.get(identity.operationId);
    if (!record || record.planId !== identity.planId
      || record.sourceWorkspaceId !== identity.sourceWorkspaceId
      || record.destinationWorkspaceId !== identity.destinationWorkspaceId) {
      throw new WorkspaceOperationExecutorConflictError('OPERATION_ID_CONFLICT', 'Operation journal identity is missing or different.');
    }
    if (record.status === 'completed') {
      const groups = await staging.load(identity).then((stage) => groupWorkspaceLinkWrites(stage.preview)).catch(() => []);
      await staging.removeCompleted(identity).catch(() => undefined);
      return result(identity, groups, 'complete', record, null);
    }
    let stage: WorkspaceOperationStage;
    try {
      stage = await staging.load(identity);
    } catch {
      const failed = await failRecoverably(identity, [], 'STAGE_LOAD_FAILED');
      return { ...failed, pendingSteps: ['staging:load'] };
    }
    return drive(stage, record);
  };

  return {
    async execute(operation: ExecuteWorkspaceFileOperationInput): Promise<WorkspaceOperationExecutionResult> {
      const identity: StageIdentity = { operationId: operation.operationId, planId: operation.preview.planId,
        sourceWorkspaceId: operation.sourceWorkspaceId, destinationWorkspaceId: operation.destinationWorkspaceId };
      const groups = groupWorkspaceLinkWrites(operation.preview);
      const existing = await journal.get(operation.operationId);
      if (existing) {
        if (!isSameRequest(existing, operation)) {
          throw new WorkspaceOperationExecutorConflictError('OPERATION_ID_CONFLICT', 'Operation ID belongs to a different request.');
        }
        return recover(identity);
      }
      try {
        const rebuilt = await adapters.rebuildPlan({ request: operation.request, preview: operation.preview,
          sourceWorkspaceId: operation.sourceWorkspaceId, destinationWorkspaceId: operation.destinationWorkspaceId });
        if (rebuilt.planId !== operation.preview.planId || rebuilt.readiness !== 'ready') {
          throw new WorkspaceOperationExecutorConflictError('PLAN_STALE', 'Workspace operation plan changed before apply.');
        }
        const unstaged: WorkspaceOperationStage = { identity, preview: rebuilt,
          originalDocuments: [...operation.originalDocuments], payloadSha256: '',
          linkPreflight: null };
        for (const pathStep of pathSteps(identity, operation.request, rebuilt)) {
          const observed = pathStep.selection
            ? await adapters.path.probeSelection?.(unstaged, pathStep.selection, { pathReceiptApplied: false })
            : await adapters.path.probe(unstaged, { pathReceiptApplied: false });
          if (observed !== 'before') {
            throw new WorkspaceOperationExecutorConflictError('PLAN_STALE', 'Workspace paths changed before apply.');
          }
        }
        const linkPreflight = await adapters.links.preflight(unstaged);
        assertLinkPreflight({ ...unstaged, linkPreflight }, groups);
        const stage = await staging.stage({ operationId: operation.operationId, preview: rebuilt,
          sourceWorkspaceId: operation.sourceWorkspaceId, destinationWorkspaceId: operation.destinationWorkspaceId,
          originalDocuments: operation.originalDocuments, linkPreflight });
        await journal.prepare({ operationId: operation.operationId, planId: rebuilt.planId,
          request: operation.request, actor: operation.actor, sourceWorkspaceId: operation.sourceWorkspaceId,
          destinationWorkspaceId: operation.destinationWorkspaceId,
          expectedStepCount: pathSteps(identity, operation.request, rebuilt).length + groups.length });
        const record = await journal.get(operation.operationId);
        if (!record) throw new Error('JOURNAL_PREPARE_MISSING');
        return drive(stage, record);
      } catch (error) {
        const record = await journal.get(operation.operationId).catch(() => null);
        if (record) return failRecoverably(identity, groups,
          error instanceof Error ? error.message.slice(0, 128) : 'OPERATION_PREPARE_FAILED');
        return result(identity, groups, 'failed', null,
          error instanceof Error ? error.message.slice(0, 128) : 'OPERATION_PREPARE_FAILED');
      }
    },

    recover,
  };
}
