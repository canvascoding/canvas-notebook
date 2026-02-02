import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { createReadStream, getFileStats, validatePath } from '@/app/lib/ssh/sftp-client';
import { Readable } from 'stream';
import { auth } from '@/app/lib/auth';
import archiver from 'archiver';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath) {
    return NextResponse.json({ success: false, error: 'Path parameter is required' }, { status: 400 });
  }

  try {
    const stats = await getFileStats(filePath);
    const filename = path.posix.basename(filePath);

    if (stats.isDirectory) {
      // ZIP Streaming for directories
      const archive = archiver('zip', {
        zlib: { level: 1 }, // Fastest compression for better UX
      });

      // Convert Node.js stream to Web Stream
      const stream = Readable.toWeb(archive) as ReadableStream<Uint8Array>;

      // Start archiving in the background. Do not await this.
      // The stream will be consumed by the NextResponse.
      (async () => {
        try {
          const fullPath = validatePath(filePath);
          archive.directory(fullPath, filename);
          await archive.finalize();
        } catch (error) {
          // If archiver fails, it will emit an error on the stream.
          archive.emit('error', error as Error);
        }
      })();

      return new NextResponse(stream, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${filename}.zip"`,
        },
      });
    } else {
      // Handle single file download
      const { stream } = await createReadStream(filePath);
      const webStream = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      
      return new NextResponse(webStream, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${filename}"`,
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