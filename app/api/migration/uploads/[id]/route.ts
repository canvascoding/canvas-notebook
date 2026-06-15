import { NextRequest, NextResponse } from 'next/server';

import { requireMigrationAdmin } from '@/app/lib/migration/auth';
import { readMigrationUpload, writeMigrationUploadPart } from '@/app/lib/migration/upload-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function parseOptionalByteCount(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Upload part expected byte count is invalid.');
  }
  return parsed;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireMigrationAdmin(request);
  if (!admin.ok) return admin.response;

  const { id } = await params;
  const upload = await readMigrationUpload(id);
  if (!upload) {
    return NextResponse.json({ success: false, error: 'Migration upload not found.' }, { status: 404 });
  }
  return NextResponse.json({ success: true, upload });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireMigrationAdmin(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 500,
    windowMs: 60_000,
    keyPrefix: 'migration-upload-part',
  });
  if (!limited.ok) return limited.response;

  try {
    const { id } = await params;
    const partIndex = Number(request.nextUrl.searchParams.get('partIndex'));
    const expectedBytes = parseOptionalByteCount(request.nextUrl.searchParams.get('expectedBytes'))
      ?? parseOptionalByteCount(request.headers.get('content-length'));

    const upload = await writeMigrationUploadPart({
      uploadId: id,
      partIndex,
      expectedBytes,
      body: request.body,
    });
    return NextResponse.json({ success: true, upload });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to upload migration part.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
