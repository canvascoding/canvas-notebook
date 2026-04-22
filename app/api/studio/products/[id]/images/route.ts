import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { addProductImage } from '@/app/lib/integrations/studio-product-service';
import { ensureStudioAssetsWorkspace } from '@/app/lib/integrations/studio-workspace';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';
import { fetchExternalResourceSafely } from '@/app/lib/security/safe-external-fetch';

const MAX_URL_IMPORT_SIZE = 10 * 1024 * 1024;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  await ensureStudioAssetsWorkspace();

  const contentType = request.headers.get('content-type') ?? '';
  let fileData: { buffer: Buffer; fileName: string; mimeType: string; fileSize: number; width?: number; height?: number; sourceType: 'upload' | 'url_import'; sourceUrl?: string };

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fileData = {
      buffer,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      fileSize: buffer.length,
      sourceType: 'upload',
    };
  } else {
    let body: { url?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON or FormData required' }, { status: 400 });
    }
    if (!body.url) {
      return NextResponse.json({ success: false, error: 'URL is required for URL import' }, { status: 400 });
    }
    try {
      const { buffer, contentType, finalUrl } = await fetchExternalResourceSafely(body.url, {
        maxBytes: MAX_URL_IMPORT_SIZE,
        timeoutMs: 30000,
      });
      const mimeType = contentType.split(';')[0]?.trim() || 'application/octet-stream';
      const urlPath = new URL(finalUrl).pathname;
      const fileName = urlPath.split('/').pop() || 'imported-image.jpg';
      fileData = {
        buffer,
        fileName,
        mimeType,
        fileSize: buffer.length,
        sourceType: 'url_import',
        sourceUrl: finalUrl,
      };
    } catch (err) {
      return NextResponse.json({ success: false, error: `Failed to download image: ${err instanceof Error ? err.message : 'Unknown error'}` }, { status: 400 });
    }
  }

  try {
    const image = await addProductImage(id, session.user.id, fileData);
    return NextResponse.json({ success: true, image }, { status: 201 });
  } catch (err) {
    if (err instanceof StudioServiceError) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'LIMIT_EXCEEDED' ? 409 : 400;
      return NextResponse.json({ success: false, error: err.userMessage }, { status });
    }
    throw err;
  }
}
