import { NextRequest, NextResponse } from 'next/server';

import { getFullBackupJob } from '@/app/lib/backups/full-backup-service';
import type { FullBackupJob } from '@/app/lib/backups/types';
import { requireFullBackupPermission } from '@/app/lib/migration/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function serializeBackupJob(job: FullBackupJob) {
  const safeJob = { ...job } as FullBackupJob & { filePath?: string };
  delete safeJob.filePath;
  return {
    ...safeJob,
    downloadUrl: job.status === 'completed' ? `/api/admin/backups/${job.id}/download` : null,
    inspectUrl: job.status === 'completed' ? `/api/admin/backups/${job.id}/inspect` : null,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireFullBackupPermission(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'full-backup-status',
  });
  if (!limited.ok) return limited.response;

  const { id } = await params;
  const job = await getFullBackupJob(id);
  if (!job) {
    return NextResponse.json({ success: false, error: 'Full backup not found.' }, { status: 404 });
  }

  return NextResponse.json({ success: true, job: serializeBackupJob(job) });
}
