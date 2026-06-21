import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { writeFile, createDirectory } from '@/app/lib/filesystem/workspace-files';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { invalidateFileReferenceCache } from '@/app/lib/filesystem/file-reference-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { parseMultipartFormData } from '@/app/lib/api/form-data';
import { getImageConversionErrorMessage } from '@/app/lib/images/convert';
import { normalizeUploadImageBuffer, parseUploadConvertParams } from '@/app/lib/images/upload-conversion';
import { syncPublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_TOTAL_SIZE = 500 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 100;

const VALID_FILENAME_REGEX = /^[a-zA-Z0-9._\-\s\/\(\)]+$/;
const INVALID_PATH_PATTERNS = ['..', '~', '//', '\\\\', ':', '*', '?', '"', '<', '>', '|'];

function isValidFilename(filename: string): boolean {
  if (INVALID_PATH_PATTERNS.some(pattern => filename.includes(pattern))) {
    return false;
  }
  return VALID_FILENAME_REGEX.test(filename);
}

function sanitizeFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const sanitized = segments
    .map(segment => path.posix.basename(segment))
    .filter(segment => segment.length > 0 && segment !== '.' && segment !== '..');
  return sanitized.join('/');
}

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

    if (files.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        { success: false, error: `Maximum ${MAX_FILES_PER_REQUEST} files per upload` },
        { status: 400 }
      );
    }

    let totalSize = 0;
    for (const file of files) {
      totalSize += file.size;
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { success: false, error: `File "${file.name}" exceeds maximum size of 100MB` },
          { status: 413 }
        );
      }
    }

    if (totalSize > MAX_TOTAL_SIZE) {
      return NextResponse.json(
        { success: false, error: `Total upload size exceeds maximum of 500MB` },
        { status: 413 }
      );
    }

    const parsedConvertParams = parseUploadConvertParams(convertParamsRaw, files.length);
    if (!parsedConvertParams.ok) {
      return NextResponse.json({ success: false, error: parsedConvertParams.error }, { status: 400 });
    }
    const convertParamsList = parsedConvertParams.params;

    if (targetDir && targetDir !== '.') {
      await createDirectory(targetDir, fileOptions);
    }

    const uploadedFiles: string[] = [];
    const uploadedPaths: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const sanitizedPath = sanitizeFilePath(file.name);

      if (!sanitizedPath || !isValidFilename(sanitizedPath)) {
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

      const parentDir = path.posix.dirname(targetPath);
      if (parentDir !== '.' && parentDir !== targetDir && parentDir !== '/') {
        await createDirectory(parentDir, fileOptions);
      }

      await writeFile(targetPath, normalized.buffer, fileOptions);
      uploadedFiles.push(filename);
      uploadedPaths.push(targetPath);
    }

    await syncPublicSharesAfterWrite(uploadedPaths, workspaceResult.workspace);
    clearFileTreeCache(fileOptions.workspace?.workspaceId);
    invalidateFileReferenceCache(fileOptions);

    return NextResponse.json({ success: true, count: files.length, files: uploadedFiles });
  } catch (error) {
    console.error('[API] File upload error:', error);
    const message = error instanceof Error ? error.message : 'Failed to upload file';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
