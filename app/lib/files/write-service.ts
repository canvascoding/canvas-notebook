import 'server-only';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  writeFile,
  writeFileIfAbsent,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import {
  assertWorkspaceFileRevisionAllowed,
  getWorkspaceFileRevision,
  WorkspaceFileRevisionError,
  workspaceRequiresRevisionCheck,
} from '@/app/lib/files/revision-guard';
import {
  assertFileCollaborationWriteAllowed,
  ensureFileRevisionForCurrentContent,
  getFileCollaborationState,
} from '@/app/lib/files/collaboration-policy';
import { getParentDirectory } from '@/app/lib/files/path-utils';
import { invalidateWorkspaceFileViews } from '@/app/lib/api/route-helpers';
import { queuePublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export type WriteWorkspaceFileContentInput = {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  actorUserId: string;
  actorSessionId?: string | null;
  path: string;
  content: Buffer | string;
  expectedSha256?: string | null;
  requireExpectedRevision?: boolean;
  baseRevisionId?: string | null;
  createOnly?: boolean;
  encoded?: boolean;
  ensureCollaborationDocument?: boolean;
};

const fileWriteLocks = new Map<string, Promise<void>>();

async function withWorkspaceFileWriteLock<T>(
  workspaceId: string,
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${workspaceId}\0${filePath}`;
  const previous = fileWriteLocks.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  const queued = previous.then(() => current);
  fileWriteLocks.set(key, queued);

  await previous;
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (fileWriteLocks.get(key) === queued) fileWriteLocks.delete(key);
  }
}

function existingFileError(path: string, existing: Awaited<ReturnType<typeof getWorkspaceFileRevision>>) {
  return new WorkspaceFileRevisionError({
    code: 'FILE_REVISION_CONFLICT',
    status: 409,
    message: 'A file already exists at this path.',
    path,
    expectedSha256: null,
    currentSha256: existing?.sha256 ?? null,
    currentStats: existing?.stats ?? null,
  });
}

async function writeWorkspaceFileContentUnlocked(input: WriteWorkspaceFileContentInput) {
  if (input.createOnly) {
    const existing = await getWorkspaceFileRevision(input.path, input.fileOptions);
    if (existing) {
      throw existingFileError(input.path, existing);
    }
  }

  const beforeRevision = await assertWorkspaceFileRevisionAllowed({
    path: input.path,
    expectedSha256: input.expectedSha256,
    options: input.fileOptions,
    requireExpectedRevision: input.requireExpectedRevision ?? workspaceRequiresRevisionCheck(input.workspace),
  });
  const storedBaseRevision = beforeRevision
    ? await ensureFileRevisionForCurrentContent({
        workspace: input.workspace,
        path: input.path,
        contentHash: beforeRevision.sha256,
        sizeBytes: beforeRevision.stats.size,
        actorType: 'system',
      })
    : null;

  await assertFileCollaborationWriteAllowed({
    workspace: input.workspace,
    path: input.path,
    actorUserId: input.actorUserId,
    actorSessionId: input.actorSessionId ?? null,
    actorType: 'user',
    baseRevisionId: input.baseRevisionId ?? null,
  });

  if (input.createOnly) {
    try {
      await writeFileIfAbsent(input.path, input.content, input.fileOptions);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw existingFileError(
          input.path,
          await getWorkspaceFileRevision(input.path, input.fileOptions),
        );
      }
      throw error;
    }
  } else {
    await writeFile(input.path, input.content, input.fileOptions, async () => {
      if (!input.expectedSha256) return;
      await assertWorkspaceFileRevisionAllowed({
        path: input.path,
        expectedSha256: input.expectedSha256,
        options: input.fileOptions,
        requireExpectedRevision: true,
      });
    });
  }
  const contentBuffer = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content);
  const afterRevision = await getWorkspaceFileRevision(input.path, input.fileOptions);
  if (!afterRevision) throw new Error('Written file could not be read after save.');
  const revision = await ensureFileRevisionForCurrentContent({
    workspace: input.workspace,
    path: input.path,
    contentHash: afterRevision.sha256,
    sizeBytes: afterRevision.stats.size,
    actorUserId: input.actorUserId,
    actorType: 'user',
    sourceSessionId: null,
    baseRevisionId: input.baseRevisionId ?? storedBaseRevision?.id ?? null,
  });
  const collaboration = await getFileCollaborationState({
    workspace: input.workspace,
    path: input.path,
    ensureDocument: input.ensureCollaborationDocument ?? true,
  });
  invalidateWorkspaceFileViews({
    fileOptions: input.fileOptions,
    subtreeDirs: [getParentDirectory(input.path)],
    mutations: [{ path: input.path, type: input.createOnly ? 'add' : 'change' }],
  });
  queuePublicSharesAfterWrite([input.path], input.workspace);
  await recordAuditEvent({
    organizationId: input.workspace.organizationId,
    workspaceId: input.workspace.workspaceId,
    userId: input.actorUserId,
    source: 'files',
    eventType: 'file',
    entityType: 'workspace_path',
    entityId: input.path,
    action: input.createOnly ? 'file.create' : 'file.write',
    status: 'success',
    summary: `${input.createOnly ? 'File created' : 'File written'} at ${input.path}.`,
    metadata: {
      path: input.path,
      workspaceType: input.workspace.workspaceType,
      contentBytes: contentBuffer.byteLength,
      encoded: input.encoded ?? false,
      expectedSha256: input.expectedSha256 ?? null,
      afterSha256: afterRevision.sha256,
      baseRevisionId: input.baseRevisionId ?? storedBaseRevision?.id ?? null,
      revisionId: revision.id,
    },
    input: {
      path: input.path,
      contentLength: typeof input.content === 'string' ? input.content.length : null,
    },
  });

  return {
    path: input.path,
    stats: {
      size: afterRevision.stats.size,
      modified: afterRevision.stats.modified,
      permissions: afterRevision.stats.permissions,
      sha256: afterRevision.sha256,
    },
    revision,
    collaboration,
  };
}

export async function writeWorkspaceFileContent(input: WriteWorkspaceFileContentInput) {
  return withWorkspaceFileWriteLock(
    input.workspace.workspaceId,
    input.path,
    () => writeWorkspaceFileContentUnlocked(input),
  );
}
