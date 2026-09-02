import 'server-only';

import path from 'node:path';

import { createDirectory, type WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import {
  assertWorkspaceFileRevisionUnchanged,
  getWorkspaceFileRevision,
} from '@/app/lib/files/revision-guard';
import {
  acquireFileLock,
  assertFileCollaborationWriteAllowed,
  detectFileCollaborationStrategy,
  ensureFileRevisionForCurrentContent,
  getFileCollaborationState,
  releaseFileLock,
  workspaceRequiresCollaborationPolicy,
} from '@/app/lib/files/collaboration-policy';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export async function runWorkspaceUploadWrite(params: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  actorUserId: string;
  targetPath: string;
  write: (onBeforeReplace: () => Promise<void>) => Promise<void>;
}): Promise<void> {
  const parentDir = path.posix.dirname(params.targetPath);
  if (parentDir !== '.' && parentDir !== '/') {
    await createDirectory(parentDir, params.fileOptions);
  }

  const beforeRevision = await getWorkspaceFileRevision(params.targetPath, params.fileOptions);
  const storedBaseRevision = beforeRevision
    ? await ensureFileRevisionForCurrentContent({
        workspace: params.workspace,
        path: params.targetPath,
        contentHash: beforeRevision.sha256,
        sizeBytes: beforeRevision.stats.size,
        actorType: 'system',
      })
    : null;
  let transientUploadLockId: string | null = null;

  try {
    const shouldAutoLockUpload =
      Boolean(beforeRevision)
      && workspaceRequiresCollaborationPolicy(params.workspace)
      && detectFileCollaborationStrategy(params.targetPath) === 'exclusive_lock';
    if (shouldAutoLockUpload) {
      const currentState = await getFileCollaborationState({
        workspace: params.workspace,
        path: params.targetPath,
      });
      if (!currentState.activeLock) {
        const acquired = await acquireFileLock({
          workspace: params.workspace,
          path: params.targetPath,
          lockedByUserId: params.actorUserId,
          lockedBySessionId: null,
          lockType: 'upload',
          ttlMs: 5 * 60 * 1000,
          baseRevisionId: storedBaseRevision?.id ?? null,
        });
        transientUploadLockId = acquired.lock.id;
      }
    }

    const assertUploadStillAllowed = async () => {
      await assertWorkspaceFileRevisionUnchanged({
        path: params.targetPath,
        expectedRevision: beforeRevision,
        options: params.fileOptions,
      });
      await assertFileCollaborationWriteAllowed({
        workspace: params.workspace,
        path: params.targetPath,
        actorUserId: params.actorUserId,
        actorType: 'user',
        baseRevisionId: storedBaseRevision?.id ?? null,
      });
    };

    await assertUploadStillAllowed();
    await params.write(assertUploadStillAllowed);
    const afterRevision = await getWorkspaceFileRevision(params.targetPath, params.fileOptions);
    if (afterRevision) {
      await ensureFileRevisionForCurrentContent({
        workspace: params.workspace,
        path: params.targetPath,
        contentHash: afterRevision.sha256,
        sizeBytes: afterRevision.stats.size,
        actorUserId: params.actorUserId,
        actorType: 'user',
        sourceSessionId: null,
        baseRevisionId: storedBaseRevision?.id ?? null,
      });
    }
  } finally {
    if (transientUploadLockId) {
      try {
        await releaseFileLock({
          workspace: params.workspace,
          lockId: transientUploadLockId,
          actorUserId: params.actorUserId,
        });
      } catch (releaseError) {
        console.warn('[API] Failed to release transient upload lock:', releaseError);
      }
    }
  }
}
