import { NextRequest, NextResponse } from 'next/server';

import { requireMigrationRestorePermission } from '@/app/lib/migration/auth';
import { createMigrationUpload } from '@/app/lib/migration/upload-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const admin = await requireMigrationRestorePermission(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'migration-upload-create',
  });
  if (!limited.ok) return limited.response;

  try {
    const payload = await request.json() as {
      fileName?: unknown;
      totalBytes?: unknown;
      totalParts?: unknown;
    };

    const status = await createMigrationUpload({
      fileName: typeof payload.fileName === 'string' ? payload.fileName : '',
      totalBytes: typeof payload.totalBytes === 'number' ? payload.totalBytes : 0,
      totalParts: typeof payload.totalParts === 'number' ? payload.totalParts : 0,
    });
    return NextResponse.json({ success: true, upload: status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create migration upload.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
