import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  createFullBackupJob,
  listFullBackupJobs,
} from '@/app/lib/backups/full-backup-service';
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

export async function GET(request: NextRequest) {
  const admin = await requireFullBackupPermission(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'full-backup-list',
  });
  if (!limited.ok) return limited.response;

  const jobs = await listFullBackupJobs();
  return NextResponse.json({ success: true, jobs: jobs.map(serializeBackupJob) });
}

export async function POST(request: NextRequest) {
  const admin = await requireFullBackupPermission(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 2,
    windowMs: 60_000,
    keyPrefix: 'full-backup-create',
  });
  if (!limited.ok) return limited.response;

  try {
    const job = await createFullBackupJob({
      source: {
        organizationId: admin.state.organizationId,
        databaseProvider: admin.state.databaseProvider,
        teamFeaturesEnabled: admin.state.teamFeaturesEnabled,
        createdByUserId: admin.session.user.id,
        createdByEmail: admin.session.user.email,
        createdByRole: admin.permission.role,
      },
    });
    await recordAuditEvent({
      organizationId: admin.state.organizationId,
      userId: admin.session.user.id,
      source: 'backup',
      eventType: 'admin',
      entityType: 'full_backup',
      entityId: job.id,
      action: 'full_backup.create',
      status: 'queued',
      summary: `Full backup ${job.id} queued.`,
      metadata: {
        databaseProvider: job.source.databaseProvider,
        deploymentMode: job.source.deploymentMode,
        teamFeaturesEnabled: job.source.teamFeaturesEnabled,
        fileName: job.fileName,
        unencryptedArchive: true,
      },
    });
    return NextResponse.json({ success: true, job: serializeBackupJob(job) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create full backup.';
    return NextResponse.json({ success: false, error: message }, { status: 409 });
  }
}
