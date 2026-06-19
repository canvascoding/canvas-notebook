import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, promises as fs } from 'fs';
import { Readable } from 'stream';

import { requireMigrationExportPermission } from '@/app/lib/migration/auth';
import { getMigrationExportJob } from '@/app/lib/migration/export-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function parseRange(rangeHeader: string | null, size: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader.trim());
  if (!match) return null;

  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return null;

  if (!startRaw) {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }

  const start = Number(startRaw);
  const end = endRaw ? Number(endRaw) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireMigrationExportPermission(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'migration-export-download',
  });
  if (!limited.ok) return limited.response;

  const { id } = await params;
  const job = await getMigrationExportJob(id);
  if (!job || job.status !== 'completed' || !job.filePath) {
    return NextResponse.json({ success: false, error: 'Migration export is not ready.' }, { status: 404 });
  }

  const stats = await fs.stat(job.filePath);
  const range = parseRange(request.headers.get('range'), stats.size);
  const start = range?.start ?? 0;
  const end = range?.end ?? stats.size - 1;
  const stream = createReadStream(job.filePath, { start, end, highWaterMark: 1024 * 1024 });
  const webStream = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${job.fileName}"`,
    'Content-Length': String(end - start + 1),
  });

  if (range) {
    headers.set('Content-Range', `bytes ${start}-${end}/${stats.size}`);
  }

  return new NextResponse(webStream, {
    status: range ? 206 : 200,
    headers,
  });
}
