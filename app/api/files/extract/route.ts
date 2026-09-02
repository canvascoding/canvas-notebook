import { NextRequest } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  extractWorkspaceZip,
  ZipExtractionError,
} from '@/app/lib/filesystem/zip-extraction';
import { initializeCopiedFileCollaborationPaths } from '@/app/lib/files/collaboration-policy';
import { syncPublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import {
  applyRateLimit,
  invalidateWorkspaceFileViews,
  jsonError,
  jsonServerError,
  jsonSuccess,
  readJsonBody,
} from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

interface ExtractZipRequestBody {
  path?: string;
  targetDir?: string;
}

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const rateLimitResponse = applyRateLimit(request, {
      limit: 10,
      windowMs: 60_000,
      keyPrefix: 'files-extract',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const { path, targetDir } = await readJsonBody<ExtractZipRequestBody>(request);
    if (!path || !targetDir) {
      return jsonError('path and targetDir are required', 400);
    }

    const result = await extractWorkspaceZip(path, targetDir, fileOptions);
    await initializeCopiedFileCollaborationPaths({
      workspace: workspaceResult.workspace,
      paths: result.files,
    });
    await syncPublicSharesAfterWrite(result.files, workspaceResult.workspace);
    invalidateWorkspaceFileViews({
      fileOptions,
      subtreeDirs: [result.targetDir],
      mutations: result.files.map((filePath) => ({ path: filePath, type: 'add' as const })),
    });
    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id,
      source: 'files',
      eventType: 'file',
      entityType: 'workspace_path',
      entityId: path,
      action: 'file.zip_extract',
      status: 'success',
      summary: `${result.files.length} file(s) extracted from ${path}.`,
      metadata: {
        archivePath: path,
        targetDir: result.targetDir,
        extractedFiles: result.files,
        createdDirectories: result.directories,
        workspaceType: workspaceResult.workspace.workspaceType,
      },
    });

    return jsonSuccess({
      targetDir: result.targetDir,
      files: result.files,
      directories: result.directories,
    });
  } catch (error) {
    if (error instanceof ZipExtractionError) {
      return jsonError(error.message, error.status);
    }
    return jsonServerError('[API] ZIP extraction error:', error, 'Failed to extract ZIP archive');
  }
}
