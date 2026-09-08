import 'server-only';

import { createReadStream, getFileStats, type WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import { ensureFileRevisionForCurrentContent, getFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { sha256Buffer } from '@/app/lib/files/revision-guard';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';
import { DOCX_PACKAGE_LIMITS, DocxPackageValidationError } from './docx-package';
import { completeOfficeCommit, listPendingOfficeCommits } from './document-journal';

/** Bounded by bytes actually read, including a file that grows after stat. */
export async function readOfficeFileBytes(filePath: string, options: WorkspaceFileOperationOptions): Promise<Buffer> {
  const { stream, close } = await createReadStream(filePath, { end: DOCX_PACKAGE_LIMITS.compressedBytes }, options);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > DOCX_PACKAGE_LIMITS.compressedBytes) throw new DocxPackageValidationError('DOCX_PACKAGE_TOO_LARGE', 'DOCX files may contain at most 32 MiB of compressed data.');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  } finally {
    stream.destroy();
    await close();
  }
}

/** Caller holds the workspace mutex and supplies the hash of the actual file. */
export async function recoverOfficePublication(workspace: WorkspaceContext, lineageId: string, filePath: string, contentHash: string, sizeBytes: number): Promise<void> {
  filePath = normalizeWorkspaceRelativePath(filePath);
  for (const pending of await listPendingOfficeCommits({ workspaceId: workspace.workspaceId, lineageId })) {
    if (pending.afterHash !== contentHash || pending.path !== filePath) continue;
    const revision = await ensureFileRevisionForCurrentContent({
      workspace, path: filePath, contentHash, sizeBytes,
      actorUserId: pending.actorUserId, actorType: pending.actorType,
      sourceSessionId: pending.actorSessionId, baseRevisionId: pending.baseRevisionId,
    });
    await completeOfficeCommit(pending, revision.id);
  }
}

/** The response revision describes these exact bytes, never a separate later fetch. */
export async function readOfficeDocumentSnapshot(workspace: WorkspaceContext, filePath: string) {
  filePath = normalizeWorkspaceRelativePath(filePath);
  return withWorkspaceMutationLock(workspace.workspaceId, async () => {
    const options = { workspace };
    const content = await readOfficeFileBytes(filePath, options);
    const metadata = await getFileStats(filePath, options);
    const sha256 = sha256Buffer(content);
    const initialState = await getFileCollaborationState({ workspace, path: filePath, ensureDocument: true });
    if (!initialState.lineageId) throw new Error('Document identity is unavailable.');
    await recoverOfficePublication(workspace, initialState.lineageId, filePath, sha256, content.length);
    const revision = await ensureFileRevisionForCurrentContent({ workspace, path: filePath, contentHash: sha256, sizeBytes: content.length, actorType: 'system' });
    const collaboration = await getFileCollaborationState({ workspace, path: filePath, ensureDocument: true });
    return { path: filePath, content, stats: { size: content.length, modified: metadata.modified, permissions: metadata.permissions, sha256 }, revision, collaboration };
  });
}
