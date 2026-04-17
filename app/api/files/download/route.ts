import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { createReadStream, getFileStats, validatePath } from '@/app/lib/filesystem/workspace-files';
import { Readable } from 'stream';
import { auth } from '@/app/lib/auth';
import archiver from 'archiver';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const MAX_ZIP_DOWNLOAD_SIZE = 1024 * 1024 * 1024;
const MAX_SINGLE_FILE_SIZE = 2 * 1024 * 1024 * 1024;

function resolveDownloadName(filePath: string): string {
  const basename = path.posix.basename(filePath);
  if (basename === '' || basename === '/') return 'workspace';
  return basename;
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'files-download',
  });
  if (!limited.ok) {
    return limited.response;
  }

  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath) {
    return NextResponse.json({ success: false, error: 'Path parameter is required' }, { status: 400 });
  }

  try {
    const stats = await getFileStats(filePath);
    const downloadName = resolveDownloadName(filePath);

    if (stats.isDirectory) {
      if (stats.size > MAX_ZIP_DOWNLOAD_SIZE) {
        return NextResponse.json(
          { success: false, error: 'Directory is too large to download as ZIP (max 1GB)' },
          { status: 413 }
        );
      }

      const fullPath = validatePath(filePath);
      const archive = archiver('zip', { zlib: { level: 1 } });
      const webStream = Readable.toWeb(archive) as ReadableStream<Uint8Array>;

      archive.directory(fullPath, downloadName);
      archive.finalize();

      return new NextResponse(webStream, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${downloadName}.zip"`,
        },
      });
    } else {
      if (stats.size > MAX_SINGLE_FILE_SIZE) {
        return NextResponse.json(
          { success: false, error: 'File is too large to download (max 2GB)' },
          { status: 413 }
        );
      }

      const { stream } = await createReadStream(filePath);
      const webStream = Readable.toWeb(stream) as ReadableStream<Uint8Array>;

      return new NextResponse(webStream, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${downloadName}"`,
          'Content-Length': stats.size.toString(),
        },
      });
    }
  } catch (error) {
    console.error('[API] File download error:', error);
    const message = error instanceof Error ? error.message : 'Failed to download file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}