import { NextRequest, NextResponse } from 'next/server';
import { getFileStats, createReadStream } from '@/app/lib/filesystem/workspace-files';
import { auth } from '@/app/lib/auth';
import { Readable } from 'stream';

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
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
};

function getContentType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return MEDIA_TYPES[ext] || 'application/octet-stream';
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
  const filePath = pathParts.join('/');
  const contentType = getContentType(filePath);

  try {
    const stats = await getFileStats(filePath);
    const fileSize = stats.size;
    const range = request.headers.get('range');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;
      
      const { stream } = await createReadStream(filePath, { start, end });
      const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;

      const headers = new Headers({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize.toString(),
        'Content-Type': contentType,
      });

      return new NextResponse(webStream, { status: 206, headers });
    } else {
      const { stream } = await createReadStream(filePath);
      const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
      
      const headers = new Headers({
        'Content-Length': fileSize.toString(),
        'Content-Type': contentType,
      });
      return new NextResponse(webStream, { status: 200, headers });
    }
  } catch {
    return NextResponse.json({ success: false, error: 'File not found or unreadable' }, { status: 404 });
  }
}
