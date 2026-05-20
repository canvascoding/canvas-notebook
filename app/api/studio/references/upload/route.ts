import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'node:fs/promises';
import { auth } from '@/app/lib/auth';
import { getUserUploadsStudioRefRoot } from '@/app/lib/runtime-data-paths';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const MAX_IMAGE_FILE_SIZE = 30 * 1024 * 1024;
const MAX_VIDEO_FILE_SIZE = 50 * 1024 * 1024;
const MAX_AUDIO_FILE_SIZE = 15 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 20;
const ALLOWED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'gif']);
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
  const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 100);
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

    if (!files || files.length === 0) {
      return NextResponse.json({ success: false, error: 'No files provided' }, { status: 400 });
    }

    if (files.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        { success: false, error: `Maximum ${MAX_FILES_PER_REQUEST} files per upload` },
        { status: 400 },
      );
    }

    const uploadRoot = getUserUploadsStudioRefRoot();
    await fs.mkdir(uploadRoot, { recursive: true });

    const results: Array<{
      path: string;
      name: string;
      mediaUrl: string;
      previewUrl: string;
    }> = [];

    for (const file of files) {
      const ext = path.extname(file.name).toLowerCase().replace('.', '');
      const maxFileSize = allowedFileSize(ext);
      if (!maxFileSize) {
        return NextResponse.json(
          { success: false, error: `File "${file.name}" is not supported. Allowed: PNG, JPG, JPEG, WebP, BMP, TIFF, GIF, MP4, MOV, MP3, WAV` },
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
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const uniqueName = `${timestamp}-${sanitizedName}`;
      const fullPath = path.join(uploadRoot, uniqueName);

      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(fullPath, buffer);

      const relativePath = `user-uploads/studio-references/${uniqueName}`;
      results.push({
        path: relativePath,
        name: file.name,
        mediaUrl: toMediaUrl(relativePath),
        previewUrl: toPreviewUrl(relativePath, 480),
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
