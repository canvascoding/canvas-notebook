import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { Readable } from 'stream';
import { getStudioOutputsRoot, getStudioAssetsRoot } from '@/app/lib/integrations/studio-workspace';
import fs from 'node:fs/promises';
import path from 'path';

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

function resolveStudioPath(encodedFilePath: string): string | null {
  // Allow paths under studio/outputs/ and studio/assets/
  if (encodedFilePath.startsWith('studio/outputs/')) {
    return path.join(getStudioOutputsRoot(), encodedFilePath.slice('studio/outputs/'.length));
  }
  if (encodedFilePath.startsWith('studio/assets/')) {
    return path.join(getStudioAssetsRoot(), encodedFilePath.slice('studio/assets/'.length));
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

  const contentType = getContentType(fullPath);

  try {
    const stats = await fs.stat(fullPath);
    const fileSize = stats.size;
    const range = request.headers.get('range');

    const nodeStream = (await fs.open(fullPath, 'r')).createReadStream();
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;

      const headers = new Headers({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize.toString(),
        'Content-Type': contentType,
      });

      return new NextResponse(webStream, { status: 206, headers });
    }

    const headers = new Headers({
      'Content-Length': fileSize.toString(),
      'Content-Type': contentType,
    });

    return new NextResponse(webStream, { status: 200, headers });
  } catch (error) {
    // Auto-cleanup orphaned preset previews
    try {
      if (encodedPath.startsWith('studio/assets/presets/')) {
        const dbLib = await import('@/app/lib/db');
        const schemaLib = await import('@/app/lib/db/schema');
        const ormLib = await import('drizzle-orm');
        const presetPath = encodedPath.slice('studio/assets/'.length);
        await dbLib.db.update(schemaLib.studioPresets)
          .set({ previewImagePath: null, updatedAt: new Date() })
          .where(ormLib.eq(schemaLib.studioPresets.previewImagePath, presetPath));
        console.warn(`Auto-cleaned orphaned preset preview: ${presetPath}`);
      }
    } catch (cleanupError) {
      console.warn('Failed to clean up orphaned preset preview:', cleanupError);
    }
    return NextResponse.json({ success: false, error: 'File not found or unreadable' }, { status: 404 });
  }
}
