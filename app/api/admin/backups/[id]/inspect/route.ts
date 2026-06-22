import { NextRequest, NextResponse } from 'next/server';

import {
  getFullBackupJob,
  inspectFullBackupArchive,
} from '@/app/lib/backups/full-backup-service';
import { requireMigrationRestorePermission } from '@/app/lib/migration/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireMigrationRestorePermission(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'full-backup-inspect',
  });
  if (!limited.ok) return limited.response;

  const { id } = await params;
  const job = await getFullBackupJob(id);
  if (!job || job.status !== 'completed' || !job.filePath) {
    return NextResponse.json({ success: false, error: 'Full backup is not ready for inspection.' }, { status: 404 });
  }

  const inspection = await inspectFullBackupArchive(job.filePath);
  return NextResponse.json({ success: true, inspection });
}
