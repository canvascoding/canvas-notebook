import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { writeFile } from '@/app/lib/filesystem/workspace-files';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { invalidateFileReferenceCache } from '@/app/lib/filesystem/file-reference-cache';
import { publishWorkspaceFileMutation } from '@/app/lib/filesystem/file-watcher';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { parseMultipartFormData } from '@/app/lib/api/form-data';
import { getImageConversionErrorMessage } from '@/app/lib/images/convert';
import { normalizeUploadImageBuffer, parseUploadConvertParams } from '@/app/lib/images/upload-conversion';
import { syncPublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { FileCollaborationPolicyError } from '@/app/lib/files/collaboration-policy';
import { WORKSPACE_UPLOAD_MAX_FILES } from '@/app/lib/files/upload-limits';
import { sanitizeWorkspaceUploadPath } from '@/app/lib/files/upload-paths';
import { runWorkspaceUploadWrite } from '@/app/lib/files/workspace-upload-flow';

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_TOTAL_SIZE = 500 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const limited = rateLimit(request, {
      limit: 500,
      windowMs: 60_000,
      keyPrefix: 'files-upload',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const parsedFormData = await parseMultipartFormData(request);
    if (!parsedFormData.ok) {
      return parsedFormData.response;
    }
    const formData = parsedFormData.formData;
    const files = formData.getAll('files') as File[];
    const targetDir = formData.get('path')?.toString() || '.';
    const convertParamsRaw = formData.get('convertParams')?.toString();

    if (!files || files.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Files are required' },
        { status: 400 }
      );
    }

    if (files.length > WORKSPACE_UPLOAD_MAX_FILES) {
      return NextResponse.json(
        {
          success: false,
          error: `Maximum ${WORKSPACE_UPLOAD_MAX_FILES} files per upload`,
          code: 'UPLOAD_TOO_MANY_FILES',
          maxFiles: WORKSPACE_UPLOAD_MAX_FILES,
          actualFiles: files.length,
        },
        { status: 400 }
      );
    }

    let totalSize = 0;
    for (const file of files) {
      totalSize += file.size;
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          {
            success: false,
            error: `File "${file.name}" exceeds the 100 MB compatibility-route limit. Use the chunked uploader for files up to 5 GB.`,
            code: 'UPLOAD_FILE_TOO_LARGE',
            path: file.name,
            maxBytes: MAX_FILE_SIZE,
            actualBytes: file.size,
          },
          { status: 413 }
        );
      }
    }

    if (totalSize > MAX_TOTAL_SIZE) {
      return NextResponse.json(
        {
          success: false,
          error: 'This compatibility request exceeds 500 MB. Use the chunked uploader for larger batches.',
          code: 'UPLOAD_TOTAL_TOO_LARGE',
          maxBytes: MAX_TOTAL_SIZE,
          actualBytes: totalSize,
        },
        { status: 413 }
      );
    }

    const parsedConvertParams = parseUploadConvertParams(convertParamsRaw, files.length);
    if (!parsedConvertParams.ok) {
      return NextResponse.json({ success: false, error: parsedConvertParams.error }, { status: 400 });
    }
    const convertParamsList = parsedConvertParams.params;

    const uploadedFiles: string[] = [];
    const uploadedPaths: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const sanitizedPath = sanitizeWorkspaceUploadPath(file.name);

      if (!sanitizedPath) {
        return NextResponse.json(
          { success: false, error: `Invalid filename: "${file.name}". Only alphanumeric characters, dots, dashes, underscores, spaces, parentheses, and path separators are allowed.` },
          { status: 400 }
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      let filename = sanitizedPath;
      const mimeType = file.type || 'application/octet-stream';

      const convertParams = convertParamsList?.[i] ?? null;

      let normalized;
      try {
        normalized = await normalizeUploadImageBuffer({
          buffer,
          filename,
          mimeType,
          convertParams,
        });
      } catch (err) {
        console.error(`[API] Image conversion failed for ${file.name}:`, err);
        return NextResponse.json(
          { success: false, error: getImageConversionErrorMessage(file.name, err) },
          { status: 400 }
        );
      }
      filename = normalized.filename;

      const targetPath = path.posix.join(targetDir, filename);
      await runWorkspaceUploadWrite({
        workspace: workspaceResult.workspace,
        fileOptions,
        actorUserId: workspaceResult.session.user.id,
        targetPath,
        write: () => writeFile(targetPath, normalized.buffer, fileOptions),
      });
      uploadedFiles.push(filename);
      uploadedPaths.push(targetPath);
    }

    await syncPublicSharesAfterWrite(uploadedPaths, workspaceResult.workspace);
    clearFileTreeCache(fileOptions.workspace?.workspaceId);
    invalidateFileReferenceCache(fileOptions);
    for (const uploadedPath of uploadedPaths) {
      publishWorkspaceFileMutation({
        workspace: workspaceResult.workspace,
        relativePath: uploadedPath,
        type: 'add',
      });
    }
    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id,
      source: 'files',
      eventType: 'file',
      entityType: 'workspace_path',
      entityId: targetDir,
      action: 'file.upload',
      status: 'success',
      summary: `${uploadedPaths.length} file(s) uploaded.`,
      metadata: {
        targetDir,
        uploadedPaths,
        uploadedFiles,
        totalSize,
        workspaceType: workspaceResult.workspace.workspaceType,
        converted: Boolean(convertParamsList),
      },
    });

    return NextResponse.json({ success: true, count: files.length, files: uploadedFiles });
  } catch (error) {
    if (error instanceof FileCollaborationPolicyError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          code: error.code,
          path: error.path,
          currentRevisionId: error.currentRevisionId,
          baseRevisionId: error.baseRevisionId,
          activeLock: error.activeLock,
        },
        { status: error.status }
      );
    }
    console.error('[API] File upload error:', error);
    const message = error instanceof Error ? error.message : 'Failed to upload file';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
