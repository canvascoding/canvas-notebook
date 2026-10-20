import { NextRequest, NextResponse } from 'next/server';

import { requireMigrationRestorePermission } from '@/app/lib/migration/auth';
import { attachInspectionToUpload, readMigrationUpload, writeMigrationUploadPart } from '@/app/lib/migration/upload-service';
import { inspectMigrationArchive } from '@/app/lib/migration/inspect-service';
import { parseMigrationMappingChoices } from '@/app/lib/migration/mappings';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function parseOptionalByteCount(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Upload part expected byte count is invalid.');
  }
  return parsed;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireMigrationRestorePermission(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'migration-mapping' });
  if (!limited.ok) return limited.response;
  try {
    const { id } = await params;
    const upload = await readMigrationUpload(id);
    if (upload?.status !== 'completed' || !upload.archivePath) return NextResponse.json({ success: false, error: 'Upload is not finalized.' }, { status: 409 });
    const mappings = parseMigrationMappingChoices(await request.json());
    const inspection = await inspectMigrationArchive({ uploadId: id, archivePath: upload.archivePath, mappings });
    const updated = await attachInspectionToUpload(id, inspection);
    return NextResponse.json({ success: true, upload: updated, inspection });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Invalid migration mappings.' }, { status: 400 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireMigrationRestorePermission(request);
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
  const admin = await requireMigrationRestorePermission(request);
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
