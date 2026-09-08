import 'server-only';

import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { createDirectory, type WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import {
  assertWorkspaceFileRevisionUnchanged,
  getWorkspaceFileRevision,
  sha256Buffer,
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
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { DOCX_PACKAGE_LIMITS, DocxPackageValidationError } from '@/app/lib/office/docx-package';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';
import { findOfficeCommit } from '@/app/lib/office/document-journal';

export type OfficeUploadAttempt = Readonly<{
  version: 1;
  workspaceId: string;
  actorUserId: string;
  path: string;
  lineageId: string;
  actorSessionId: string;
  idempotencyKey: string;
  expectedSha256: string | null;
  baseRevisionId: string | null;
  contentHash: string;
  createOnly: boolean;
}>;

export class OfficeUploadRetryError extends Error {
  readonly code = 'UPLOAD_REVISION_CONFLICT';
  readonly status = 409;
  constructor() {
    super('This upload attempt no longer matches the destination. The newer document was preserved. Start a new upload to replace it.');
    this.name = 'OfficeUploadRetryError';
  }
}

async function readOfficeUploadSource(sourcePath: string): Promise<Buffer> {
  const stream = createReadStream(sourcePath, { end: DOCX_PACKAGE_LIMITS.compressedBytes });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > DOCX_PACKAGE_LIMITS.compressedBytes) throw new DocxPackageValidationError('DOCX_PACKAGE_TOO_LARGE', 'DOCX uploads may contain at most 32 MiB of compressed data.');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  } finally {
    stream.destroy();
  }
}

export async function runWorkspaceUploadWrite(params: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  actorUserId: string;
  targetPath: string;
  content?: Buffer;
  sourcePath?: string;
  createOnly?: boolean;
  idempotencyKey?: string;
  officeAttempt?: OfficeUploadAttempt;
  persistOfficeAttempt?: (attempt: OfficeUploadAttempt) => Promise<void>;
  beforeWrite?: () => Promise<void>;
  write: (onBeforeReplace: () => Promise<void>) => Promise<void>;
}): Promise<void> {
  params = { ...params, targetPath: normalizeWorkspaceRelativePath(params.targetPath), fileOptions: { ...params.fileOptions, workspace: params.workspace } };
  return withWorkspaceMutationLock(params.workspace.workspaceId, async () => {
    const office = params.targetPath.toLowerCase().endsWith('.docx');
    if (office && params.idempotencyKey && !params.persistOfficeAttempt) throw new Error('Retryable Word uploads require durable upload-session metadata.');
    if (!office || !params.officeAttempt) await params.beforeWrite?.();
    const parentDir = path.posix.dirname(params.targetPath);
    if (parentDir !== '.' && parentDir !== '/') {
      await createDirectory(parentDir, params.fileOptions);
    }

    const beforeRevision = await getWorkspaceFileRevision(params.targetPath, params.fileOptions);
    const storedBaseRevision = beforeRevision && !params.officeAttempt
      ? await ensureFileRevisionForCurrentContent({
          workspace: params.workspace,
          path: params.targetPath,
          contentHash: beforeRevision.sha256,
          sizeBytes: beforeRevision.stats.size,
          actorType: 'system',
        })
      : null;
    let transientUploadLockId: string | null = null;
    const idempotencyKey = params.idempotencyKey ?? randomUUID();
    const actorSessionId = `upload:${createHash('sha256').update(JSON.stringify([params.workspace.workspaceId, params.actorUserId, idempotencyKey])).digest('hex')}`;

    try {
      if (office) {
        const content = params.content ?? (params.sourcePath ? await readOfficeUploadSource(params.sourcePath) : null);
        if (!content) throw new Error('A Word upload requires the staged document bytes.');
        const state = await getFileCollaborationState({ workspace: params.workspace, path: params.targetPath, ensureDocument: true });
        if (!state.lineageId) throw new Error('The Word upload has no document identity.');
        const contentHash = sha256Buffer(content);
        const attempt: OfficeUploadAttempt = params.officeAttempt ?? {
          version: 1, workspaceId: params.workspace.workspaceId, actorUserId: params.actorUserId,
          path: params.targetPath, lineageId: state.lineageId, actorSessionId, idempotencyKey,
          expectedSha256: beforeRevision?.sha256 ?? null, baseRevisionId: storedBaseRevision?.id ?? null,
          contentHash, createOnly: params.createOnly ?? !beforeRevision,
        };
        if (attempt.version !== 1 || attempt.workspaceId !== params.workspace.workspaceId || attempt.actorUserId !== params.actorUserId
          || attempt.path !== params.targetPath || attempt.lineageId !== state.lineageId || attempt.actorSessionId !== actorSessionId
          || attempt.idempotencyKey !== idempotencyKey || attempt.contentHash !== contentHash
          || (params.createOnly !== undefined && attempt.createOnly !== params.createOnly)) throw new OfficeUploadRetryError();
        // The caller holds Upload-Session -> Workspace locks. This callback only
        // persists the already locked session; it must not acquire a new lock.
        // Repeat the durability barrier when the previous attempt failed after
        // metadata rename but before its directory fsync completed.
        await params.persistOfficeAttempt?.(attempt);
        const receipt = params.officeAttempt ? await findOfficeCommit(attempt) : null;
        const replayRevisionMatches = receipt?.status === 'completed'
          ? state.latestRevision?.id === receipt.revisionId
          : (state.latestRevision?.id ?? null) === attempt.baseRevisionId || state.latestRevision?.sourceSessionId === attempt.actorSessionId;
        const replay = !!receipt && beforeRevision?.sha256 === attempt.contentHash && replayRevisionMatches;
        if (params.officeAttempt && !replay && (receipt?.status === 'completed'
          || (beforeRevision?.sha256 ?? null) !== attempt.expectedSha256
          || (state.latestRevision?.id ?? null) !== attempt.baseRevisionId)) throw new OfficeUploadRetryError();
        if (beforeRevision && !attempt.createOnly && !replay) {
          const acquired = await acquireFileLock({
            workspace: params.workspace, path: params.targetPath,
            lockedByUserId: params.actorUserId, lockedBySessionId: actorSessionId,
            lockType: 'upload', ttlMs: 5 * 60 * 1000, baseRevisionId: attempt.baseRevisionId,
          });
          transientUploadLockId = acquired.lock.id;
        }
        const { writeWorkspaceFileContent } = await import('@/app/lib/files/write-service');
        await writeWorkspaceFileContent({
          workspace: params.workspace, fileOptions: params.fileOptions, actorUserId: params.actorUserId,
          actorSessionId, lockId: transientUploadLockId, path: params.targetPath, content,
          expectedSha256: attempt.expectedSha256, baseRevisionId: attempt.baseRevisionId,
          createOnly: attempt.createOnly, idempotencyKey,
        });
        return;
      }
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
            lockedBySessionId: actorSessionId,
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
          actorSessionId,
          lockId: transientUploadLockId,
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
            actorSessionId,
          });
        } catch (releaseError) {
          console.warn('[API] Failed to release transient upload lock:', releaseError);
        }
      }
    }
  });
}
