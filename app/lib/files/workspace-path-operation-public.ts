import type { WorkspaceOperationBatchPlan, WorkspaceOperationBatchProgress } from './workspace-operation-batch-contract';
import type { WorkspaceOperationBatchStatus } from './workspace-operation-batch-store';
import type { WorkspacePathRenameMutation } from './file-events';

export type WorkspacePathOperationIssue = { code: string; path: string; targetLiteral?: string; line?: number };

/** Share actionable reasons with the UI and agent without exposing private diagnostic details. */
export function workspacePathOperationPublicIssues(plan: Pick<WorkspaceOperationBatchPlan, 'issues' | 'linkAssessment'>): WorkspacePathOperationIssue[] {
  const issues = new Map<string, WorkspacePathOperationIssue>();
  for (const issue of plan.issues) {
    const blockers = issue.code === 'incomplete-index'
      ? plan.linkAssessment.blockers.filter((blocker) => blocker.sourcePath === issue.path) : [];
    for (const reason of blockers.length ? blockers.map((blocker) => ({ code: blocker.reason, path: blocker.sourcePath,
      htmlTargets: blocker.htmlTargets, line: blocker.line })) : [issue]) {
      const code = /^[a-z][a-z0-9-]{0,99}$/u.test(reason.code) ? reason.code : 'unknown';
      const path = reason.path.length <= 4096 && !reason.path.startsWith('/') && !reason.path.includes('\\')
        && !reason.path.split('/').includes('..') && !/[\p{Cc}\p{Cf}]/u.test(reason.path)
        && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reason.path) ? reason.path : '';
      const targets = 'htmlTargets' in reason ? reason.htmlTargets : undefined;
      const targetLiteral = Array.isArray(targets) && targets.length > 0 && targets.length <= 32
        && targets.every((target) => typeof target === 'string' && target.length <= 4096
          && !target.startsWith('/') && !target.includes('\\') && !target.split('/').includes('..')
          && !/[\p{Cc}\p{Cf}]/u.test(target) && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target))
        ? targets.join(', ') : undefined;
      const line = 'line' in reason && typeof reason.line === 'number' && Number.isSafeInteger(reason.line)
        && reason.line > 0 ? reason.line : undefined;
      issues.set(JSON.stringify([code, path, targetLiteral, line]), { code, path,
        ...(targetLiteral !== undefined ? { targetLiteral } : {}), ...(line !== undefined ? { line } : {}) });
    }
  }
  return [...issues.values()];
}

export type WorkspacePathOperationPublic = WorkspaceOperationBatchProgress & {
  batchId: string; planId: string; workspaceId: string;
  status: WorkspaceOperationBatchStatus; errorCode: string | null;
  kind: 'move' | 'rename' | 'delete';
  selections: Array<{ sourcePath: string; destinationPath?: string }>;
  issues?: WorkspacePathOperationIssue[];
};

export type WorkspacePathOperationResponse = {
  operation: WorkspacePathOperationPublic;
  mutation?: WorkspacePathRenameMutation;
  deleted?: string[];
  failed?: Array<{ path: string; error: string }>;
  trashEntries?: Array<{ id: string; originalPath: string; itemType: 'file' | 'directory' | 'other';
    sizeBytes: number; expiresAt: string }>;
  linkStatus?: 'complete';
  linkUpdates?: { updatedFiles: string[]; updatedLinks: number; warnings: string[] };
};
