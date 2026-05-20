import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import {
  resolveValidatedStudioEditPath,
  resolveValidatedStudioAssetPath,
  resolveValidatedStudioOutputPath,
  resolveValidatedUserUploadStudioRefPath,
} from '@/app/lib/integrations/studio-paths';
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

function resolveStudioPath(encodedFilePath: string): string | null {
  if (encodedFilePath.startsWith('studio/outputs/')) {
    return resolveValidatedStudioOutputPath(encodedFilePath.slice('studio/outputs/'.length));
  }
  if (encodedFilePath.startsWith('studio/edits/')) {
    return resolveValidatedStudioEditPath(encodedFilePath.slice('studio/edits/'.length));
  }
  if (encodedFilePath.startsWith('studio/assets/')) {
    return resolveValidatedStudioAssetPath(encodedFilePath.slice('studio/assets/'.length));
  }
  if (encodedFilePath.startsWith('user-uploads/studio-references/')) {
    return resolveValidatedUserUploadStudioRefPath(encodedFilePath.slice('user-uploads/studio-references/'.length));
  }
  return null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { path: pathParts } = await context.params;
  const encodedPath = pathParts.map((p) => decodeURIComponent(p)).join('/');
  const fullPath = resolveStudioPath(encodedPath);

  if (!fullPath) {
    return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
  }

  if (!isHtmlFile(fullPath)) {
    return NextResponse.json({ success: false, error: 'Preview only available for HTML files' }, { status: 400 });
  }

  try {
    const stats = await fs.stat(fullPath);
    const fileSize = stats.size;

    const nodeStream = nodeFs.createReadStream(fullPath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

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
