import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { NextRequest } from 'next/server';

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
import { serializeWorkspaceOperationRequest, WorkspaceOperationJournal, type WorkspaceOperationRecord,
  type WorkspaceOperationRequest } from './workspace-operation-journal';
import { assertWorkspaceOperationCopyOriginCurrent, captureWorkspaceOperationCopyOrigin } from './workspace-operation-copy-origin';
import { probeWorkspacePathOperation, probeWorkspacePathSelectionOperation } from './workspace-operation-path-probe';
import { WorkspaceOperationStaging, type WorkspaceOperationStage } from './workspace-operation-staging';
import { renameWorkspacePath, type WorkspacePathRenameResult } from './rename-service';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import type { WorkspaceOperationNativeCopyPreviewPublic } from './workspace-operation-native-copy-public';
import { finalizeWorkspaceNativeCopyViews } from './workspace-operation-copy-view-finalizer';

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
  /** Optional fresh-request destination directory, workspace-relative or root. */
  destinationDirectory?: string;
  actorUserId: string;
  actorId: string;
  actorDisplayName: string;
  actorType?: 'user' | 'agent';
  actorSessionId?: string;
  /** Actual current member request; private authentication input, never journal data. */
  request?: NextRequest;
};

export type WorkspaceFileOperationServiceResult = {
  execution: WorkspaceOperationExecutionResult;
  plan: WorkspaceFileOperationPreview | WorkspaceOperationNativeCopyPreviewPublic | null;
  rename: WorkspacePathRenameResult | null;
  copied: string[];
  alreadyKnown: boolean;
  /** Private adapter deduplication hint; never part of the public execution DTO. */
  copyViewsFinalized?: true;
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

function captureCopyInput(input: WorkspaceFileOperationServiceInput): WorkspaceFileOperationServiceInput {
  const destinationDirectory = input.destinationDirectory;
  if (destinationDirectory !== undefined && typeof destinationDirectory !== 'string') {
    throw Object.assign(new Error('Invalid Copy destination directory.'), { status: 422 });
  }
  // Compiled routes can carry a different NextRequest constructor. Require a
  // real Web Request, then copy its credentials into the local native request.
  if (input.request !== undefined && !(input.request instanceof Request)) {
    throw Object.assign(new Error('A current member request is required.'), { status: 422 });
  }
  const request = input.request ? new NextRequest(input.request.url,
    { method: input.request.method, headers: new Headers(input.request.headers) }) : undefined;
  const scope = (value: Scope): Scope => {
    const workspace: WorkspaceContext = Object.freeze({ ...value.workspace,
      permissions: Object.freeze({ ...value.workspace.permissions }),
      ...(value.workspace.actor ? { actor: Object.freeze({ ...value.workspace.actor }) } : {}),
    });
    return Object.freeze({ workspace, fileOptions: Object.freeze({ ...value.fileOptions, workspace }) });
  };
  // The options' real filesystem roots must describe the same declared scopes.
  // Bind absent workspace options explicitly, before any asynchronous work.
  const actor = { type: input.actorType ?? 'user', userId: input.actorUserId,
    actorId: input.actorId, sessionId: input.actorSessionId ?? null } as const;
  assertWorkspaceOperationCopyOriginCurrent(captureWorkspaceOperationCopyOrigin({ actor,
    sourceWorkspace: input.source.workspace, destinationWorkspace: input.destination.workspace,
  }), captureWorkspaceOperationCopyOrigin({ actor,
    sourceWorkspace: input.source.fileOptions.workspace ?? input.source.workspace,
    destinationWorkspace: input.destination.fileOptions.workspace ?? input.destination.workspace,
  }));
  return { ...input, source: scope(input.source), destination: scope(input.destination),
    ...(request ? { request } : {}),
    ...(destinationDirectory !== undefined ? { destinationDirectory } : {}),
    selections: Object.freeze(input.selections.map(selection => Object.freeze({ ...selection }))) };
}

/** Browser/mobile and in-workspace agent operations enter through the same fenced executor. */
export async function executeWorkspaceFileOperationService(
  input: WorkspaceFileOperationServiceInput,
): Promise<WorkspaceFileOperationServiceResult> {
  assertScopes(input);
  if (input.kind === 'copy') input = captureCopyInput(input);
  const currentCopyContext = input.kind === 'copy' ? captureWorkspaceOperationCopyOrigin({
    actor: { type: input.actorType ?? 'user', userId: input.actorUserId,
      actorId: input.actorId, sessionId: input.actorSessionId ?? null },
    sourceWorkspace: input.source.workspace, destinationWorkspace: input.destination.workspace,
  }) : null;
  const operationId = operationIdFor(input);
  const sourceWorkspaceId = input.source.workspace.workspaceId;
  const destinationWorkspaceId = input.destination.workspace.workspaceId;
  try {
    const journal = new WorkspaceOperationJournal();
    // Routing data is never authority. The fixed owner authenticates afresh on
    // its actual B and loads the immutable original before any publication.
    const routingRecord = await journal.get(operationId);
    if (input.kind === 'copy') {
      const stageKind = await new WorkspaceOperationStaging().readKind(operationId);
      const nativeJournal = routingRecord?.steps.some(step => step.stepKey === 'copy-completion'
        || step.stepKey.startsWith('copy-path:') || step.stepKey.startsWith('copy-parent:')) === true;
      const enabled = authenticatedNativeTextSessionEnabled();
      if (stageKind === 'native-copy' || nativeJournal || enabled && stageKind === null && routingRecord === null) {
        if (!enabled) throw Object.assign(new Error('Native Copy is unavailable.'), { status: 409, code: 'NATIVE_COPY_UNAVAILABLE' });
        const { workspaceOperationNativeCopyPublicPreview } = await import('./workspace-operation-native-copy-public');
        const result = await runNativeCopyWithViews('execute', { origin: currentCopyContext!, request: input.request,
          operationId, selections: input.selections, expectedPlanId: input.expectedPlanId, renameOnCollision: input.renameOnCollision,
          destinationDirectory: input.destinationDirectory }, input.destination.fileOptions);
        observeExecutionStatus(input.kind, result.execution.status, result.alreadyKnown ? 'recovery' : 'apply');
        return { execution: result.execution, plan: result.plan ? workspaceOperationNativeCopyPublicPreview(result.plan) : null,
          rename: null, copied: result.copied, alreadyKnown: result.alreadyKnown, copyViewsFinalized: true };
      }
    }
    const savedRequest = (record: WorkspaceOperationRecord | null): WorkspaceOperationRequest | null => {
      if (!record) return null;
      if (record.actor.id !== input.actorUserId || record.planId !== input.expectedPlanId
        || record.sourceWorkspaceId !== sourceWorkspaceId || record.destinationWorkspaceId !== destinationWorkspaceId) {
        throw Object.assign(new Error('Operation ID belongs to another workspace request.'), { status: 409 });
      }
      const request = JSON.parse(record.requestJson) as WorkspaceOperationRequest;
      if (Object.hasOwn(request, 'origin')) {
        const bound = serializeWorkspaceOperationRequest(request);
        if (!currentCopyContext || bound.requestJson !== record.requestJson || bound.requestHash !== record.requestHash
          || request.origin?.actor.type !== record.actor.type || request.origin.actor.userId !== record.actor.id) {
          throw Object.assign(new Error('Original Copy request binding differs from the journal.'), { status: 409 });
        }
        assertWorkspaceOperationCopyOriginCurrent(request.origin, currentCopyContext);
      }
      if (!sameRequestedSelections(input, request)) {
        throw Object.assign(new Error('Operation parameters differ from the reviewed plan.'), { status: 409 });
      }
      return request;
    };
    // Resolve collision names before admission, so an unrelated owner of the
    // original destination cannot block a copy to a different final path.
    // Recovery uses its immutable stored target rather than choosing a new one.
    const priorRequest = savedRequest(routingRecord);
    let guardedSelections = priorRequest?.selections ?? input.selections;
    if (!priorRequest && input.kind === 'copy' && input.renameOnCollision) {
      const preliminary = await buildWorkspaceFileOperationPreview({
        kind: input.kind, sourceWorkspaceId, destinationWorkspaceId,
        sourceOptions: input.source.fileOptions, destinationOptions: input.destination.fileOptions,
        selections: input.selections, renameOnCollision: true,
      });
      guardedSelections = selectedFinalPaths(preliminary, input.selections);
    }
    const destinationPaths = guardedSelections.map((selection) => normalizeWorkspaceRelativePath(selection.destinationPath));
    return await withWorkspaceFileLifecycleGuards([
      { workspaceId: sourceWorkspaceId, paths: input.selections.map((selection) => normalizeWorkspaceRelativePath(selection.sourcePath)) },
      { workspaceId: destinationWorkspaceId, paths: destinationPaths },
    ], () => withWorkspaceCopyMutationLocks(input.source.fileOptions, input.destination.fileOptions, async () => {
    const staging = new WorkspaceOperationStaging();
    let rename: WorkspacePathRenameResult | null = null;
    const copied: string[] = [];
    const known = await journal.get(operationId);
    const recoveredRequest = savedRequest(known);
    let request: WorkspaceOperationRequest;
    let plan: WorkspaceFileOperationPreview | null = null;
    if (recoveredRequest) {
      request = recoveredRequest;
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
      request = { kind: input.kind, selections: selectedFinalPaths(plan, input.selections),
        ...(currentCopyContext ? { origin: currentCopyContext } : {}) };
    }
    // Replanning and rereading the journal happen under both canonical
    // workspace guards. Never apply a target that changed during acquisition.
    if (request.selections.length !== destinationPaths.length || request.selections.some((selection, index) =>
      normalizeWorkspaceRelativePath(selection.destinationPath) !== destinationPaths[index])) {
      throw new WorkspacePreviewStaleError();
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
          applySelection: async (stage, selection) => {
            if (request.kind !== 'copy') throw new Error('Selection copy cannot apply to rename or move.');
            const directory = path.posix.dirname(selection.destinationPath);
            const chooseCollisionName = input.renameOnCollision === true
              || path.posix.basename(selection.destinationPath) !== path.posix.basename(selection.sourcePath);
            const result = await copyFileBetweenWorkspaces(selection.sourcePath, directory,
              false, chooseCollisionName,
              { source: input.source.fileOptions, target: { ...input.destination.fileOptions,
                mutationOperationId: stage.identity.operationId,
                mutationActorUserId: request.origin?.actor.userId ?? input.actorUserId,
                mutationActorSessionId: request.origin ? request.origin.actor.sessionId ?? undefined : input.actorSessionId } });
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

/** Fixed common Owner continuation. Outcome facts are private notifications,
 * not authority; only the exact returned result/error can select them. */
async function runNativeCopyWithViews(mode: 'execute' | 'recover',
  input: import('./workspace-operation-native-copy-owner').NativeCopyExecutionInput,
  fileOptions: WorkspaceFileOperationOptions,
): Promise<import('./workspace-operation-native-copy-owner').NativeCopyExecutionResult> {
  const { executeWorkspaceNativeCopyOperation, recoverWorkspaceNativeCopyOperation,
    readWorkspaceNativeCopyViewOutcome } = await import('./workspace-operation-native-copy-owner');
  let result: import('./workspace-operation-native-copy-owner').NativeCopyExecutionResult;
  try {
    result = mode === 'execute' ? await executeWorkspaceNativeCopyOperation(input) : await recoverWorkspaceNativeCopyOperation(input);
  } catch (error) {
    const outcome = readWorkspaceNativeCopyViewOutcome(error);
    if (outcome) {
      try { finalizeWorkspaceNativeCopyViews({ fileOptions, outcome }); }
      catch (views) { throw new AggregateError([error, views], 'Native Copy views could not be finalized.'); }
    }
    throw error;
  }
  const outcome = readWorkspaceNativeCopyViewOutcome(result);
  if (outcome) finalizeWorkspaceNativeCopyViews({ fileOptions, outcome });
  return result;
}

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { DecodedDirectMcpWorkspaceCopyRequestV1, DirectMcpWorkspaceCopyResultV1 } from '../mcp/server/workspace-copy-tool-contract';

/** Fixed MCP Copy entry only. Input is the frozen result of the shared wire
 * decoder; it supplies no actor, Origin, session, workspace roots or authority.
 * Every invocation obtains its actual Origin from the current opaque capture.
 * Native Web/PI and MCP use the same fixed Owner/view continuation. */
export async function runDirectMcpWorkspaceCopyService(
  input: DecodedDirectMcpWorkspaceCopyRequestV1,
  authInfo: AuthInfo,
): Promise<DirectMcpWorkspaceCopyResultV1> {
  const { encodeDirectMcpWorkspaceCopyResultV1, WorkspaceCopyToolError } = await import('../mcp/server/workspace-copy-tool-contract');
  const selectedOperationId = input.action === 'preview' ? undefined : input.operationId;
  // Historical status remains inspectable under the current fixed Copy policy
  // when creation/edit activation is off. Mutation-capable entries keep the gate.
  if (input.action !== 'status' && !authenticatedNativeTextSessionEnabled()) {
    throw new WorkspaceCopyToolError('COPY_NATIVE_REQUIRED', selectedOperationId);
  }
  const [{ openDb }, { executeLifecycleTransaction }, {
    withDirectMcpWorkspaceCopyPrincipal, withDirectMcpWorkspaceCopyPrincipalOnConnection,
  }, { captureWorkspaceOperationCopyMcpOrigin }, {
    previewWorkspaceNativeCopyOperation,
  }, { workspaceOperationNativeCopyPublicPreview }, { readMcpWorkspaceNativeCopyOperationStatus }] = await Promise.all([
    import('../db'), import('../collaboration/lifecycle-transaction'), import('../mcp/server/document-read-principal'),
    import('./workspace-operation-copy-origin'), import('./workspace-operation-native-copy-owner'),
    import('./workspace-operation-native-copy-public'), import('./workspace-operation-native-copy-status'),
  ]);
  return withDirectMcpWorkspaceCopyPrincipal(authInfo, {
    sourceWorkspaceId: input.sourceWorkspaceId, destinationWorkspaceId: input.destinationWorkspaceId,
  }, async mcpPrincipal => {
    // This short phase owns no Copy mutation. Its actual COMMIT and awaited
    // close finish before the Owner may enter another B/current-principal phase.
    const captured = await executeLifecycleTransaction({
      openConnection: openDb,
      execute: async database => {
        await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
        return withDirectMcpWorkspaceCopyPrincipalOnConnection(database, mcpPrincipal, async access => {
          const origin = captureWorkspaceOperationCopyMcpOrigin({ userId: access.userId, clientId: access.clientId,
            sessionId: access.sessionId, sourceWorkspace: access.sourceWorkspace, destinationWorkspace: access.destinationWorkspace });
          // Retained notification data only. This object is never supplied to
          // the Owner as a grant, and its ID must match each actual outcome.
          const workspace: WorkspaceContext = Object.freeze({ ...access.destinationWorkspace,
            permissions: Object.freeze({ ...access.destinationWorkspace.permissions }),
            ...(access.destinationWorkspace.actor ? { actor: Object.freeze({ ...access.destinationWorkspace.actor }) } : {}) });
          return Object.freeze({ origin, fileOptions: Object.freeze({ workspace }) });
        });
      },
      recoverCommitted: async (_captured, commitError) => {
        // A lost prelude acknowledgement never authorizes entering the Owner.
        // This is not a mutation replay, historical lookup or cleanup attempt.
        throw new AggregateError([new WorkspaceCopyToolError('COPY_UNAVAILABLE', selectedOperationId), commitError],
          'MCP Copy origin transaction completion was not confirmed.');
      },
    });
    if (input.action === 'status') {
      const operation = await readMcpWorkspaceNativeCopyOperationStatus({ origin: captured.origin, mcpPrincipal, operationId: input.operationId });
      return encodeDirectMcpWorkspaceCopyResultV1({ apiVersion: 1, action: 'status', operation }, input.operationId);
    }
    if (input.action === 'preview') {
      const plan = await previewWorkspaceNativeCopyOperation({ origin: captured.origin, mcpPrincipal,
        selections: input.selections, renameOnCollision: input.renameOnCollision,
        ...(input.destinationDirectory === undefined ? {} : { destinationDirectory: input.destinationDirectory }) });
      return encodeDirectMcpWorkspaceCopyResultV1({ apiVersion: 1, action: 'preview', preview: workspaceOperationNativeCopyPublicPreview(plan) });
    }
    const ownerInput = { origin: captured.origin, mcpPrincipal, operationId: input.operationId, expectedPlanId: input.planId,
      selections: input.selections, renameOnCollision: input.renameOnCollision,
      ...(input.destinationDirectory === undefined ? {} : { destinationDirectory: input.destinationDirectory }) };
    const result = await runNativeCopyWithViews(input.action === 'apply' ? 'execute' : 'recover', ownerInput, captured.fileOptions);
    observeExecutionStatus('copy', result.execution.status, input.action === 'recover' || result.alreadyKnown ? 'recovery' : 'apply');
    return encodeDirectMcpWorkspaceCopyResultV1({ apiVersion: 1, action: input.action,
      execution: result.execution, copied: result.copied, alreadyKnown: result.alreadyKnown }, input.operationId);
  });
}
