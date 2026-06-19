import { NextRequest, NextResponse } from 'next/server';

import { requireMigrationExportPermission } from '@/app/lib/migration/auth';
import { getMigrationExportJob } from '@/app/lib/migration/export-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireMigrationExportPermission(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'migration-export-status',
  });
  if (!limited.ok) return limited.response;

  const { id } = await params;
  const job = await getMigrationExportJob(id);
  if (!job) {
    return NextResponse.json({ success: false, error: 'Migration export not found.' }, { status: 404 });
  }

  return NextResponse.json({ success: true, job });
}
