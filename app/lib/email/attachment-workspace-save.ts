import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { invalidateWorkspaceFileViews } from '@/app/lib/api/route-helpers';
import type { DownloadedEmailAttachmentBatchItem } from '@/app/lib/email/attachment-batch';
import {
  archiveFileCollaborationPaths,
  type FileActorType,
} from '@/app/lib/files/collaboration-policy';
import { getParentDirectories, getParentDirectory } from '@/app/lib/files/path-utils';
import { deleteWorkspaceFileMetadata } from '@/app/lib/files/workspace-file-metadata';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { writeWorkspaceFileContent } from '@/app/lib/files/write-service';
import {
  createDirectoryIfAbsent,
  deleteFile,
  getFileStats,
} from '@/app/lib/filesystem/workspace-files';
import { syncPublicSharesAfterDelete } from '@/app/lib/public-sharing/public-file-shares';
import {
  normalizeWorkspaceRelativePath,
  resolveExistingWorkspacePath,
} from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

type WorkspaceSaveDestination =
  | {
      type: 'directory';
      path: string;
      createIfMissing?: boolean;
      renameConflicts?: boolean;
    }
  | {
      type: 'file';
      path: string;
      createParentDirectories?: boolean;
    };

export type SavedEmailAttachment = {
  attachmentId: string;
  contentType: string;
  filename: string;
  path: string;
  sha256: string;
  size: number;
};

export class EmailAttachmentWorkspaceSaveConsistencyError extends Error {
  readonly code = 'EMAIL_ATTACHMENT_WORKSPACE_ROLLBACK_FAILED';
  readonly status = 500;

  constructor(operationError: unknown, rollbackErrors: unknown[]) {
    const operationMessage = operationError instanceof Error ? operationError.message : String(operationError);
    const rollbackMessage = rollbackErrors
      .map((error) => error instanceof Error ? error.message : String(error))
      .join('; ');
    super(`Saving email attachments failed (${operationMessage}); rollback failed: ${rollbackMessage}`, {
      cause: operationError,
    });
    this.name = 'EmailAttachmentWorkspaceSaveConsistencyError';
  }
}

function hasMissingPathCode(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && ['ENOENT', 'ENOTDIR'].includes(String(error.code)),
  );
}

function hasCreateCollisionCode(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && ['EEXIST', 'FILE_REVISION_CONFLICT'].includes(String(error.code)),
  );
}

async function workspacePathExists(filePath: string, workspace: WorkspaceContext) {
  try {
    await getFileStats(filePath, { workspace });
    return true;
  } catch (error) {
    if (hasMissingPathCode(error)) return false;
    throw error;
  }
}

async function availableWorkspacePath(
  targetDirectory: string,
  fileName: string,
  reservedPaths: Set<string>,
  workspace: WorkspaceContext,
) {
  const parsed = path.posix.parse(fileName);
  const baseName = parsed.name || 'attachment';
  let candidateName = fileName;
  let index = 2;
  while (true) {
    const candidatePath = targetDirectory === '.' ? candidateName : `${targetDirectory}/${candidateName}`;
    const normalizedKey = candidatePath.normalize('NFC').toLocaleLowerCase('en-US');
    if (!reservedPaths.has(normalizedKey) && !(await workspacePathExists(candidatePath, workspace))) {
      reservedPaths.add(normalizedKey);
      return candidatePath;
    }
    candidateName = `${baseName}-${index}${parsed.ext}`;
    index += 1;
  }
}

async function missingWorkspaceDirectories(directoryPath: string, workspace: WorkspaceContext) {
  const directoryPaths = [
    ...getParentDirectories(directoryPath),
    directoryPath,
  ].filter((candidate) => candidate !== '.');
  const missing: string[] = [];
  for (const candidate of directoryPaths) {
    if (!(await workspacePathExists(candidate, workspace))) missing.push(candidate);
  }
  return missing;
}

async function rollbackSavedAttachments(params: {
  directories: string[];
  fileOptions: { workspace: WorkspaceContext };
  paths: string[];
  workspace: WorkspaceContext;
}): Promise<unknown[]> {
  const rollbackErrors: unknown[] = [];
  const deletedPaths: string[] = [];
  for (const savedPath of [...params.paths].reverse()) {
    try {
      await deleteFile(savedPath, params.fileOptions);
      deletedPaths.push(savedPath);
    } catch (error) {
      rollbackErrors.push(error);
      continue;
    }
    try {
      await archiveFileCollaborationPaths({ workspace: params.workspace, paths: [{ path: savedPath }] });
    } catch (error) {
      rollbackErrors.push(error);
    }
    try {
      await deleteWorkspaceFileMetadata({ workspace: params.workspace, path: savedPath });
    } catch (error) {
      rollbackErrors.push(error);
    }
  }

  const deletedDirectories: string[] = [];
  for (const directoryPath of [...params.directories].reverse()) {
    try {
      const absolutePath = await resolveExistingWorkspacePath(params.workspace, directoryPath);
      await fs.rmdir(absolutePath);
      deletedDirectories.push(directoryPath);
    } catch (error) {
      if (hasMissingPathCode(error)) continue;
      rollbackErrors.push(error);
    }
  }

  if (deletedPaths.length > 0 || deletedDirectories.length > 0) {
    try {
      await syncPublicSharesAfterDelete(deletedPaths, params.workspace);
    } catch (error) {
      rollbackErrors.push(error);
    }
    invalidateWorkspaceFileViews({
      fileOptions: params.fileOptions,
      subtreeDirs: [
        ...deletedPaths.map(getParentDirectory),
        ...deletedDirectories.map(getParentDirectory),
      ],
      mutations: [
        ...deletedPaths.map((savedPath) => ({ path: savedPath, type: 'unlink' as const })),
        ...deletedDirectories.map((directoryPath) => ({ path: directoryPath, type: 'unlinkDir' as const })),
      ],
    });
  }
  return rollbackErrors;
}

export async function saveDownloadedEmailAttachmentsToWorkspace(input: {
  actorType: FileActorType;
  actorUserId: string;
  attachments: readonly DownloadedEmailAttachmentBatchItem[];
  destination: WorkspaceSaveDestination;
  workspace: WorkspaceContext;
}): Promise<SavedEmailAttachment[]> {
  if (input.attachments.length === 0) return [];
  const fileOptions = { workspace: input.workspace };
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    const createdDirectories: string[] = [];
    const attemptedPaths: string[] = [];
    try {
      let paths: string[];

      if (input.destination.type === 'file') {
        if (input.attachments.length !== 1) {
          throw new Error('A file destination can only be used for one email attachment.');
        }
        const destinationPath = normalizeWorkspaceRelativePath(input.destination.path);
        const parentDirectory = path.posix.dirname(destinationPath);
        if (input.destination.createParentDirectories && parentDirectory !== '.') {
          createdDirectories.push(...await missingWorkspaceDirectories(parentDirectory, input.workspace));
          await createDirectoryIfAbsent(parentDirectory, fileOptions);
        }
        paths = [destinationPath];
      } else {
        const targetDirectory = normalizeWorkspaceRelativePath(input.destination.path);
        if (input.destination.createIfMissing) {
          createdDirectories.push(...await missingWorkspaceDirectories(targetDirectory, input.workspace));
          await createDirectoryIfAbsent(targetDirectory, fileOptions);
        }
        const targetStats = await getFileStats(targetDirectory, fileOptions);
        if (!targetStats.isDirectory) throw new Error('The selected workspace destination is not a folder.');
        const reservedPaths = new Set<string>();
        paths = [];
        for (const attachment of input.attachments) {
          const candidatePath = targetDirectory === '.'
            ? attachment.attachment.filename
            : `${targetDirectory}/${attachment.attachment.filename}`;
          paths.push(input.destination.renameConflicts
            ? await availableWorkspacePath(
                targetDirectory,
                attachment.attachment.filename,
                reservedPaths,
                input.workspace,
              )
            : candidatePath);
        }
      }

      const saved: SavedEmailAttachment[] = [];
      for (let index = 0; index < input.attachments.length; index += 1) {
        const item = input.attachments[index];
        attemptedPaths.push(paths[index]);
        const savedFile = await writeWorkspaceFileContent({
          workspace: input.workspace,
          fileOptions,
          actorUserId: input.actorUserId,
          actorType: input.actorType,
          path: paths[index],
          content: item.content,
          createOnly: true,
          encoded: true,
        });
        saved.push({
          attachmentId: item.attachment.id,
          contentType: item.attachment.contentType,
          filename: item.attachment.filename,
          path: savedFile.path,
          sha256: savedFile.stats.sha256,
          size: savedFile.stats.size,
        });
      }
      return saved;
    } catch (operationError) {
      const rollbackPaths = hasCreateCollisionCode(operationError)
        ? attemptedPaths.slice(0, -1)
        : attemptedPaths;
      const rollbackErrors = await rollbackSavedAttachments({
        directories: createdDirectories,
        fileOptions,
        paths: rollbackPaths,
        workspace: input.workspace,
      });
      if (rollbackErrors.length > 0) {
        throw new EmailAttachmentWorkspaceSaveConsistencyError(operationError, rollbackErrors);
      }
      throw operationError;
    }
  });
}
