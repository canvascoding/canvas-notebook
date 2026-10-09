import type { WorkspacePathOperationPublic } from './workspace-path-operation-public';

const validPath = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= 4096 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..')
  && !/[\p{Cc}\p{Cf}]/u.test(value) && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value);

/** Validate identity and project only public fields before displaying operation details. */
export function readWorkspacePathOperation(value: unknown,
  expected: { workspaceId?: string | null; batchId?: string; planId?: string } = {},
): WorkspacePathOperationPublic {
  const operation = value as WorkspacePathOperationPublic | null;
  if (!operation || typeof operation.batchId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(operation.batchId)
    || typeof operation.workspaceId !== 'string' || !operation.workspaceId.trim()
    || expected.workspaceId && operation.workspaceId !== expected.workspaceId
    || expected.batchId && operation.batchId !== expected.batchId
    || typeof operation.planId !== 'string' || !/^[a-f0-9]{64}$/u.test(operation.planId)
    || expected.planId && operation.planId !== expected.planId
    || !['move', 'rename', 'delete'].includes(operation.kind)
    || !Array.isArray(operation.selections) || operation.selections.length > 1000
    || operation.selections.some((selection) => !selection || !validPath(selection.sourcePath)
      || selection.destinationPath !== undefined && !validPath(selection.destinationPath))
    || operation.issues !== undefined && (!Array.isArray(operation.issues) || operation.issues.length > 1000
      || operation.issues.some((issue) => !issue || typeof issue.code !== 'string'
        || !/^[a-z][a-z0-9-]{0,99}$/u.test(issue.code) || issue.path !== '' && !validPath(issue.path)))
    || !['preview', 'blocked', 'queued', 'applying', 'applied', 'needs_review', 'needs_recovery', 'failed', 'undone'].includes(operation.status)
    || !['preparing', 'paths', 'links', 'complete', 'recovery'].includes(operation.phase)
    || !Number.isSafeInteger(operation.completedActions) || !Number.isSafeInteger(operation.totalActions)
    || operation.completedActions < 0 || operation.totalActions < operation.completedActions
    || ['applied', 'undone'].includes(operation.status)
      && (operation.phase !== 'complete' || operation.completedActions !== operation.totalActions)) {
    throw new Error('Invalid file action status response');
  }
  return { batchId: operation.batchId, planId: operation.planId, workspaceId: operation.workspaceId,
    status: operation.status, completedActions: operation.completedActions, totalActions: operation.totalActions,
    phase: operation.phase, kind: operation.kind,
    errorCode: typeof operation.errorCode === 'string' && /^[A-Z0-9_:-]{1,100}$/u.test(operation.errorCode)
      ? operation.errorCode : null,
    selections: operation.selections.map(({ sourcePath, destinationPath }) => ({ sourcePath,
      ...(destinationPath ? { destinationPath } : {}) })),
    ...(operation.issues ? { issues: operation.issues.map(({ code, path }) => ({ code, path })) } : {}) };
}
