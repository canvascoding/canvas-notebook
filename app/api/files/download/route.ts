import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { createReadStream, getFileStats, readFile } from '@/app/lib/ssh/sftp-client';
import { Readable } from 'stream';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getSession } from '@/app/lib/auth/session';

export async function GET(request: NextRequest) {
  try {
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'files-download',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const session = await getSession();
    if (!session.isLoggedIn) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');
    const isDownload = searchParams.get('download') === '1';

    if (!filePath) {
      return NextResponse.json(
        { success: false, error: 'Path parameter is required' },
        { status: 400 }
      );
    }

    const filename = path.posix.basename(filePath);
    const extension = path.posix.extname(filename).slice(1).toLowerCase();
    const contentTypeMap: Record<string, string> = {
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
    const contentType = contentTypeMap[extension] || 'application/octet-stream';
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension);
    const isAudio = ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac'].includes(extension);
    const isVideo = ['mp4', 'webm', 'ogv', 'mov'].includes(extension);
    const isMedia = isAudio || isVideo;

    let etag: string | null = null;
    if (isImage && !isDownload) {
      try {
        const stats = await getFileStats(filePath);
        etag = `W/"${stats.size}-${stats.modified}"`;
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
      } catch {
        // If stat fails, continue without cache metadata.
      }
    }

    const range = request.headers.get('range');
    if (range || isMedia) {
      const stats = await getFileStats(filePath);
      const fileSize = stats.size;
      const parsed = range?.match(/bytes=(\d*)-(\d*)/i);
      let start = 0;
      let end = fileSize - 1;

      if (parsed) {
        const startText = parsed[1];
        const endText = parsed[2];

        if (startText) {
          start = Number(startText);
        }

        if (endText) {
          end = Number(endText);
        }

        if (!startText && endText) {
          const suffixLength = Number(endText);
          if (Number.isFinite(suffixLength)) {
            start = Math.max(fileSize - suffixLength, 0);
            end = fileSize - 1;
          }
        }
      }

      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= fileSize) {
        return new NextResponse(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${fileSize}`,
          },
        });
      }

      end = Math.min(end, fileSize - 1);

      const { stream } = await createReadStream(filePath, {
        start,
        end,
        highWaterMark: 1024 * 1024,
      });
      const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;

      return new NextResponse(webStream as unknown as BodyInit, {
        status: range ? 206 : 200,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `${isDownload ? 'attachment' : 'inline'}; filename="${filename}"`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${fileSize}` } : {}),
          'Cache-Control': 'no-store, max-age=0',
          Pragma: 'no-cache',
          'X-Frame-Options': 'SAMEORIGIN',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    const content = await readFile(filePath);
    const body = new Uint8Array(content);

    return new NextResponse(body, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `${isDownload ? 'attachment' : 'inline'}; filename="${filename}"`,
        'Cache-Control': isImage && !isDownload ? 'private, max-age=300' : 'no-store, max-age=0',
        ...(etag ? { ETag: etag } : {}),
        ...(isImage && !isDownload ? {} : { Pragma: 'no-cache' }),
        'X-Frame-Options': 'SAMEORIGIN',
      },
    });
  } catch (error) {
    console.error('[API] File download error:', error);
    const message = error instanceof Error ? error.message : 'Failed to download file';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
