import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { writeFile } from '@/app/lib/filesystem/workspace-files';
import { publishWorkspaceUpload } from '@/app/lib/filesystem/upload-events';
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
import { authenticatedNativeTextSessionEnabled } from '@/app/lib/collaboration/native-text-session-activation';
import { classifyFileVersionFileV1 } from '@/app/lib/file-version-center/policy-v1';
import { COMPAT_MARKDOWN_UPLOAD_MAX_BYTES, importCompatMarkdownUpload,
  type CompatMarkdownUploadResult } from '@/app/lib/files/compat-markdown-upload';
import type { WorkspaceUploadCommit } from '@/app/lib/files/upload-result';

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_TOTAL_SIZE = 500 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const workspaceResult = await requireRequestWorkspace(original, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);
  const nativeResults: CompatMarkdownUploadResult[] = [];
  const uploaded: Array<{ filename: string; targetPath: string; raw: boolean; size: number; committed?: WorkspaceUploadCommit }> = [];
  let nativeStop: Exclude<CompatMarkdownUploadResult, { status: 'completed' }> | undefined;
  let finishRawUploads: (() => Promise<void>) | undefined, rawEffectsStarted = false;

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
    finishRawUploads = async () => {
      if (rawEffectsStarted) return;
      rawEffectsStarted = true;
      const rawUploads = uploaded.filter(value => value.raw);
      if (!rawUploads.length) return;
      const uploadedPaths = rawUploads.map(value => value.targetPath);
      await syncPublicSharesAfterWrite(uploadedPaths, workspaceResult.workspace);
      for (const value of rawUploads) value.committed = await publishWorkspaceUpload(workspaceResult.workspace, value.targetPath);
      await recordAuditEvent({
        organizationId: workspaceResult.workspace.organizationId,
        workspaceId: workspaceResult.workspace.workspaceId,
        userId: workspaceResult.session.user.id,
        source: 'files', eventType: 'file', entityType: 'workspace_path', entityId: targetDir,
        action: 'file.upload', status: 'success', summary: `${uploadedPaths.length} file(s) uploaded.`,
        metadata: { targetDir, uploadedPaths, uploadedFiles: rawUploads.map(value => value.filename),
          totalSize: rawUploads.reduce((sum, value) => sum + value.size, 0),
          workspaceType: workspaceResult.workspace.workspaceType, converted: Boolean(convertParamsList) },
      });
    };

    const nativeEnabled = authenticatedNativeTextSessionEnabled();
    const sanitizedPaths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const sanitizedPath = sanitizeWorkspaceUploadPath(files[i].name);
      if (!sanitizedPath) return NextResponse.json({ success: false, error: `Invalid filename: "${files[i].name}".` }, { status: 400 });
      sanitizedPaths.push(sanitizedPath);
      if (nativeEnabled && classifyFileVersionFileV1(sanitizedPath) === 'markdown') {
        if (files[i].size > COMPAT_MARKDOWN_UPLOAD_MAX_BYTES) return NextResponse.json({ success: false,
          error: 'Markdown imports may contain at most 5 MiB.', code: 'MARKDOWN_UPLOAD_TOO_LARGE', path: sanitizedPath,
          maxBytes: COMPAT_MARKDOWN_UPLOAD_MAX_BYTES, actualBytes: files[i].size }, { status: 413 });
        if (convertParamsList?.[i]) return NextResponse.json({ success: false,
          error: 'Image conversion cannot be applied to a Markdown import.', code: 'MARKDOWN_UPLOAD_CONVERSION_UNSUPPORTED', path: sanitizedPath }, { status: 400 });
      }
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const sanitizedPath = sanitizedPaths[i];
      if (nativeEnabled && classifyFileVersionFileV1(sanitizedPath) === 'markdown') {
        const result = await importCompatMarkdownUpload({ request: original, workspace: workspaceResult.workspace, fileOptions,
          actorUserId: workspaceResult.session.user.id, targetDir, file, relativePath: sanitizedPath });
        nativeResults.push(result);
        if (result.status !== 'completed') { nativeStop = result; break; }
        uploaded.push({ filename: sanitizedPath, targetPath: result.locator.targetPath, size: file.size, raw: false, committed: result.committed });
        continue;
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
        if (nativeResults.length) throw Object.assign(new Error(getImageConversionErrorMessage(file.name, err)), {
          status: 400, code: 'UPLOAD_IMAGE_CONVERSION_FAILED',
        });
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
        content: normalized.buffer,
        write: (onBeforeReplace) => writeFile(
          targetPath,
          normalized.buffer,
          fileOptions,
          onBeforeReplace,
        ),
      });
      uploaded.push({ filename, targetPath, size: file.size, raw: true });
    }

    // Native Complete already owns these effects. The compatibility batch owns
    // them only for actual raw writes, including a preceding partial subset.
    await finishRawUploads();

    const completed = { count: uploaded.length, files: uploaded.map(value => value.filename),
      committed: uploaded.flatMap(value => value.committed ? [value.committed] : []) };
    const uploads = nativeResults.map(value => value.status === 'failed'
      ? { status: value.status, locator: value.locator, unlocated: value.unlocated, phase: value.phase, code: value.code }
      : { status: value.status, locator: value.locator, completion: value.completion });
    if (nativeStop?.status === 'pending') return NextResponse.json({ success: false, ...completed, uploads,
      error: 'The Markdown upload is not complete. Continue using its upload session.',
      code: nativeStop.completion.code ?? 'MARKDOWN_UPLOAD_RECOVERY_REQUIRED', completion: nativeStop.completion }, { status: 202 });
    if (nativeStop?.status === 'failed') return NextResponse.json({ success: false, ...completed, uploads,
      error: nativeStop.error, code: nativeStop.code, phase: nativeStop.phase,
      upload: nativeStop.locator, unlocated: nativeStop.unlocated }, { status: nativeStop.httpStatus });
    return NextResponse.json({ success: true, ...completed, ...(uploads.length ? { uploads } : {}) });
  } catch (error) {
    let rawEffectsUnconfirmed = false;
    if (nativeResults.length && finishRawUploads && !rawEffectsStarted) {
      try { await finishRawUploads(); } catch { rawEffectsUnconfirmed = true; }
    }
    // A later raw publication failure must not discard a real native session
    // locator. Retain only public completion facts, never a session record.
    const partial = nativeResults.length ? { count: uploaded.filter(value => value.committed).length,
      files: uploaded.filter(value => value.committed).map(value => value.filename),
      committed: uploaded.flatMap(value => value.committed ? [value.committed] : []),
      ...(rawEffectsUnconfirmed ? { rawEffectsUnconfirmed: true } : {}),
      uploads: nativeResults.map(value => value.status === 'failed'
        ? { status: value.status, locator: value.locator, unlocated: value.unlocated, phase: value.phase, code: value.code }
        : { status: value.status, locator: value.locator, completion: value.completion }) } : {};
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
          ...partial,
        },
        { status: error.status }
      );
    }
    console.error('[API] File upload error:', error);
    const message = error instanceof Error ? error.message : 'Failed to upload file';
    const status = error && typeof error === 'object' ? Reflect.get(error, 'status') : undefined;
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    return NextResponse.json(
      { success: false, error: message, ...(nativeResults.length && typeof code === 'string' ? { code } : {}), ...partial },
      { status: nativeResults.length && typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500 }
    );
  }
}
