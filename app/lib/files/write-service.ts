import 'server-only';

import { randomUUID } from 'node:crypto';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { validateDocxPackage } from '@/app/lib/office/docx-package';
import { withOfficePublication } from '@/app/lib/office/publication-context';
import { readOfficeFileBytes, recoverOfficePublication } from '@/app/lib/office/document-service';
import { prepareOfficeCommit, findOfficeCommit, completeOfficeCommit, type OfficeCommitRecord } from '@/app/lib/office/document-journal';

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
  sha256Buffer,
  assertWorkspaceFileRevisionUnchanged,
} from '@/app/lib/files/revision-guard';
import {
  assertFileCollaborationWriteAllowed,
  ensureFileRevisionForCurrentContent,
  getFileCollaborationState,
  isDocxPath,
  FileCollaborationPolicyError,
  type FileActorType,
} from '@/app/lib/files/collaboration-policy';
import { getParentDirectory } from '@/app/lib/files/path-utils';
import { invalidateWorkspaceFileViews } from '@/app/lib/api/route-helpers';
import { queuePublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { assertWorkspacePathHasNoAliases, normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';

export type WriteWorkspaceFileContentInput = {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  actorUserId: string;
  actorSessionId?: string | null;
  actorType?: FileActorType;
  lockId?: string | null;
  idempotencyKey?: string;
  signal?: AbortSignal;
  path: string;
  content: Buffer | string;
  expectedSha256?: string | null;
  requireExpectedRevision?: boolean;
  baseRevisionId?: string | null;
  createOnly?: boolean;
  encoded?: boolean;
  ensureCollaborationDocument?: boolean;
};


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
  input.signal?.throwIfAborted();
  const office = isDocxPath(input.path);
  const contentBuffer = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content);
  if (office) await validateDocxPackage(contentBuffer);
  input.signal?.throwIfAborted();
  let journal: OfficeCommitRecord | null = null;
  const officeState = office ? await getFileCollaborationState({ workspace: input.workspace, path: input.path, ensureDocument: true }) : null;
  if (officeState?.lineageId) {
    const current = await getWorkspaceFileRevision(input.path, input.fileOptions);
    if (current) await recoverOfficePublication(input.workspace, officeState.lineageId, input.path, current.sha256, current.stats.size);
    if (input.idempotencyKey) {
      const previous = await findOfficeCommit({ workspaceId: input.workspace.workspaceId, lineageId: officeState.lineageId,
        actorUserId: input.actorUserId, actorSessionId: input.actorSessionId ?? 'file-create', idempotencyKey: input.idempotencyKey });
      if (previous) {
        if (previous.afterHash !== sha256Buffer(contentBuffer) || previous.path !== input.path || previous.beforeHash !== (input.expectedSha256 ?? null) || previous.baseRevisionId !== (input.baseRevisionId ?? null) || previous.actorType !== (input.actorType ?? 'user')) {
          throw new OfficeWriteError('OFFICE_IDEMPOTENCY_CONFLICT', 409, 'This save identifier belongs to another document edit.');
        }
        if (previous.status === 'completed' && current && current.sha256 === previous.afterHash) {
          const collaboration = await getFileCollaborationState({ workspace: input.workspace, path: input.path, ensureDocument: true });
          return { path: input.path, stats: { ...current.stats, sha256: current.sha256 }, revision: collaboration.latestRevision!, collaboration };
        }
      }
    }
  }
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
    requireExpectedRevision: office || (input.requireExpectedRevision ?? workspaceRequiresRevisionCheck(input.workspace)),
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

  if (office && beforeRevision && !input.baseRevisionId) {
    throw new FileCollaborationPolicyError({ code: 'FILE_REVISION_ID_CONFLICT', status: 409, path: input.path,
      message: 'The loaded document revision is required before saving.', currentRevisionId: storedBaseRevision?.id });
  }
  const assertLease = () => assertFileCollaborationWriteAllowed({
    workspace: input.workspace, path: input.path,
    actorUserId: input.actorUserId, actorSessionId: input.actorSessionId ?? null,
    actorType: input.actorType ?? 'user', baseRevisionId: input.baseRevisionId ?? null, lockId: input.lockId,
  });
  await assertLease();
  if (office && officeState?.lineageId) {
    journal = await prepareOfficeCommit({
      workspaceId: input.workspace.workspaceId, lineageId: officeState.lineageId, path: input.path,
      actorUserId: input.actorUserId, actorSessionId: input.actorSessionId ?? 'file-create', actorType: input.actorType ?? 'user',
      beforeHash: beforeRevision?.sha256 ?? null, baseRevisionId: input.baseRevisionId ?? storedBaseRevision?.id ?? null,
      beforeContent: beforeRevision ? await readOfficeFileBytes(input.path, input.fileOptions) : null,
      content: contentBuffer, idempotencyKey: input.idempotencyKey ?? randomUUID(),
    });
  }
  const beforePublish = async () => {
    input.signal?.throwIfAborted();
    await assertWorkspaceFileRevisionUnchanged({ path: input.path, expectedRevision: beforeRevision, options: input.fileOptions });
    const state = await assertLease();
    if (office && state.activeLock && state.activeLock.expiresAt <= Date.now()) {
      throw new FileCollaborationPolicyError({ code: 'FILE_LOCK_STALE', status: 423, path: input.path,
        message: 'The document lease expired while saving. Keep your draft and renew the editing session.' });
    }
    input.signal?.throwIfAborted();
  };
  const publish = async () => {
    if (input.createOnly) {
      try {
        await writeFileIfAbsent(input.path, input.content, input.fileOptions, beforePublish);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
          throw existingFileError(input.path, await getWorkspaceFileRevision(input.path, input.fileOptions));
        }
        throw error;
      }
    } else {
      await writeFile(input.path, input.content, input.fileOptions, beforePublish);
    }
  };
  if (office) await withOfficePublication(input.workspace.workspaceId, input.path, publish);
  else await publish();
  const afterRevision = await getWorkspaceFileRevision(input.path, input.fileOptions);
  if (!afterRevision) throw new Error('Written file could not be read after save.');
  if (office && afterRevision.sha256 !== sha256Buffer(contentBuffer)) {
    throw new OfficeWriteError('OFFICE_PUBLICATION_CHANGED', 409, 'The published document changed unexpectedly. The proposed version remains in recovery history.');
  }
  const revision = await ensureFileRevisionForCurrentContent({
    workspace: input.workspace,
    path: input.path,
    contentHash: afterRevision.sha256,
    sizeBytes: afterRevision.stats.size,
    actorUserId: input.actorUserId,
    actorType: input.actorType ?? 'user',
    sourceSessionId: input.actorSessionId ?? null,
    baseRevisionId: input.baseRevisionId ?? storedBaseRevision?.id ?? null,
  });
  if (journal) await completeOfficeCommit(journal, revision.id);
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
  const normalizedInput = {
    ...input,
    path: normalizeWorkspaceRelativePath(input.path),
    fileOptions: { ...input.fileOptions, workspace: input.workspace },
    content: Buffer.isBuffer(input.content) ? Buffer.from(input.content) : input.content,
  };
  return withWorkspaceMutationLock(
    input.workspace.workspaceId,
    async () => {
      if (isDocxPath(normalizedInput.path)) await assertWorkspacePathHasNoAliases(input.workspace, normalizedInput.path);
      return writeWorkspaceFileContentUnlocked(normalizedInput);
    },
  );
}

export class OfficeWriteError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = 'OfficeWriteError';
  }
}
