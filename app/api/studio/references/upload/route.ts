import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'node:fs/promises';
import { auth } from '@/app/lib/auth';
import { getUserUploadsStudioRefRoot } from '@/app/lib/runtime-data-paths';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_FILES_PER_REQUEST = 20;
const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

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
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { success: false, error: `File "${file.name}" exceeds 20MB limit` },
          { status: 413 },
        );
      }

      const ext = path.extname(file.name).toLowerCase().replace('.', '');
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return NextResponse.json(
          { success: false, error: `File "${file.name}" is not a supported image format. Allowed: PNG, JPG, JPEG, WebP` },
          { status: 400 },
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