import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { auth } from '@/app/lib/auth';
import { getUserUploadsStudioRefRoot } from '@/app/lib/runtime-data-paths';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getImageConversionErrorMessage } from '@/app/lib/images/convert';
import { normalizeUploadImageBuffer, parseUploadConvertParams } from '@/app/lib/images/upload-conversion';

const MAX_IMAGE_FILE_SIZE = 30 * 1024 * 1024;
const MAX_VIDEO_FILE_SIZE = 50 * 1024 * 1024;
const MAX_AUDIO_FILE_SIZE = 15 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 20;
const ALLOWED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'heic', 'heif']);
const ALLOWED_VIDEO_EXTENSIONS = new Set(['mp4', 'mov']);
const ALLOWED_AUDIO_EXTENSIONS = new Set(['mp3', 'wav']);

function allowedFileSize(extension: string): number | null {
  if (ALLOWED_IMAGE_EXTENSIONS.has(extension)) return MAX_IMAGE_FILE_SIZE;
  if (ALLOWED_VIDEO_EXTENSIONS.has(extension)) return MAX_VIDEO_FILE_SIZE;
  if (ALLOWED_AUDIO_EXTENSIONS.has(extension)) return MAX_AUDIO_FILE_SIZE;
  return null;
}

function sanitizeFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 100) || 'upload';
  return `${base}${ext}`;
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 100,
      windowMs: 60_000,
      keyPrefix: 'studio-ref-upload',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    const convertParamsRaw = formData.get('convertParams')?.toString();

    if (!files || files.length === 0) {
      return NextResponse.json({ success: false, error: 'No files provided' }, { status: 400 });
    }

    if (files.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        { success: false, error: `Maximum ${MAX_FILES_PER_REQUEST} files per upload` },
        { status: 400 },
      );
    }

    const parsedConvertParams = parseUploadConvertParams(convertParamsRaw, files.length);
    if (!parsedConvertParams.ok) {
      return NextResponse.json({ success: false, error: parsedConvertParams.error }, { status: 400 });
    }
    const convertParamsList = parsedConvertParams.params;

    const preparedFiles: Array<{
      buffer: Buffer;
      filename: string;
      size: number;
    }> = [];

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const ext = path.extname(file.name).toLowerCase().replace('.', '');
      const maxFileSize = allowedFileSize(ext);
      if (!maxFileSize) {
        return NextResponse.json(
          { success: false, error: `File "${file.name}" is not supported. Allowed: PNG, JPG, JPEG, WebP, BMP, TIFF, GIF, HEIC, HEIF, MP4, MOV, MP3, WAV` },
          { status: 400 },
        );
      }

      if (file.size > maxFileSize) {
        return NextResponse.json(
          { success: false, error: `File "${file.name}" exceeds ${Math.floor(maxFileSize / (1024 * 1024))}MB limit` },
          { status: 413 },
        );
      }

      const sanitizedName = sanitizeFilename(file.name);
      const buffer = Buffer.from(await file.arrayBuffer());
      const mimeType = file.type || 'application/octet-stream';
      const convertParams = convertParamsList?.[i] ?? null;

      let normalized;
      try {
        normalized = await normalizeUploadImageBuffer({
          buffer,
          filename: sanitizedName,
          mimeType,
          convertParams,
        });
      } catch (err) {
        console.error(`[API] Studio reference image conversion failed for ${file.name}:`, err);
        return NextResponse.json(
          { success: false, error: getImageConversionErrorMessage(file.name, err) },
          { status: 400 },
        );
      }

      const normalizedExt = path.extname(normalized.filename).toLowerCase().replace('.', '');
      const normalizedMaxSize = allowedFileSize(normalizedExt);
      if (!normalizedMaxSize) {
        return NextResponse.json(
          { success: false, error: `File "${file.name}" could not be saved as a supported media type` },
          { status: 400 },
        );
      }

      if (normalized.size > normalizedMaxSize) {
        return NextResponse.json(
          { success: false, error: `File "${file.name}" exceeds ${Math.floor(normalizedMaxSize / (1024 * 1024))}MB limit after processing` },
          { status: 413 },
        );
      }

      preparedFiles.push({
        buffer: normalized.buffer,
        filename: sanitizeFilename(normalized.filename),
        size: normalized.size,
      });
    }

    const uploadRoot = getUserUploadsStudioRefRoot();
    await fs.mkdir(uploadRoot, { recursive: true });

    const results: Array<{
      path: string;
      name: string;
      mediaUrl: string;
      previewUrl: string;
      size: number;
    }> = [];

    for (const file of preparedFiles) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const uniqueName = `${timestamp}-${randomUUID()}-${file.filename}`;
      const fullPath = path.join(uploadRoot, uniqueName);

      await fs.writeFile(fullPath, file.buffer);

      const relativePath = `user-uploads/studio-references/${uniqueName}`;
      results.push({
        path: relativePath,
        name: file.filename,
        mediaUrl: toMediaUrl(relativePath),
        previewUrl: toPreviewUrl(relativePath, 480),
        size: file.size,
      });
    }

    return NextResponse.json({
      success: true,
      count: results.length,
      files: results,
    });
  } catch (error) {
    console.error('[API] studio/references/upload error:', error);
    const message = error instanceof Error ? error.message : 'Upload failed';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
