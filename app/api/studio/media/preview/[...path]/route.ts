import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import { resolveValidatedStudioPath } from '@/app/lib/integrations/studio-paths';
import { Readable } from 'stream';
import {
  createHtmlPreviewDocument,
  getHtmlPreviewAssetContentType,
  HTML_PREVIEW_ASSET_CSP,
  HTML_PREVIEW_CSP,
  isHtmlFile,
} from '@/app/lib/html-preview';
import { canReadStudioMediaPath } from '@/app/lib/integrations/studio-media-access';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';

const STUDIO_HTML_PREVIEW_PREFIX = '/api/studio/media/preview';

function resolveStudioPath(encodedFilePath: string): string | null {
  return encodedFilePath.startsWith('studio/')
    ? resolveValidatedStudioPath(encodedFilePath)
    : null;
}

async function streamPreviewAsset(fullPath: string) {
  const stats = await fs.stat(fullPath);
  const nodeStream = nodeFs.createReadStream(fullPath);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      'Content-Type': getHtmlPreviewAssetContentType(fullPath),
      'Content-Length': stats.size.toString(),
      'Content-Security-Policy': HTML_PREVIEW_ASSET_CSP,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const studioRequest = await requireStudioRequestScope(request, session);
  if (!studioRequest.scope) return studioRequest.response;

  const { path: pathParts } = await context.params;
  const encodedPath = pathParts.map((p) => decodeURIComponent(p)).join('/');
  if (!(await canReadStudioMediaPath(encodedPath, studioRequest.scope))) {
    return NextResponse.json({ success: false, error: 'File not found or unreadable' }, { status: 404 });
  }
  const fullPath = resolveStudioPath(encodedPath);

  if (!fullPath) {
    return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
  }

  try {
    if (!isHtmlFile(fullPath)) {
      return await streamPreviewAsset(fullPath);
    }

    const html = await fs.readFile(fullPath, 'utf-8');
    const document = createHtmlPreviewDocument(html, encodedPath, STUDIO_HTML_PREVIEW_PREFIX);
    const body = Buffer.from(document, 'utf-8');
    const headers = new Headers({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length.toString(),
      'Content-Security-Policy': HTML_PREVIEW_CSP,
      'X-Content-Type-Options': 'nosniff',
    });

    return new NextResponse(body, { status: 200, headers });
  } catch {
    return NextResponse.json({ success: false, error: 'File not found or unreadable' }, { status: 404 });
  }
}
