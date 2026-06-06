import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { stat } from 'fs/promises';

import { auth } from '@/app/lib/auth';
import { findFilePath } from '@/app/lib/filesystem/upload-handler';
import {
  getPreviewContentType,
  getPreviewPreset,
  isSupportedPreviewExtension,
  renderCachedMediaPreview,
  resolvePreviewWidth,
} from '@/app/lib/files/media-preview';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const SUPPORTED_UPLOAD_IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp',
]);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'files-upload-preview',
  });
  if (!limited.ok) {
    return limited.response;
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id: fileId } = await context.params;
    if (!fileId) {
      return NextResponse.json({ success: false, error: 'File ID required' }, { status: 400 });
    }

    const extension = path.extname(fileId).slice(1).toLowerCase();
    if (!SUPPORTED_UPLOAD_IMAGE_EXTENSIONS.has(extension) || !isSupportedPreviewExtension(extension)) {
      return NextResponse.json({ success: false, error: 'Preview only available for image uploads' }, { status: 415 });
    }

    const filePath = await findFilePath(fileId);
    if (!filePath) {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    const stats = await stat(filePath);
    if (!stats.isFile()) {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const preset = getPreviewPreset(searchParams.get('preset'));
    const width = resolvePreviewWidth(searchParams.get('w'), preset);

    const preview = await renderCachedMediaPreview({
      inputPath: filePath,
      cacheIdentity: `upload:${fileId}`,
      extension,
      width,
      preset,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });

    const requestEtag = request.headers.get('if-none-match');
    if (requestEtag && requestEtag === preview.etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: preview.etag,
          'Cache-Control': 'private, max-age=86400, immutable',
        },
      });
    }

    return new NextResponse(preview.body, {
      headers: {
        'Content-Type': getPreviewContentType(preview.format),
        'Cache-Control': 'private, max-age=86400, immutable',
        ETag: preview.etag,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[API] Upload preview error:', error);
    const message = error instanceof Error ? error.message : 'Failed to render upload preview';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

