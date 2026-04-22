import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { fileTypeFromBuffer } from 'file-type';
import { fetchExternalResourceSafely } from '@/app/lib/security/safe-external-fetch';
import { generateStudioReferencePath, writeStudioReferenceFile } from '@/app/lib/integrations/studio-workspace';

const MAX_REFERENCE_SIZE = 10 * 1024 * 1024;

/**
 * Download and save an external image URL for use as a reference.
 *
 * POST /api/studio/references
 * Body: { url: string }
 *
 * Returns: { id, localUrl, originalUrl, mimeType, size }
 */
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
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
          { success: false, error: 'The URL does not point to a valid image file. Please provide a direct link to an image (JPEG, PNG, WebP, GIF, etc.).' },
          { status: 400 }
        );
      }
    } catch (e) {
      console.warn('[Studio Reference] file-type detection failed, falling back to content-type:', e);
      if (!contentType.startsWith('image/')) {
        return NextResponse.json(
          { success: false, error: 'The URL does not point to a valid image file. Please provide a direct link to an image.' },
          { status: 400 }
        );
      }
    }

    // Extract filename from URL
    let fileName = 'reference-image.jpg';
    try {
      const urlPath = new URL(finalUrl).pathname;
      const nameFromUrl = urlPath.split('/').pop();
      if (nameFromUrl) {
        fileName = nameFromUrl;
      }
    } catch {
      // Use default filename
    }

    const { id, relativePath } = generateStudioReferencePath(session.user.id, fileName);
    await writeStudioReferenceFile(session.user.id, id, buffer);

    return NextResponse.json({
      success: true,
      id,
      localUrl: `/api/studio/references/${id}`,
      originalUrl: finalUrl,
      mimeType: contentType,
      size: buffer.length,
      filePath: relativePath,
    }, { status: 201 });

  } catch (err) {
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
