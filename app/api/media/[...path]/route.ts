import { NextRequest, NextResponse } from 'next/server';
import { getFileStats, createReadStream } from '@/app/lib/filesystem/workspace-files';
import { Readable } from 'stream';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

const MEDIA_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
};

const ACTIVE_CONTENT_EXTENSIONS = new Set(['html', 'htm', 'js', 'mjs', 'svg']);

function getContentType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (ACTIVE_CONTENT_EXTENSIONS.has(ext)) {
    return 'application/octet-stream';
  }
  return MEDIA_TYPES[ext] || 'application/octet-stream';
}

function createSecurityHeaders(filePath: string): Headers {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const headers = new Headers({
    'X-Content-Type-Options': 'nosniff',
  });
  if (ACTIVE_CONTENT_EXTENSIONS.has(ext)) {
    headers.set('Content-Disposition', `attachment; filename="${filePath.split('/').pop() || 'file'}"`);
  }
  return headers;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  const { path: pathParts } = await context.params;
  const filePath = pathParts.join('/');
  const contentType = getContentType(filePath);

  try {
    const stats = await getFileStats(filePath, fileOptions);
    const fileSize = stats.size;
    const range = request.headers.get('range');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      if (
        Number.isNaN(start) ||
        Number.isNaN(end) ||
        start < 0 ||
        end < start ||
        end >= fileSize
      ) {
        return NextResponse.json(
          { success: false, error: 'Invalid range request' },
          { status: 416 }
        );
      }
      const chunksize = end - start + 1;
      
      const { stream } = await createReadStream(filePath, { start, end }, fileOptions);
      const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;

      const headers = new Headers({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize.toString(),
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'none'; script-src 'none'; frame-ancestors 'self';",
      });
      const securityHeaders = createSecurityHeaders(filePath);
      securityHeaders.forEach((value, key) => headers.set(key, value));

      return new NextResponse(webStream, { status: 206, headers });
    } else {
      const { stream } = await createReadStream(filePath, undefined, fileOptions);
      const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
      
      const headers = new Headers({
        'Content-Length': fileSize.toString(),
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'none'; script-src 'none'; frame-ancestors 'self';",
      });
      const securityHeaders = createSecurityHeaders(filePath);
      securityHeaders.forEach((value, key) => headers.set(key, value));
      return new NextResponse(webStream, { status: 200, headers });
    }
  } catch {
    return NextResponse.json({ success: false, error: 'File not found or unreadable' }, { status: 404 });
  }
}
