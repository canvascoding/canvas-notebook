import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { fileTypeFromBuffer } from 'file-type';
import { fetchExternalResourceSafely } from '@/app/lib/security/safe-external-fetch';
import { getUserUploadsStudioRefRoot } from '@/app/lib/runtime-data-paths';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import path from 'node:path';
import fs from 'node:fs/promises';

const MAX_REFERENCE_SIZE = 20 * 1024 * 1024;

function sanitizeFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 100);
  return `${base}${ext}`;
}

/**
 * Download and save an external image URL for use as a reference.
 *
 * POST /api/studio/references
 * Body: { url: string }
 *
 * Returns: { path, name, mediaUrl, previewUrl }
 */
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'studio-url-download',
  });
  if (!limited.ok) {
    return limited.response;
  }

  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.url || typeof body.url !== 'string') {
    return NextResponse.json({ success: false, error: 'URL is required' }, { status: 400 });
  }

  const url = body.url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return NextResponse.json({ success: false, error: 'URL must start with http:// or https://' }, { status: 400 });
  }

  try {
    const { buffer, contentType, finalUrl } = await fetchExternalResourceSafely(url, {
      maxBytes: MAX_REFERENCE_SIZE,
      timeoutMs: 30000,
    });

    if (buffer.length === 0) {
      return NextResponse.json({ success: false, error: 'Downloaded file is empty' }, { status: 400 });
    }

    if (buffer.length > MAX_REFERENCE_SIZE) {
      return NextResponse.json(
        { success: false, error: `File exceeds ${MAX_REFERENCE_SIZE / (1024 * 1024)}MB limit` },
        { status: 400 }
      );
    }

    // Validate it's actually an image using magic bytes
    try {
      const fileType = await fileTypeFromBuffer(buffer);
      if (!fileType || !fileType.mime.startsWith('image/')) {
        return NextResponse.json(
          { success: false, error: 'The URL does not point to a valid image file. Please provide a direct link to an image (JPEG, PNG, WebP, etc.).' },
          { status: 400 }
        );
      }
    } catch {
      console.warn('[Studio Reference] file-type detection failed, falling back to content-type');
      if (!contentType.startsWith('image/')) {
        return NextResponse.json(
          { success: false, error: 'The URL does not point to a valid image file.' },
          { status: 400 }
        );
      }
    }

    // Extract filename from URL and sanitize
    let fileName = 'reference-image.jpg';
    try {
      const urlPath = new URL(finalUrl).pathname;
      const nameFromUrl = urlPath.split('/').pop();
      if (nameFromUrl) {
        fileName = sanitizeFilename(nameFromUrl);
      }
    } catch {
      // Use default filename
    }

    const uploadRoot = getUserUploadsStudioRefRoot();
    await fs.mkdir(uploadRoot, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const uniqueName = `${timestamp}-${fileName}`;
    const fullPath = path.join(uploadRoot, uniqueName);
    await fs.writeFile(fullPath, buffer);

    const relativePath = `user-uploads/studio-references/${uniqueName}`;
    return NextResponse.json({
      success: true,
      path: relativePath,
      name: fileName,
      mediaUrl: toMediaUrl(relativePath),
      previewUrl: toPreviewUrl(relativePath, 480),
      size: buffer.length,
    }, { status: 201 });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Studio Reference] Download failed:', errorMessage);

    if (err instanceof TypeError && (errorMessage.includes('fetch failed') || errorMessage.includes('ENOTFOUND') || errorMessage.includes('ETIMEDOUT'))) {
      return NextResponse.json(
        { success: false, error: 'Could not reach the image URL. Is it publicly accessible?' },
        { status: 400 }
      );
    }

    if (errorMessage.includes('abort') || errorMessage.includes('timeout') || errorMessage.includes('signal')) {
      return NextResponse.json(
        { success: false, error: 'Download timed out after 30 seconds. The image might be too large or the server too slow.' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { success: false, error: `Failed to download image: ${errorMessage}` },
      { status: 400 }
    );
  }
}
