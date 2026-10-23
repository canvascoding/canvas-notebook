import path from 'node:path';
import type { WorkspaceContext } from '../workspaces/types';

type TrashWorkspace = Pick<WorkspaceContext, 'workspaceType' | 'workspaceId' | 'organizationId'>;
export const DEFAULT_WORKSPACE_TRASH_RETENTION_DAYS = 30;

export function retentionDays(): number {
  const configured = Number.parseInt(process.env.WORKSPACE_TRASH_RETENTION_DAYS || '', 10);
  if (Number.isFinite(configured) && configured > 0 && configured <= 3650) return configured;
  return DEFAULT_WORKSPACE_TRASH_RETENTION_DAYS;
}

export function expiresAtFrom(deletedAt: Date, days = retentionDays()): Date {
  return new Date(deletedAt.getTime() + days * 24 * 60 * 60 * 1000);
}

function safeTrashSegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

/** Pure layout; callers pass their actual workspace DATA root. */
export function trashRootForWorkspace(workspace: TrashWorkspace, dataRoot: string): string {
  const scope = workspace.workspaceType === 'personal' ? 'personal' : workspace.workspaceType;
  return path.join(dataRoot, '.trash', 'workspaces', safeTrashSegment(scope, 'workspace'),
    safeTrashSegment(workspace.organizationId, 'no-org'), safeTrashSegment(workspace.workspaceId, 'legacy'));
}

export function trashRelativePathFor(workspace: TrashWorkspace, entryId: string, originalPath: string): string {
  const scope = workspace.workspaceType === 'personal' ? 'personal' : workspace.workspaceType;
  return path.posix.join('.trash', 'workspaces', safeTrashSegment(scope, 'workspace'),
    safeTrashSegment(workspace.organizationId, 'no-org'), safeTrashSegment(workspace.workspaceId, 'legacy'),
    entryId, path.posix.basename(originalPath));
}

export function absoluteDataPath(relativePath: string, dataRootInput: string): string {
  const dataRoot = path.resolve(dataRootInput), target = path.resolve(dataRoot, relativePath);
  if (target !== dataRoot && !target.startsWith(`${dataRoot}${path.sep}`)) throw new Error('Trash path resolves outside data root.');
  return target;
}
