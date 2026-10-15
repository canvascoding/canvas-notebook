import { WorkspacePathAliasError } from '@/app/lib/workspaces/path-guard';
import { randomUUID } from 'node:crypto';
import { createEmptyDocx } from '@/app/lib/office/empty-docx';
import { writeWorkspaceFileContent } from '@/app/lib/files/write-service';
import { fileVersionHistoryService } from '@/app/lib/file-version-center/history-service';
import { NextRequest } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { createDirectoryIfAbsent, writeFileIfAbsent } from '@/app/lib/filesystem/workspace-files';
import { createEmptyExcalidrawFileContent, isExcalidrawFilePath } from '@/app/lib/excalidraw-file';
import {
  WorkspaceFileRevisionError,
  assertWorkspaceFileRevisionAllowed,
  getWorkspaceFileRevision,
  workspaceRequiresRevisionCheck,
} from '@/app/lib/files/revision-guard';
import {
  FileCollaborationPolicyError,
  assertFileCollaborationWriteAllowed,
  ensureFileRevisionForCurrentContent,
  isDocxPath,
} from '@/app/lib/files/collaboration-policy';
import {
  applyRateLimit,
  invalidateWorkspaceFileViews,
  jsonError,
  jsonServerError,
  jsonSuccess,
  readJsonBody,
} from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { completeManualMarkdownCreate, MarkdownManualCreateError } from '@/app/lib/files/workspace-markdown-manual-create';

export async function POST(request: NextRequest) {
  // Native services require the local NextRequest constructor, also in compiled routes.
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const workspaceResult = await requireRequestWorkspace(original, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const rateLimitResponse = applyRateLimit(request, {
      limit: 20,
      windowMs: 60_000,
      keyPrefix: 'files-create',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body = await readJsonBody<{
      path?: string;
      type?: 'file' | 'directory';
      template?: 'excalidraw';
      requestId?: string;
    }>(request);
    const { path, type, template } = body;

    if (!path || !type) {
      return jsonError('Path and type are required', 400);
    }

    if (type === 'file' && typeof path === 'string' && /\.(?:md|markdown)$/iu.test(path)) {
      if (template !== undefined) return jsonError('A Markdown document cannot use a drawing template.', 400, { code: 'MARKDOWN_CREATE_INVALID_TEMPLATE' });
      const completion = await completeManualMarkdownCreate(original, { workspaceId: workspaceResult.workspace.workspaceId, path, requestId: body.requestId! });
      return completion.status === 'completed' ? jsonSuccess({ completion })
        : jsonError('The document creation is not yet confirmed. Keep this attempt and check it again.', 409, { code: completion.code, completion });
    }

    if (type === 'directory') {
      await createDirectoryIfAbsent(path, fileOptions);
    } else if (type === 'file' && isDocxPath(path)) {
      await writeWorkspaceFileContent({
        workspace: workspaceResult.workspace, fileOptions, actorUserId: workspaceResult.session.user.id,
        actorSessionId: randomUUID(), path, content: await createEmptyDocx(), createOnly: true,
        idempotencyKey: randomUUID(), signal: request.signal,
      });
    } else if (type === 'file') {
      await assertWorkspaceFileRevisionAllowed({
        path,
        options: fileOptions,
        requireExpectedRevision: workspaceRequiresRevisionCheck(workspaceResult.workspace),
      });
      await assertFileCollaborationWriteAllowed({
        workspace: workspaceResult.workspace,
        path,
        actorUserId: workspaceResult.session.user.id,
        actorSessionId: null,
        actorType: 'user',
      });
      const initialContent = template === 'excalidraw' || isExcalidrawFilePath(path)
        ? createEmptyExcalidrawFileContent()
        : '';
      await writeFileIfAbsent(path, initialContent, fileOptions);
      const revision = await getWorkspaceFileRevision(path, fileOptions);
      if (revision) {
        await ensureFileRevisionForCurrentContent({
          workspace: workspaceResult.workspace,
          path,
          contentHash: revision.sha256,
          sizeBytes: revision.stats.size,
          actorUserId: workspaceResult.session.user.id,
          actorType: 'user',
          sourceSessionId: null,
        });
        // The revision ledger alone is metadata-only. Bind the initial bytes
        // now so history works before the editor's first autosave/session.
        await fileVersionHistoryService.capture({
          workspace: workspaceResult.workspace,
          path,
          content: initialContent,
          source: 'initial',
          actorUserId: workspaceResult.session.user.id,
          actorType: 'user',
        });
      }
    } else {
      return jsonError('Invalid type', 400);
    }

    invalidateWorkspaceFileViews({
      fileOptions,
      fullTree: true,
      mutations: [{ path, type: type === 'directory' ? 'addDir' : 'add' }],
    });
    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id,
      source: 'files',
      eventType: 'file',
      entityType: 'workspace_path',
      entityId: path,
      action: type === 'directory' ? 'file.directory.create' : 'file.create',
      status: 'success',
      summary: `${type} created at ${path}.`,
      metadata: {
        path,
        type,
        template: template ?? null,
        workspaceType: workspaceResult.workspace.workspaceType,
      },
    });

    return jsonSuccess();
  } catch (error) {
    if (error instanceof MarkdownManualCreateError) return jsonError(error.message, error.status, { code: error.code });
    if (error instanceof WorkspacePathAliasError) return jsonError(error.message, error.status, { code: error.code });
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      return jsonError('A file or folder already exists at this path.', 409, { code: 'PATH_EXISTS' });
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
    return jsonServerError('[API] File create error:', error, 'Failed to create path');
  }
}
