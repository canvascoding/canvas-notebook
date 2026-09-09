import 'server-only';

import path from 'node:path';

import type { DownloadedEmailAttachmentBatchItem } from '@/app/lib/email/attachment-batch';
import type { FileActorType } from '@/app/lib/files/collaboration-policy';
import { writeWorkspaceFileContent } from '@/app/lib/files/write-service';
import { createDirectoryIfAbsent, getFileStats } from '@/app/lib/filesystem/workspace-files';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';
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

function hasMissingPathCode(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && ['ENOENT', 'ENOTDIR'].includes(String(error.code)),
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

export async function saveDownloadedEmailAttachmentsToWorkspace(input: {
  actorType: FileActorType;
  actorUserId: string;
  attachments: readonly DownloadedEmailAttachmentBatchItem[];
  destination: WorkspaceSaveDestination;
  workspace: WorkspaceContext;
}): Promise<SavedEmailAttachment[]> {
  if (input.attachments.length === 0) return [];
  const fileOptions = { workspace: input.workspace };
  let paths: string[];

  if (input.destination.type === 'file') {
    if (input.attachments.length !== 1) {
      throw new Error('A file destination can only be used for one email attachment.');
    }
    const destinationPath = normalizeWorkspaceRelativePath(input.destination.path);
    const parentDirectory = path.posix.dirname(destinationPath);
    if (input.destination.createParentDirectories && parentDirectory !== '.') {
      await createDirectoryIfAbsent(parentDirectory, fileOptions);
    }
    paths = [destinationPath];
  } else {
    const targetDirectory = normalizeWorkspaceRelativePath(input.destination.path);
    if (input.destination.createIfMissing) {
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
}
