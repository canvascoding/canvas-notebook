import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import { NextRequest, NextResponse } from 'next/server';

import {
  createPublicFileHeaders,
  resolvePublicShareToken,
} from '@/app/lib/public-sharing/public-file-shares';

function parseRange(rangeHeader: string | null, fileSize: number): { start: number; end: number } | null | 'invalid' {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return 'invalid';

  let start = match[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  let end = match[2] ? Number.parseInt(match[2], 10) : Number.NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) return 'invalid';
  if (Number.isNaN(start)) {
    const suffixLength = end;
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'invalid';
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    end = Number.isNaN(end) ? fileSize - 1 : end;
  }

  if (start < 0 || end < start || start >= fileSize || end >= fileSize) return 'invalid';
  return { start, end };
}

async function handlePublicFileRequest(
  request: NextRequest,
  context: { params: Promise<{ token: string; filename: string[] }> },
  method: 'GET' | 'HEAD',
) {
  const { token } = await context.params;
  const resolved = await resolvePublicShareToken(decodeURIComponent(token));

  if (!resolved.ok) {
    return NextResponse.json(
      { success: false, error: resolved.error },
      {
        status: resolved.status,
        headers: {
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }

  const range = parseRange(request.headers.get('range'), resolved.sizeBytes);
  if (range === 'invalid') {
    return new NextResponse(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${resolved.sizeBytes}`,
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  const headers = createPublicFileHeaders({
    fileName: resolved.share.fileName,
    workspacePath: resolved.workspacePath,
    mimeType: resolved.mimeType,
    sizeBytes: resolved.sizeBytes,
    range: range ? { ...range, total: resolved.sizeBytes } : undefined,
  });

  if (method === 'HEAD') {
    return new NextResponse(null, { status: range ? 206 : 200, headers });
  }

  const nodeStream = range
    ? createReadStream(resolved.fullPath, { start: range.start, end: range.end })
    : createReadStream(resolved.fullPath);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

  return new NextResponse(webStream, { status: range ? 206 : 200, headers });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string; filename: string[] }> }
) {
  return handlePublicFileRequest(request, context, 'GET');
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ token: string; filename: string[] }> }
) {
  return handlePublicFileRequest(request, context, 'HEAD');
}
