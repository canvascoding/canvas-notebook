import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { getSession } from '@/app/lib/auth/session';
import { validatePath } from '@/app/lib/ssh/sftp-client';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const MIME_TYPES: Record<string, string> = {
  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  // Documents
  pdf: 'application/pdf',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    // Rate limiting
    const limited = rateLimit(request, {
      limit: 120,
      windowMs: 60_000,
      keyPrefix: 'media',
    });
    if (!limited.ok) {
      return limited.response;
    }

    // Authentication check
    const session = await getSession();
    if (!session.isLoggedIn) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Only works in local FS mode
    if (process.env.SSH_USE_LOCAL_FS !== 'true') {
      return NextResponse.json(
        { success: false, error: 'Media serving requires local filesystem mode.' },
        { status: 400 }
      );
    }

    // Get file path from params
    const { path: pathSegments } = await params;
    if (!pathSegments || pathSegments.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Path parameter is required' },
        { status: 400 }
      );
    }

    const filePath = pathSegments.join('/');
    const fullPath = validatePath(filePath);

    // Check if file exists
    let stats;
    try {
      stats = await fs.stat(fullPath);
    } catch {
      return NextResponse.json(
        { success: false, error: 'File not found' },
        { status: 404 }
      );
    }

    if (!stats.isFile()) {
      return NextResponse.json(
        { success: false, error: 'Path is not a file' },
        { status: 400 }
      );
    }

    // Read and serve file
    const buffer = await fs.readFile(fullPath);
    const mimeType = getMimeType(filePath);
    const etag = `W/"${stats.size}-${stats.mtimeMs}"`;

    // Check ETag for caching
    const requestEtag = request.headers.get('if-none-match');
    if (requestEtag && requestEtag === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'private, max-age=300',
        },
      });
    }

    // Return file
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': stats.size.toString(),
        'Cache-Control': 'private, max-age=300',
        ETag: etag,
      },
    });
  } catch (error) {
    console.error('[API] Media serve error:', error);
    const message = error instanceof Error ? error.message : 'Failed to serve media';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
