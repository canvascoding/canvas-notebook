import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { resolveValidatedStudioPath } from '@/app/lib/integrations/studio-paths';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { resolveMobileStudioOutput } from '@/app/lib/mobile/studio';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';

export const dynamic = 'force-dynamic';

function safeFileName(value: string): string {
  return path.basename(value).replace(/[^A-Za-z0-9._-]/gu, '_').slice(-180) || 'studio-output';
}

function rangeValues(range: string, fileSize: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
  if (!match) return null;
  let start = match[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  let end = match[2] ? Number.parseInt(match[2], 10) : Number.NaN;
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    if (!Number.isFinite(end) || end <= 0) return null;
    start = Math.max(fileSize - end, 0);
    end = fileSize - 1;
  } else {
    end = Number.isNaN(end) ? fileSize - 1 : end;
  }
  if (start < 0 || end < start || start >= fileSize || end >= fileSize) return null;
  return { start, end };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ outputId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: mobileStudioResponseHeaders },
    );
  }
  const studioRequest = await requireStudioRequestScope(request, session);
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const { outputId } = await context.params;
    const output = await resolveMobileStudioOutput({ scope: studioRequest.scope, outputId });
    const fullPath = resolveValidatedStudioPath(output.filePath);
    if (!fullPath) {
      return NextResponse.json(
        { success: false, error: 'Output path is invalid.', code: 'INVALID_OUTPUT' },
        { status: 400, headers: mobileStudioResponseHeaders },
      );
    }
    const stats = await fs.stat(fullPath).catch(() => null);
    if (!stats?.isFile()) {
      return NextResponse.json(
        { success: false, error: 'Output file was not found.', code: 'OUTPUT_FILE_NOT_FOUND' },
        { status: 404, headers: mobileStudioResponseHeaders },
      );
    }
    const fileName = safeFileName(output.fileName || output.filePath);
    const contentType = output.mimeType || 'application/octet-stream';
    const range = request.headers.get('range');
    if (range) {
      const values = rangeValues(range, stats.size);
      if (!values) {
        return new NextResponse(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${stats.size}`, 'X-Content-Type-Options': 'nosniff' },
        });
      }
      const nodeStream = nodeFs.createReadStream(fullPath, values);
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
      return new NextResponse(webStream, {
        status: 206,
        headers: {
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, no-store, max-age=0',
          'Content-Disposition': `inline; filename="${fileName}"`,
          'Content-Length': String(values.end - values.start + 1),
          'Content-Range': `bytes ${values.start}-${values.end}/${stats.size}`,
          'Content-Type': contentType,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    const nodeStream = nodeFs.createReadStream(fullPath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    return new NextResponse(webStream, {
      headers: {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Disposition': `inline; filename="${fileName}"`,
        'Content-Length': String(stats.size),
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return mobileStudioErrorResponse(error, '[API] Mobile Studio output failed:');
  }
}
