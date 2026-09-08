import { WorkspacePathAliasError } from '@/app/lib/workspaces/path-guard';
import { NextRequest } from 'next/server';
import {
  WorkspaceFileRevisionError,
} from '@/app/lib/files/revision-guard';
import {
  FileCollaborationPolicyError,
} from '@/app/lib/files/collaboration-policy';
import { writeWorkspaceFileContent, OfficeWriteError } from '@/app/lib/files/write-service';
import { OfficeJournalError } from '@/app/lib/office/document-journal';
import { DocxPackageValidationError } from '@/app/lib/office/docx-package';
import { WorkspaceMutationLockError } from '@/app/lib/files/workspace-mutation-lock';
import {
  applyRateLimit,
  jsonError,
  jsonServerError,
  jsonSuccess,
  readJsonBody,
} from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function POST(request: NextRequest) {
  try {
    const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
    if (workspaceResult.response) return workspaceResult.response;
    const fileOptions = workspaceFileOptions(workspaceResult.workspace);

    const rateLimitResponse = applyRateLimit(request, {
      limit: 90,
      windowMs: 60_000,
      keyPrefix: 'files-write',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body = await readJsonBody<{
      path?: string;
      content?: string;
      expectedSha256?: string | null;
      baseRevisionId?: string | null;
      sessionId?: string;
      lockId?: string;
      idempotencyKey?: string;
      createOnly?: boolean;
    }>(request);
    const { path, content, expectedSha256, baseRevisionId } = body;

    if (typeof path !== 'string' || !path || typeof content !== 'string') {
      return jsonError('Path and content are required', 400);
    }

    // Check if content is base64 encoded (prefix with base64: to distinguish from plain text)
    let finalContent: Buffer | string = content;
    if (typeof content === 'string' && content.startsWith('base64:')) {
      finalContent = Buffer.from(content.substring(7), 'base64');
    }

    const data = await writeWorkspaceFileContent({
      workspace: workspaceResult.workspace,
      fileOptions,
      actorUserId: workspaceResult.session.user.id,
      actorSessionId: body.sessionId,
      lockId: body.lockId,
      idempotencyKey: body.idempotencyKey,
      createOnly: body.createOnly === true,
      signal: request.signal,
      path,
      content: finalContent,
      encoded: content.startsWith('base64:'),
      expectedSha256,
      baseRevisionId: baseRevisionId ?? null,
    });
    return jsonSuccess({ data });
  } catch (error) {
    if (error instanceof WorkspacePathAliasError) return jsonError(error.message, error.status, { code: error.code });
    if (error instanceof DocxPackageValidationError || error instanceof OfficeWriteError || error instanceof WorkspaceMutationLockError || error instanceof OfficeJournalError) {
      return jsonError(error.message, error.status, { code: error.code });
    }
    if (error instanceof WorkspaceFileRevisionError) {
      return jsonError(error.message, error.status, {
        code: error.code,
        path: error.path,
        expectedSha256: error.expectedSha256,
        currentSha256: error.currentSha256,
        currentStats: error.currentStats,
      });
    }
    if (error instanceof FileCollaborationPolicyError) {
      return jsonError(error.message, error.status, {
        code: error.code,
        path: error.path,
        currentRevisionId: error.currentRevisionId,
        baseRevisionId: error.baseRevisionId,
        activeLock: error.activeLock,
      });
    }
    return jsonServerError('[API] File write error:', error, 'Failed to write file');
  }
}
