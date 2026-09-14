import 'server-only';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { loadCollaborationState, type PersistedCollaborationState } from '@/app/lib/collaboration/persistence';
import {
  fileChangeGroupService,
  type FileChangeGroupAccess,
  type FileChangeGroupEntryInput,
} from '@/app/lib/file-version-center/change-group-service';
import { fileVersionHistoryService, type FileVersionCaptureResult } from '@/app/lib/file-version-center/history-service';
import { FILE_VERSION_CENTER_ROLLOUT_ENV_V1, resolveFileVersionRolloutV1 } from '@/app/lib/file-version-center/policy-v1';
import { getFileCollaborationState, type FileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { getAgentExecutionContext, type AgentExecutionContext } from './agent-execution-context';
import type { AgentFileChangeResult } from './agent-file-operations';
import {
  asAgentFileToolSuccess,
  type AgentFileToolOperation,
  type AgentFileToolSuccess,
} from './agent-file-tool-results';
import { fileChangeToolApp, type BuiltinToolAppDescriptor } from '@/app/lib/tool-apps/types';
import type { FileChangeGroupV1 } from '@/app/lib/file-version-center/contracts/v1';

export type AgentFileToolAppSuccess = AgentFileToolSuccess & {
  changeGroup: FileChangeGroupV1;
  toolApp: BuiltinToolAppDescriptor;
};

export type AgentFilePatchToolSuccess = {
  contractVersion: 1;
  kind: 'file_patch_batch';
  operation: 'apply_patch';
  outcome: 'applied' | 'review_required';
  category: 'success' | 'review_required';
  results: AgentFileToolSuccess[];
  recommendedAction: 'none' | 'review_in_editor';
  safeToAutoRetry: false;
};

export type AgentFilePatchToolAppSuccess = AgentFilePatchToolSuccess & {
  changeGroup: FileChangeGroupV1;
  toolApp: BuiltinToolAppDescriptor;
};

type Dependencies = {
  captureFile: (input: Parameters<typeof fileVersionHistoryService.capture>[0]) => Promise<FileVersionCaptureResult>;
  captureCollaboration: (input: Parameters<typeof fileVersionHistoryService.capturePersistedCollaboration>[0]) => Promise<FileVersionCaptureResult>;
  createGroup: (input: Parameters<typeof fileChangeGroupService.create>[0]) => Promise<FileChangeGroupV1>;
  getCollaborationState: (input: { workspace: WorkspaceContext; path: string; ensureDocument: false }) => Promise<FileCollaborationState>;
  getExecutionContext: () => AgentExecutionContext | null;
  loadCollaboration: (documentId: string) => Promise<PersistedCollaborationState | null>;
  readFile: (resolvedPath: string) => Promise<Buffer>;
  visibleUiEnabled: () => boolean;
};

const runtimeDependencies: Dependencies = {
  captureFile: (input) => fileVersionHistoryService.capture(input),
  captureCollaboration: (input) => fileVersionHistoryService.capturePersistedCollaboration(input),
  createGroup: (input) => fileChangeGroupService.create(input),
  getCollaborationState: (input) => getFileCollaborationState(input),
  getExecutionContext: getAgentExecutionContext,
  loadCollaboration: loadCollaborationState,
  readFile: (resolvedPath) => fs.readFile(resolvedPath),
  visibleUiEnabled: () => resolveFileVersionRolloutV1(
    process.env[FILE_VERSION_CENTER_ROLLOUT_ENV_V1.mode],
  ).visibleUi,
};

function workspaceFromContext(context: AgentExecutionContext): WorkspaceContext {
  return {
    workspaceId: context.workspaceId,
    workspaceType: context.workspaceType,
    rootPath: context.workspaceRoot,
    rootRelativePath: context.workspaceRootRelativePath ?? undefined,
    displayName: context.workspaceName ?? undefined,
    organizationId: context.organizationId,
    customerId: context.customerId,
    projectId: context.projectId,
    permissions: {
      canRead: true,
      canWrite: context.canWrite,
      canDelete: context.canDelete,
      canCreatePublicLinks: context.canShare,
      canManageWorkspace: false,
      canRunAgent: true,
    },
    legacy: context.legacy,
  };
}

function workspacePath(context: AgentExecutionContext, result: AgentFileChangeResult): string | null {
  const relative = path.relative(path.resolve(context.workspaceRoot), path.resolve(result.resolvedPath));
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  try { return normalizeWorkspaceRelativePath(relative.split(path.sep).join('/')); }
  catch { return null; }
}

function countDiff(diff: string): Pick<FileChangeGroupEntryInput, 'additions' | 'deletions'> {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function captureReference(capture: FileVersionCaptureResult, expectedHash: string) {
  if (!capture.revision?.lineageId || !capture.binding
    || capture.revision.contentHash !== expectedHash || capture.binding.sha256 !== expectedHash) return null;
  return { lineageId: capture.revision.lineageId, revisionId: capture.revision.id };
}

async function collaborationTarget(input: {
  context: AgentExecutionContext;
  workspace: WorkspaceContext;
  pathHint: string;
  result: AgentFileChangeResult;
  dependencies: Dependencies;
}): Promise<FileChangeGroupEntryInput | null> {
  const collaboration = input.result.collaboration;
  if (!collaboration) return null;
  const state = await input.dependencies.getCollaborationState({
    workspace: input.workspace,
    path: input.pathHint,
    ensureDocument: false,
  });
  const document = state.document;
  if (!state.lineageId || !document || document.status !== 'active'
    || document.workspaceId !== input.context.workspaceId || document.path !== input.pathHint) return null;
  const outcome = collaboration.operationStatus === 'semantic_conflict' ? 'conflict' as const
    : collaboration.reviewRequired ? 'review_required' as const : 'applied' as const;
  const common = {
    lineageId: state.lineageId,
    documentId: document.id,
    operationId: collaboration.operationId,
    pathHint: input.pathHint,
    outcome,
    ...countDiff(input.result.diff),
  };
  if (outcome !== 'applied') return common;
  const persisted = await input.dependencies.loadCollaboration(document.id);
  if (!persisted || persisted.status !== 'active' || persisted.workspaceId !== input.context.workspaceId
    || persisted.path !== input.pathHint || persisted.documentId !== document.id) return null;
  const capture = await input.dependencies.captureCollaboration({
    workspace: input.workspace,
    state: persisted,
    source: 'agent_apply',
    actorUserId: input.context.userId,
    actorType: 'agent',
    sourceSessionId: input.context.sessionId,
  });
  const reference = captureReference(capture, input.result.afterSha256);
  return reference ? { ...common, ...reference } : null;
}

async function durableEntry(
  result: AgentFileChangeResult,
  context: AgentExecutionContext,
  dependencies: Dependencies,
): Promise<FileChangeGroupEntryInput | null> {
  const pathHint = workspacePath(context, result);
  if (!pathHint || (!result.changed && !result.collaboration?.reviewRequired)) return null;
  const workspace = workspaceFromContext(context);
  if (result.collaboration) {
    return collaborationTarget({ context, workspace, pathHint, result, dependencies });
  }
  if (!result.changed) return null;
  const content = await dependencies.readFile(result.resolvedPath);
  const contentHash = createHash('sha256').update(content).digest('hex');
  if (contentHash !== result.afterSha256 || content.byteLength !== result.size) return null;
  const capture = await dependencies.captureFile({
    workspace,
    path: pathHint,
    content,
    source: 'agent_apply',
    actorUserId: context.userId,
    actorType: 'agent',
    sourceSessionId: context.sessionId,
  });
  const reference = captureReference(capture, result.afterSha256);
  return reference ? { ...reference, pathHint, outcome: 'applied', ...countDiff(result.diff) } : null;
}

function changeGroupAccess(context: AgentExecutionContext): FileChangeGroupAccess {
  return {
    userId: context.userId,
    authenticatedWorkspaceId: context.workspaceId,
    requestedWorkspaceId: context.workspaceId,
    membership: 'active',
    permissionsResolved: true,
    canRead: true,
    canWrite: context.canWrite,
    canRunAgent: true,
  };
}

async function withChangeGroup<T extends AgentFileToolSuccess | AgentFilePatchToolSuccess>(input: {
  success: T;
  context: AgentExecutionContext;
  operation: AgentFileToolOperation;
  toolCallId: string;
  entries: FileChangeGroupEntryInput[];
  dependencies: Dependencies;
}): Promise<T & { changeGroup: FileChangeGroupV1; toolApp: BuiltinToolAppDescriptor }> {
  const changeGroup = await input.dependencies.createGroup({
    access: changeGroupAccess(input.context),
    sourceSessionId: input.context.sessionId,
    toolCallId: input.toolCallId,
    operation: input.operation,
    entries: input.entries,
  });
  return { ...input.success, changeGroup, toolApp: fileChangeToolApp(changeGroup) };
}

/**
 * Adds a reloadable widget binding only after the mutation has a durable,
 * workspace-scoped revision or review operation. Grouping is side-effect-free
 * with respect to the mutation, so a grouping outage never replays the write.
 */
export function createAgentFileToolAppSuccess(dependencies: Dependencies = runtimeDependencies) {
  return async (
    result: AgentFileChangeResult,
    operation: Extract<AgentFileToolOperation, 'write' | 'edit_file'>,
    toolCallId: string,
  ): Promise<AgentFileToolSuccess | AgentFileToolAppSuccess> => {
    const success = asAgentFileToolSuccess(result, operation);
    const context = dependencies.getExecutionContext();
    if (!context || !context.canWrite || !dependencies.visibleUiEnabled()
      || (success.outcome !== 'applied' && success.outcome !== 'review_required')) return success;
    try {
      const entry = await durableEntry(result, context, dependencies);
      if (!entry) return success;
      return await withChangeGroup({
        success,
        context,
        toolCallId,
        operation,
        entries: [entry],
        dependencies,
      });
    } catch {
      // The file operation already has its own durable receipt. Do not turn a
      // presentation-layer outage into an error that encourages mutation retry.
      return success;
    }
  };
}

export const asAgentFileToolAppSuccess = createAgentFileToolAppSuccess();

export function createAgentFilePatchToolAppSuccess(dependencies: Dependencies = runtimeDependencies) {
  return async (
    results: AgentFileChangeResult[],
    toolCallId: string,
  ): Promise<AgentFilePatchToolSuccess | AgentFilePatchToolAppSuccess> => {
    const reviewRequired = results.some((result) => result.collaboration?.reviewRequired);
    const success: AgentFilePatchToolSuccess = {
      contractVersion: 1,
      kind: 'file_patch_batch',
      operation: 'apply_patch',
      outcome: reviewRequired ? 'review_required' : 'applied',
      category: reviewRequired ? 'review_required' : 'success',
      results: results.map((result) => asAgentFileToolSuccess(result, 'apply_patch')),
      recommendedAction: reviewRequired ? 'review_in_editor' : 'none',
      safeToAutoRetry: false,
    };
    const context = dependencies.getExecutionContext();
    if (!context || !context.canWrite || !dependencies.visibleUiEnabled()) return success;
    const candidates = results.filter((result) => result.changed || result.collaboration?.reviewRequired);
    if (candidates.length === 0) return success;
    try {
      const entries: FileChangeGroupEntryInput[] = [];
      for (const result of candidates) {
        const entry = await durableEntry(result, context, dependencies);
        // Never publish a partial batch card that hides an applied mutation.
        if (!entry) return success;
        entries.push(entry);
      }
      return await withChangeGroup({
        success,
        context,
        operation: 'apply_patch',
        toolCallId,
        entries,
        dependencies,
      });
    } catch {
      return success;
    }
  };
}

export const asAgentFilePatchToolAppSuccess = createAgentFilePatchToolAppSuccess();
