import { NextRequest, NextResponse } from 'next/server';
import { getFileStats, createReadStream } from '@/app/lib/filesystem/workspace-files';
import { auth } from '@/app/lib/auth';
import { Readable } from 'stream';

const HTML_EXTENSIONS = new Set(['html', 'htm']);

function isHtmlFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return HTML_EXTENSIONS.has(ext);
}

const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
].join('; ');

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { path: pathParts } = await context.params;
  const filePath = pathParts.join('/');

  if (!isHtmlFile(filePath)) {
    return NextResponse.json({ success: false, error: 'Preview only available for HTML files' }, { status: 400 });
  }

  try {
    const stats = await getFileStats(filePath);
    const fileSize = stats.size;

    const { stream } = await createReadStream(filePath);
    const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;

    const headers = new Headers({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': fileSize.toString(),
      'Content-Security-Policy': PREVIEW_CSP,
      'X-Content-Type-Options': 'nosniff',
    });

    return new NextResponse(webStream, { status: 200, headers });
  } catch {
    return NextResponse.json({ success: false, error: 'File not found or unreadable' }, { status: 404 });
  }
}