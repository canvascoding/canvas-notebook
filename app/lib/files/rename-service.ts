import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  archiveFileCollaborationPaths,
  moveFileCollaborationPath,
} from '@/app/lib/files/collaboration-policy';
import {
  deleteWorkspaceFileMetadata,
  moveWorkspaceFileMetadata,
} from '@/app/lib/files/workspace-file-metadata';
import {
  queuePublicSharesAfterMove,
  syncPublicSharesAfterMove,
} from '@/app/lib/public-sharing/public-file-shares';
import {
  withRollbackableFileRename,
  assertWorkspaceOfficePathMutationAllowed,
  checkRenameConflict,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { captureWorkspaceOperationBackup, type WorkspaceOperationBackup } from './workspace-operation-backup';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';
import type { WorkspacePathRenameMutation } from './file-events';
import { withWorkspacePathRenameEvent } from '@/app/lib/filesystem/file-watcher';

type RenameParams = {
  workspace: WorkspaceContext;
  oldPath: string;
  newPath: string;
  overwrite: boolean;
  fileOptions: WorkspaceFileOperationOptions;
  mutation?: WorkspacePathRenameMutation;
};

export type WorkspacePathRenameResult = {
  warnings: string[];
  mutation: WorkspacePathRenameMutation;
  backup: Pick<WorkspaceOperationBackup, 'backupId' | 'originalPath' | 'contentSha256' | 'sizeBytes'> | null;
};

export type WorkspacePathRenameOperations = {
  withFileRename: <T>(params: RenameParams, operation: () => Promise<T>) => Promise<T>;
  moveCollaborationPath: (params: Pick<RenameParams, 'workspace' | 'oldPath' | 'newPath'>) => Promise<void>;
  archiveCollaborationPath: (params: { workspace: WorkspaceContext; path: string }) => Promise<void>;
  moveMetadataPath: (params: Pick<RenameParams, 'workspace' | 'oldPath' | 'newPath'>) => Promise<void>;
  deleteMetadataPath: (params: { workspace: WorkspaceContext; path: string }) => Promise<void>;
  syncPublicShares: (params: RenameParams) => Promise<void>;
  queuePublicShareSync: (params: RenameParams) => void;
  createBackupPath: () => string;
  captureDestinationBackup: (params: RenameParams) => Promise<WorkspacePathRenameResult['backup']>;
};

type RegisterCompensation = (compensation: () => Promise<void>) => void;

export class WorkspacePathRenameConsistencyError extends Error {
  readonly code = 'WORKSPACE_PATH_RENAME_ROLLBACK_FAILED';

  constructor(operationError: unknown, rollbackErrors: unknown[]) {
    const operationMessage = operationError instanceof Error ? operationError.message : String(operationError);
    const rollbackMessage = rollbackErrors
      .map((error) => error instanceof Error ? error.message : String(error))
      .join('; ');
    super(`Path rename failed (${operationMessage}); projection rollback failed: ${rollbackMessage}`, {
      cause: operationError,
    });
    this.name = 'WorkspacePathRenameConsistencyError';
  }
}

async function withCompensations<T>(
  operation: (registerCompensation: RegisterCompensation) => Promise<T>,
): Promise<T> {
  const compensations: Array<() => Promise<void>> = [];
  try {
    return await operation((compensation) => compensations.push(compensation));
  } catch (operationError) {
    const rollbackErrors: unknown[] = [];
    for (const compensation of compensations.reverse()) {
      try {
        await compensation();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new WorkspacePathRenameConsistencyError(operationError, rollbackErrors);
    }
    throw operationError;
  }
}

const runtimeOperations: WorkspacePathRenameOperations = {
  withFileRename: (params, operation) => withWorkspacePathRenameEvent(params.workspace, params.mutation!, () => withRollbackableFileRename(
    params.oldPath,
    params.newPath,
    params.overwrite,
    params.fileOptions,
    operation,
  )),
  moveCollaborationPath: moveFileCollaborationPath,
  archiveCollaborationPath: async ({ workspace, path }) => {
    await archiveFileCollaborationPaths({ workspace, paths: [{ path }] });
  },
  moveMetadataPath: moveWorkspaceFileMetadata,
  deleteMetadataPath: deleteWorkspaceFileMetadata,
  syncPublicShares: async (params) => {
    await syncPublicSharesAfterMove(
      params.oldPath,
      params.newPath,
      params.workspace,
      { revokeDestination: params.overwrite },
    );
  },
  queuePublicShareSync: (params) => {
    queuePublicSharesAfterMove(
      params.oldPath,
      params.newPath,
      params.workspace,
      { revokeDestination: params.overwrite },
    );
  },
  createBackupPath: () => `.canvas-rename-backups/${randomUUID()}`,
  captureDestinationBackup: async (params) => {
    const conflict = await checkRenameConflict(params.oldPath, params.newPath, params.fileOptions);
    if (!conflict) return null;
    if (conflict.code !== 'FILE_EXISTS' || conflict.type !== 'file') throw conflict;
    const { detectFileCollaborationStrategy, readFileCollaborationState } = await import('@/app/lib/files/collaboration-policy');
    const strategy = detectFileCollaborationStrategy(params.newPath);
    if (strategy === 'crdt_text' || strategy === 'excalidraw_scene') {
      const state = await readFileCollaborationState({ workspace: params.workspace, path: params.newPath });
      if (state.document) {
        throw Object.assign(new Error(`Active collaborative file cannot be overwritten: ${params.newPath}`),
          { status: 409, code: 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED' });
      }
    }
    const captured = await captureWorkspaceOperationBackup({
      workspace: params.workspace, path: params.newPath, operationId: params.mutation!.operationId,
    });
    return { backupId: captured.backupId, originalPath: captured.originalPath,
      contentSha256: captured.contentSha256, sizeBytes: captured.sizeBytes };
  },
};

export async function renameWorkspacePath(
  params: RenameParams,
  operations: WorkspacePathRenameOperations = runtimeOperations,
): Promise<WorkspacePathRenameResult> {
  params = {
    ...params, oldPath: normalizeWorkspaceRelativePath(params.oldPath), newPath: normalizeWorkspaceRelativePath(params.newPath),
    fileOptions: { ...params.fileOptions, workspace: params.workspace },
  };
  return withWorkspaceMutationLock(params.workspace.workspaceId, async () => {
    await assertWorkspaceOfficePathMutationAllowed([params.oldPath, params.newPath], params.fileOptions);
    const mutation: WorkspacePathRenameMutation = {
      type: 'rename', operationId: randomUUID(), workspaceId: params.workspace.workspaceId,
      oldPath: params.oldPath, newPath: params.newPath,
    };
    params = { ...params, mutation };
    const backup = params.overwrite ? await operations.captureDestinationBackup(params) : null;
    const backupPath = params.overwrite ? operations.createBackupPath() : null;

    try {
      await withCompensations(async (registerDestinationRollback) => {
        if (backupPath) {
          await operations.moveCollaborationPath({
            workspace: params.workspace,
            oldPath: params.newPath,
            newPath: backupPath,
          });
          registerDestinationRollback(() => operations.moveCollaborationPath({
            workspace: params.workspace,
            oldPath: backupPath,
            newPath: params.newPath,
          }));

          await operations.moveMetadataPath({
            workspace: params.workspace,
            oldPath: params.newPath,
            newPath: backupPath,
          });
          registerDestinationRollback(() => operations.moveMetadataPath({
            workspace: params.workspace,
            oldPath: backupPath,
            newPath: params.newPath,
          }));
        }

        await operations.withFileRename(params, async () => {
          await withCompensations(async (registerSourceRollback) => {
            await operations.moveCollaborationPath(params);
            registerSourceRollback(() => operations.moveCollaborationPath({
              workspace: params.workspace,
              oldPath: params.newPath,
              newPath: params.oldPath,
            }));

            await operations.moveMetadataPath(params);
            registerSourceRollback(() => operations.moveMetadataPath({
              workspace: params.workspace,
              oldPath: params.newPath,
              newPath: params.oldPath,
            }));
          });
        });
      });
    } catch (error) {
      if (backup && error && typeof error === 'object') {
        Object.assign(error, { backup, operationId: mutation.operationId });
      }
      throw error;
    }

    const warnings: string[] = [];
    if (backupPath) {
      try {
        await operations.archiveCollaborationPath({ workspace: params.workspace, path: backupPath });
      } catch (error) {
        warnings.push(`Collaboration backup cleanup: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await operations.deleteMetadataPath({ workspace: params.workspace, path: backupPath });
      } catch (error) {
        warnings.push(`Metadata backup cleanup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      await operations.syncPublicShares(params);
    } catch (error) {
      warnings.push(`Public share sync: ${error instanceof Error ? error.message : String(error)}`);
      operations.queuePublicShareSync(params);
    }

    return { warnings, mutation, backup };
  });
}
