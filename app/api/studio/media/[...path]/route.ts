import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { Readable } from 'stream';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import { 
  resolveValidatedStudioAssetPath, 
  resolveValidatedStudioOutputPath,
  resolveValidatedUserUploadStudioRefPath
} from '@/app/lib/integrations/studio-paths';

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

function resolveStudioPath(encodedFilePath: string): string | null {
  if (encodedFilePath.startsWith('studio/outputs/')) {
    return resolveValidatedStudioOutputPath(encodedFilePath.slice('studio/outputs/'.length));
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

  const contentType = getContentType(fullPath);

  try {
    const stats = await fs.stat(fullPath);
    const fileSize = stats.size;
    const range = request.headers.get('range');

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${fileSize}` } });
      }

      let start = match[1] ? parseInt(match[1], 10) : NaN;
      let end = match[2] ? parseInt(match[2], 10) : NaN;

      if (Number.isNaN(start) && Number.isNaN(end)) {
        return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${fileSize}` } });
      }

      if (Number.isNaN(start)) {
        const suffixLength = end;
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
          return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${fileSize}` } });
        }
        start = Math.max(fileSize - suffixLength, 0);
        end = fileSize - 1;
      } else {
        end = Number.isNaN(end) ? fileSize - 1 : end;
      }

      if (start < 0 || end < start || start >= fileSize || end >= fileSize) {
        return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${fileSize}` } });
      }

      const chunksize = end - start + 1;
      const nodeStream = nodeFs.createReadStream(fullPath, { start, end });
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

      const headers = new Headers({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize.toString(),
        'Content-Type': contentType,
      });
      const securityHeaders = createSecurityHeaders(fullPath);
      securityHeaders.forEach((value, key) => headers.set(key, value));

      return new NextResponse(webStream, { status: 206, headers });
    }

    const nodeStream = nodeFs.createReadStream(fullPath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

    const headers = new Headers({
      'Content-Length': fileSize.toString(),
      'Content-Type': contentType,
    });
    const securityHeaders = createSecurityHeaders(fullPath);
    securityHeaders.forEach((value, key) => headers.set(key, value));

    return new NextResponse(webStream, { status: 200, headers });
  } catch {
    // Auto-cleanup orphaned preset previews
    try {
      if (encodedPath.startsWith('studio/assets/presets/')) {
        const dbLib = await import('@/app/lib/db');
        const schemaLib = await import('@/app/lib/db/schema');
        const ormLib = await import('drizzle-orm');
        const presetPath = encodedPath.slice('studio/assets/'.length);
        const wherePreviewPath = ormLib.or(
          ormLib.eq(schemaLib.studioPresets.previewImagePath, presetPath),
          ormLib.eq(schemaLib.studioPresets.previewImagePath, encodedPath),
        );
        const matchingPresets = await dbLib.db.select({ id: schemaLib.studioPresets.id })
          .from(schemaLib.studioPresets)
          .where(wherePreviewPath)
          .limit(1);

        if (matchingPresets.length > 0) {
          await dbLib.db.update(schemaLib.studioPresets)
            .set({ previewImagePath: null, updatedAt: new Date() })
            .where(wherePreviewPath);
          console.warn(`Auto-cleaned orphaned preset preview: ${presetPath}`);
        }
      }
    } catch (cleanupError) {
      console.warn('Failed to clean up orphaned preset preview:', cleanupError);
    }
    return NextResponse.json({ success: false, error: 'File not found or unreadable' }, { status: 404 });
  }
}
