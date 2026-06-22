import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { auth } from '@/app/lib/auth';
import { parseMultipartFormData } from '@/app/lib/api/form-data';
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

    const parsedFormData = await parseMultipartFormData(request);
    if (!parsedFormData.ok) {
      return parsedFormData.response;
    }
    const formData = parsedFormData.formData;
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

    const uploadRoot = getUserUploadsStudioRefRoot();
    await fs.mkdir(uploadRoot, { recursive: true });

    const results: Array<{
      path: string;
      name: string;
      mediaUrl: string;
      previewUrl: string;
      size: number;
    }> = [];
    const errors: string[] = [];

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const ext = path.extname(file.name).toLowerCase().replace('.', '');
      const maxFileSize = allowedFileSize(ext);
      if (!maxFileSize) {
        errors.push(`File "${file.name}" is not supported. Allowed: PNG, JPG, JPEG, WebP, BMP, TIFF, GIF, HEIC, HEIF, MP4, MOV, MP3, WAV`);
        continue;
      }

      if (file.size > maxFileSize) {
        errors.push(`File "${file.name}" exceeds ${Math.floor(maxFileSize / (1024 * 1024))}MB limit`);
        continue;
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
        errors.push(getImageConversionErrorMessage(file.name, err));
        continue;
      }

      const normalizedExt = path.extname(normalized.filename).toLowerCase().replace('.', '');
      const normalizedMaxSize = allowedFileSize(normalizedExt);
      if (!normalizedMaxSize) {
        errors.push(`File "${file.name}" could not be saved as a supported media type`);
        continue;
      }

      if (normalized.size > normalizedMaxSize) {
        errors.push(`File "${file.name}" exceeds ${Math.floor(normalizedMaxSize / (1024 * 1024))}MB limit after processing`);
        continue;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = sanitizeFilename(normalized.filename);
      const uniqueName = `${timestamp}-${randomUUID()}-${filename}`;
      const fullPath = path.join(uploadRoot, uniqueName);

      try {
        await fs.writeFile(fullPath, normalized.buffer);
      } catch (err) {
        console.error(`[API] Studio reference upload write failed for ${file.name}:`, err);
        errors.push(`${file.name}: Upload could not be saved`);
        continue;
      }

      const relativePath = `user-uploads/studio-references/${uniqueName}`;
      results.push({
        path: relativePath,
        name: filename,
        mediaUrl: toMediaUrl(relativePath),
        previewUrl: toPreviewUrl(relativePath, 480),
        size: normalized.size,
      });
    }

    if (results.length === 0) {
      return NextResponse.json(
        { success: false, error: errors.join('; ') || 'All uploads failed' },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      count: results.length,
      files: results,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('[API] studio/references/upload error:', error);
    const message = error instanceof Error ? error.message : 'Upload failed';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
