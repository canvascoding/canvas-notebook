import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { writeFile, createDirectory } from '@/app/lib/filesystem/workspace-files';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { auth } from '@/app/lib/auth';
import { convertImage, getImageConversionErrorMessage, isHeicFile } from '@/app/lib/images/convert';
import { fileTypeFromBuffer } from 'file-type';

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_TOTAL_SIZE = 500 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 100;

const VALID_FILENAME_REGEX = /^[a-zA-Z0-9._\-\s\/\(\)]+$/;
const INVALID_PATH_PATTERNS = ['..', '~', '//', '\\\\', ':', '*', '?', '"', '<', '>', '|'];

interface ConvertParams {
  format: 'jpg' | 'webp' | 'png';
  quality: number;
  maxDimension?: number;
}

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

function replaceExtension(filename: string, newExt: string): string {
  const lastDot = filename.lastIndexOf('.');
  const baseName = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  return baseName + newExt;
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 500,
      windowMs: 60_000,
      keyPrefix: 'files-upload',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const formData = await request.formData();
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

    let convertParamsList: (ConvertParams | null)[] | null = null;
    if (convertParamsRaw) {
      try {
        const parsed = JSON.parse(convertParamsRaw);
        if (Array.isArray(parsed) && parsed.length === files.length) {
          convertParamsList = parsed;
        }
      } catch {
        // Invalid JSON — ignore convertParams
      }
    }

    if (targetDir && targetDir !== '.') {
      await createDirectory(targetDir);
    }

    const uploadedFiles: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const sanitizedPath = sanitizeFilePath(file.name);

      if (!sanitizedPath || !isValidFilename(sanitizedPath)) {
        return NextResponse.json(
          { success: false, error: `Invalid filename: "${file.name}". Only alphanumeric characters, dots, dashes, underscores, spaces, parentheses, and path separators are allowed.` },
          { status: 400 }
        );
      }

      let buffer: Buffer = Buffer.from(await file.arrayBuffer());
      let filename = sanitizedPath;
      let mimeType = file.type || 'application/octet-stream';

      const convertParams = convertParamsList?.[i] ?? null;

      if (convertParams) {
        try {
          const result = await convertImage(buffer, filename, {
            format: convertParams.format,
            quality: convertParams.quality,
            maxDimension: convertParams.maxDimension,
          });
          buffer = result.buffer as Buffer;
          filename = replaceExtension(sanitizedPath, path.extname(result.filename) || `.${convertParams.format}`);
          mimeType = result.mimeType;
        } catch (err) {
          console.error(`[API] Image conversion failed for ${file.name}:`, err);
          return NextResponse.json(
            { success: false, error: getImageConversionErrorMessage(file.name, err) },
            { status: 400 }
          );
        }
      } else if (isImageMimeType(mimeType) || isHeicFile(filename, mimeType)) {
        const detectedType = await fileTypeFromBuffer(buffer);
        const isHeic = isHeicFile(filename, mimeType) ||
          (detectedType?.mime === 'image/heic' || detectedType?.mime === 'image/heif' || detectedType?.mime === 'image/heic-sequence');

        if (isHeic) {
          try {
            const result = await convertImage(buffer, filename, {
              format: 'jpg',
              quality: 80,
            });
            buffer = result.buffer as Buffer;
            filename = replaceExtension(sanitizedPath, '.jpg');
            mimeType = result.mimeType;
          } catch (err) {
            console.error(`[API] HEIC auto-conversion failed for ${file.name}:`, err);
            return NextResponse.json(
              { success: false, error: getImageConversionErrorMessage(file.name, err) },
              { status: 400 }
            );
          }
        }
      }

      const targetPath = path.posix.join(targetDir, filename);

      const parentDir = path.posix.dirname(targetPath);
      if (parentDir !== '.' && parentDir !== targetDir && parentDir !== '/') {
        await createDirectory(parentDir);
      }

      await writeFile(targetPath, buffer);
      uploadedFiles.push(filename);
    }

    clearFileTreeCache();

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
