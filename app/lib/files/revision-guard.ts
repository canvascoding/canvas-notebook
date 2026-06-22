import 'server-only';

import { createHash } from 'node:crypto';

import {
  getFileStats,
  readFile,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import type { FileStats } from '@/app/lib/files/types';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export interface WorkspaceFileRevision {
  path: string;
  sha256: string;
  stats: FileStats;
}

export class WorkspaceFileRevisionError extends Error {
  readonly code: 'FILE_REVISION_REQUIRED' | 'FILE_REVISION_CONFLICT';
  readonly status: 409 | 428;
  readonly path: string;
  readonly expectedSha256: string | null;
  readonly currentSha256: string | null;
  readonly currentStats: FileStats | null;

  constructor(params: {
    code: 'FILE_REVISION_REQUIRED' | 'FILE_REVISION_CONFLICT';
    status: 409 | 428;
    message: string;
    path: string;
    expectedSha256?: string | null;
    currentSha256?: string | null;
    currentStats?: FileStats | null;
  }) {
    super(params.message);
    this.name = 'WorkspaceFileRevisionError';
    this.code = params.code;
    this.status = params.status;
    this.path = params.path;
    this.expectedSha256 = params.expectedSha256 ?? null;
    this.currentSha256 = params.currentSha256 ?? null;
    this.currentStats = params.currentStats ?? null;
  }
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function normalizeExpectedSha256(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^sha256:/i, '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

export function workspaceRequiresRevisionCheck(workspace: WorkspaceContext): boolean {
  return workspace.workspaceType === 'team' || workspace.workspaceType === 'project';
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

export async function getWorkspaceFileRevision(
  filePath: string,
  options?: WorkspaceFileOperationOptions,
): Promise<WorkspaceFileRevision | null> {
  try {
    const [stats, content] = await Promise.all([
      getFileStats(filePath, options),
      readFile(filePath, options),
    ]);
    const sha256 = sha256Buffer(content);
    return {
      path: filePath,
      sha256,
      stats: {
        size: stats.size,
        modified: stats.modified,
        permissions: stats.permissions,
        sha256,
      },
    };
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function assertWorkspaceFileRevisionAllowed(params: {
  path: string;
  expectedSha256?: unknown;
  options?: WorkspaceFileOperationOptions;
  requireExpectedRevision?: boolean;
}): Promise<WorkspaceFileRevision | null> {
  const expectedSha256 = normalizeExpectedSha256(params.expectedSha256);
  const currentRevision = await getWorkspaceFileRevision(params.path, params.options);

  if (!currentRevision) {
    if (expectedSha256) {
      throw new WorkspaceFileRevisionError({
        code: 'FILE_REVISION_CONFLICT',
        status: 409,
        message: 'File revision conflict: the file no longer exists.',
        path: params.path,
        expectedSha256,
        currentSha256: null,
        currentStats: null,
      });
    }
    return null;
  }

  if (expectedSha256 && expectedSha256 !== currentRevision.sha256) {
    throw new WorkspaceFileRevisionError({
      code: 'FILE_REVISION_CONFLICT',
      status: 409,
      message: 'File revision conflict: this file changed after it was loaded. Reload the latest version before saving.',
      path: params.path,
      expectedSha256,
      currentSha256: currentRevision.sha256,
      currentStats: currentRevision.stats,
    });
  }

  if (params.requireExpectedRevision && !expectedSha256) {
    throw new WorkspaceFileRevisionError({
      code: 'FILE_REVISION_REQUIRED',
      status: 428,
      message: 'A current file revision is required before saving shared workspace files.',
      path: params.path,
      expectedSha256: null,
      currentSha256: currentRevision.sha256,
      currentStats: currentRevision.stats,
    });
  }

  return currentRevision;
}
