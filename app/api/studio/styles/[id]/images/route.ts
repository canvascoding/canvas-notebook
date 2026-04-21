import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { addStyleImage } from '@/app/lib/integrations/studio-style-service';
import { ensureStudioAssetsWorkspace } from '@/app/lib/integrations/studio-workspace';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

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
      const response = await fetch(body.url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        return NextResponse.json({ success: false, error: `Failed to fetch URL: ${response.status}` }, { status: 400 });
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length > MAX_URL_IMPORT_SIZE) {
        return NextResponse.json({ success: false, error: 'File exceeds 10MB limit' }, { status: 400 });
      }
      const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
      const urlPath = new URL(body.url).pathname;
      const fileName = urlPath.split('/').pop() || 'imported-image.jpg';
      fileData = {
        buffer,
        fileName,
        mimeType,
        fileSize: buffer.length,
        sourceType: 'url_import',
        sourceUrl: body.url,
      };
    } catch (err) {
      return NextResponse.json({ success: false, error: `Failed to download image: ${err instanceof Error ? err.message : 'Unknown error'}` }, { status: 400 });
    }
  }

  try {
    const image = await addStyleImage(id, fileData);
    return NextResponse.json({ success: true, image }, { status: 201 });
  } catch (err) {
    if (err instanceof StudioServiceError) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'LIMIT_EXCEEDED' ? 409 : 400;
      return NextResponse.json({ success: false, error: err.userMessage }, { status });
    }
    throw err;
  }
}
