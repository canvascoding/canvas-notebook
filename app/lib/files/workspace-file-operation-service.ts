import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { copyFileBetweenWorkspaces, readFile, withWorkspaceCopyMutationLocks,
  type WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import { assertFreshWorkspaceFileOperationPlan, buildWorkspaceFileOperationPreview,
  WorkspacePreviewBlockedError, WorkspacePreviewStaleError } from '@/app/lib/markdown/workspace-file-operation-preview';
import type { WorkspaceFileOperationPreview } from '@/app/lib/markdown/workspace-file-operation-planner';
import { isWorkspaceFileOperationLinkSafe } from '@/app/lib/markdown/workspace-file-operation-link-safety';
import { groupWorkspaceLinkWrites } from '@/app/lib/markdown/workspace-link-write-groups';
import { applyWorkspaceLinkWriteGroup, preflightWorkspaceLinkWrites,
  probeWorkspaceLinkWriteGroup, type WorkspaceLinkWriteExecutorInput } from '@/app/lib/markdown/workspace-link-write-executor';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';
import { withWorkspaceFileLifecycleGuards } from './workspace-file-lifecycle-guard';
import { initializeCopiedFileCollaborationPaths } from './collaboration-policy';
import { observeWorkspaceOperation, type WorkspaceOperationMetricPhase } from './workspace-operation-observability';
import { captureWorkspaceOperationBackup } from './workspace-operation-backup';
import { createWorkspaceFileOperationExecutor, type WorkspaceOperationExecutionResult } from './workspace-file-operation-executor';
import { WorkspaceOperationJournal, type WorkspaceOperationRequest } from './workspace-operation-journal';
import { probeWorkspacePathOperation, probeWorkspacePathSelectionOperation } from './workspace-operation-path-probe';
import { WorkspaceOperationStaging, type WorkspaceOperationStage } from './workspace-operation-staging';
import { renameWorkspacePath, type WorkspacePathRenameResult } from './rename-service';

type Selection = { sourcePath: string; destinationPath: string };
type Scope = { workspace: WorkspaceContext; fileOptions: WorkspaceFileOperationOptions };

export type WorkspaceFileOperationServiceInput = {
  /** Existing durable operation ID when a user explicitly resumes recovery. */
  operationId?: string;
  kind: 'rename' | 'move' | 'copy';
  source: Scope;
  destination: Scope;
  selections: readonly Selection[];
  expectedPlanId?: string;
  renameOnCollision?: boolean;
  actorUserId: string;
  actorId: string;
  actorDisplayName: string;
  actorType?: 'user' | 'agent';
  actorSessionId?: string;
};

export type WorkspaceFileOperationServiceResult = {
  execution: WorkspaceOperationExecutionResult;
  plan: WorkspaceFileOperationPreview | null;
  rename: WorkspacePathRenameResult | null;
  copied: string[];
  alreadyKnown: boolean;
};

function operationIdFor(input: WorkspaceFileOperationServiceInput): string {
  if (input.operationId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(input.operationId)) {
      throw Object.assign(new Error('Invalid operation ID.'), { status: 422 });
    }
    return input.operationId;
  }
  if (!input.expectedPlanId) return randomUUID();
  return createHash('sha256').update(JSON.stringify([
    'workspace-file-operation-v1', input.actorUserId,
    input.source.workspace.workspaceId, input.destination.workspace.workspaceId, input.expectedPlanId,
  ])).digest('hex');
}

function assertScopes(input: WorkspaceFileOperationServiceInput): void {
  const source = input.source.workspace;
  const destination = input.destination.workspace;
  if (!source.permissions.canRead || !destination.permissions.canWrite
    || (input.kind !== 'copy' && (!source.permissions.canWrite || !source.permissions.canDelete
      || source.workspaceId !== destination.workspaceId))
    || source.status && source.status !== 'active' || destination.status && destination.status !== 'active') {
    throw Object.assign(new Error('Current workspace permissions are required for this file operation.'), { status: 403 });
  }
  if (input.selections.length < 1 || input.selections.length > 1000) {
    throw Object.assign(new Error('Invalid file operation selection count.'), { status: 422 });
  }
  if (input.kind !== 'copy' && input.selections.length !== 1) {
    throw Object.assign(new Error('Move accepts one path selection.'), { status: 422 });
  }
}

function selectedFinalPaths(plan: WorkspaceFileOperationPreview, selections: readonly Selection[]): Selection[] {
  return selections.map(({ sourcePath }) => {
    const root = plan.pathMappings.find((mapping) => mapping.sourcePath === sourcePath);
    if (!root) throw new WorkspacePreviewBlockedError();
    return { sourcePath, destinationPath: root.destinationPath };
  });
}

function linkInput(stage: WorkspaceOperationStage, input: WorkspaceFileOperationServiceInput): WorkspaceLinkWriteExecutorInput {
  return {
    plan: stage.preview, source: input.source, destination: input.destination,
    actorUserId: input.actorUserId, actorId: input.actorId,
    actorDisplayName: input.actorDisplayName, actorType: input.actorType,
    actorSessionId: input.actorSessionId, operationId: stage.identity.operationId,
  };
}

function sameRequestedSelections(input: WorkspaceFileOperationServiceInput, request: WorkspaceOperationRequest): boolean {
  if (request.kind !== input.kind || request.selections.length !== input.selections.length) return false;
  return request.selections.every((selection, index) => {
    const requested = input.selections[index];
    return selection.sourcePath === requested.sourcePath
      && (input.kind !== 'copy'
        ? selection.destinationPath === requested.destinationPath
        : path.posix.dirname(selection.destinationPath) === path.posix.dirname(requested.destinationPath)
          && (requested.destinationPath === selection.destinationPath
            || requested.destinationPath === path.posix.join(path.posix.dirname(requested.destinationPath),
              path.posix.basename(requested.sourcePath))));
  });
}

function observeExecutionStatus(kind: WorkspaceFileOperationServiceInput['kind'],
  status: WorkspaceOperationExecutionResult['status'], phase: WorkspaceOperationMetricPhase): void {
  if (status === 'needs_recovery' || status === 'failed') {
    observeWorkspaceOperation({ scope: 'executor', kind, phase, outcome: status });
  }
}

/** Browser/mobile and in-workspace agent operations enter through the same fenced executor. */
export async function executeWorkspaceFileOperationService(
  input: WorkspaceFileOperationServiceInput,
): Promise<WorkspaceFileOperationServiceResult> {
  assertScopes(input);
  const operationId = operationIdFor(input);
  const sourceWorkspaceId = input.source.workspace.workspaceId;
  const destinationWorkspaceId = input.destination.workspace.workspaceId;
  try {
    const destinationPaths = input.selections.map((selection) => normalizeWorkspaceRelativePath(selection.destinationPath));
    return await withWorkspaceFileLifecycleGuards([
      { workspaceId: sourceWorkspaceId, paths: input.selections.map((selection) => normalizeWorkspaceRelativePath(selection.sourcePath)) },
      { workspaceId: destinationWorkspaceId, paths: destinationPaths },
    ], () => withWorkspaceCopyMutationLocks(input.source.fileOptions, input.destination.fileOptions, async () => {
    const journal = new WorkspaceOperationJournal();
    const staging = new WorkspaceOperationStaging();
    let rename: WorkspacePathRenameResult | null = null;
    const copied: string[] = [];
    const known = await journal.get(operationId);
    if (known && (known.actor.id !== input.actorUserId || known.planId !== input.expectedPlanId
      || known.sourceWorkspaceId !== sourceWorkspaceId || known.destinationWorkspaceId !== destinationWorkspaceId)) {
      throw Object.assign(new Error('Operation ID belongs to another workspace request.'), { status: 409 });
    }
    let request: WorkspaceOperationRequest;
    let plan: WorkspaceFileOperationPreview | null = null;
    if (known) {
      request = JSON.parse(known.requestJson) as WorkspaceOperationRequest;
      if (!sameRequestedSelections(input, request)) {
        throw Object.assign(new Error('Operation parameters differ from the reviewed plan.'), { status: 409 });
      }
    } else {
      plan = await buildWorkspaceFileOperationPreview({
        kind: input.kind, sourceWorkspaceId, destinationWorkspaceId,
        sourceOptions: input.source.fileOptions, destinationOptions: input.destination.fileOptions,
        selections: input.selections, renameOnCollision: input.renameOnCollision,
      });
      if (!plan.coverage.complete) observeWorkspaceOperation({ scope: 'executor', kind: input.kind, phase: 'preview',
        outcome: 'incomplete_link_plan', omittedSourceCount: plan.coverage.omittedSources.length,
        unresolvedLinkCount: plan.coverage.unresolvedLinks.length });
      if (plan.collisions.length > 0) observeWorkspaceOperation({
        scope: 'executor', kind: input.kind, phase: 'preview', outcome: 'conflict',
      });
      if (input.expectedPlanId) assertFreshWorkspaceFileOperationPlan(plan, input.expectedPlanId);
      else if (plan.readiness !== 'ready' || !isWorkspaceFileOperationLinkSafe(plan)) {
        throw new WorkspacePreviewBlockedError();
      }
      request = { kind: input.kind, selections: selectedFinalPaths(plan, input.selections) };
    }

    const executor = createWorkspaceFileOperationExecutor({
      journal, staging,
      adapters: {
        rebuildPlan: async ({ request: durableRequest }) => buildWorkspaceFileOperationPreview({
          kind: durableRequest.kind, sourceWorkspaceId, destinationWorkspaceId,
          sourceOptions: input.source.fileOptions, destinationOptions: input.destination.fileOptions,
          selections: durableRequest.selections,
        }),
        path: {
          probe: (stage, evidence) => probeWorkspacePathOperation({
            plan: stage.preview, sourceOptions: input.source.fileOptions,
            destinationOptions: input.destination.fileOptions,
            pathReceiptApplied: evidence.pathReceiptApplied,
          }),
          probeSelection: (stage, selection, evidence) => probeWorkspacePathSelectionOperation({
            plan: stage.preview, selection,
            sourceOptions: input.source.fileOptions,
            destinationOptions: input.destination.fileOptions,
            pathReceiptApplied: evidence.pathReceiptApplied,
          }),
          apply: async () => {
            if (request.kind === 'copy') throw new Error('Copy requires a per-selection path step.');
            const selection = request.selections[0];
            // Keep the original bytes after the recovery stage is retired. Undo
            // only uses this snapshot after checking every current path and link.
            const undoBackup = await captureWorkspaceOperationBackup({
              workspace: input.source.workspace, path: selection.sourcePath, operationId,
            });
            rename = await renameWorkspacePath({
              workspace: input.source.workspace,
              oldPath: selection.sourcePath, newPath: selection.destinationPath,
              overwrite: false, fileOptions: input.source.fileOptions,
            });
            return { kind: request.kind, sourcePath: selection.sourcePath,
              destinationPath: selection.destinationPath, mutationId: rename.mutation.operationId,
              undoBackupId: undoBackup.backupId };
          },
          applySelection: async (_stage, selection) => {
            if (request.kind !== 'copy') throw new Error('Selection copy cannot apply to rename or move.');
            const directory = path.posix.dirname(selection.destinationPath);
            const chooseCollisionName = input.renameOnCollision === true
              || path.posix.basename(selection.destinationPath) !== path.posix.basename(selection.sourcePath);
            const result = await copyFileBetweenWorkspaces(selection.sourcePath, directory,
              false, chooseCollisionName,
              { source: input.source.fileOptions, target: input.destination.fileOptions });
            if (result.skipped || result.copied !== selection.destinationPath) {
              throw new Error(`Copy destination changed: ${selection.destinationPath}`);
            }
            if (!result.collaborationInitialized) {
              await initializeCopiedFileCollaborationPaths({
                workspace: input.destination.workspace, paths: [result.copied],
              });
            }
            copied.push(result.copied);
            return { kind: 'copy', sourcePath: selection.sourcePath,
              destinationPath: selection.destinationPath, copiedPath: result.copied,
              collaborationInitialized: true };
          },
        },
        links: {
          preflight: async (stage) => preflightWorkspaceLinkWrites(linkInput(stage, input)),
          probe: (group, stage) => probeWorkspaceLinkWriteGroup(linkInput(stage, input), group,
            { preflight: stage.linkPreflight ?? undefined }),
          apply: async (group, stage) => {
            await applyWorkspaceLinkWriteGroup(linkInput(stage, input), group,
              { preflight: stage.linkPreflight ?? undefined });
          },
        },
      },
    });

    if (known) {
      const execution = await executor.recover({ operationId, planId: known.planId,
        sourceWorkspaceId, destinationWorkspaceId });
      observeExecutionStatus(input.kind, execution.status, 'recovery');
      if (request.kind === 'copy' && execution.status === 'complete') {
        copied.push(...request.selections.map((selection) => selection.destinationPath));
      }
      return { execution, plan: null, rename, copied, alreadyKnown: true };
    }
    const preview = plan!;
    const originalDocuments = await Promise.all(groupWorkspaceLinkWrites(preview).map(async (group) => ({
      workspaceId: group.sourceWorkspaceId,
      path: group.sourcePathBefore,
      content: (await readFile(group.sourcePathBefore, input.source.fileOptions)).toString('utf8'),
    })));
    const execution = await executor.execute({
      operationId, actor: { type: input.actorType ?? 'user', id: input.actorUserId },
      request, preview, sourceWorkspaceId, destinationWorkspaceId, originalDocuments,
    });
    observeExecutionStatus(input.kind, execution.status, 'apply');
    return { execution, plan: preview, rename, copied, alreadyKnown: false };
    }));
  } catch (error) {
    if (error instanceof WorkspacePreviewStaleError || (error as { status?: unknown })?.status === 409) {
      observeWorkspaceOperation({ scope: 'executor', kind: input.kind, phase: 'apply', outcome: 'conflict' });
    } else if (!(error instanceof WorkspacePreviewBlockedError)
      && ![403, 422].includes(Number((error as { status?: unknown })?.status))) {
      observeWorkspaceOperation({ scope: 'executor', kind: input.kind, phase: 'apply', outcome: 'failed' });
    }
    throw error;
  }
}
