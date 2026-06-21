import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireMigrationRestorePermission } from '@/app/lib/migration/auth';
import { inspectMigrationArchive } from '@/app/lib/migration/inspect-service';
import {
  attachInspectionToUpload,
  finalizeMigrationUpload,
} from '@/app/lib/migration/upload-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireMigrationRestorePermission(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'migration-upload-complete',
  });
  if (!limited.ok) return limited.response;

  const { id } = await params;

  try {
    const finalized = await finalizeMigrationUpload(id);
    if (!finalized.archivePath) {
      throw new Error('Finalized upload is missing archive path.');
    }
    const inspection = await inspectMigrationArchive({
      uploadId: finalized.id,
      archivePath: finalized.archivePath,
    });
    const upload = await attachInspectionToUpload(id, inspection);
    await recordAuditEvent({
      organizationId: admin.state.organizationId,
      userId: admin.session.user.id,
      source: 'migration',
      eventType: 'admin',
      entityType: 'migration_upload',
      entityId: upload.id,
      action: 'migration_upload.complete',
      status: inspection.canRestore ? 'success' : 'blocked',
      summary: `Migration upload ${upload.id} finalized and inspected.`,
      metadata: {
        fileName: upload.fileName,
        totalBytes: upload.totalBytes,
        archiveSha256: upload.archiveSha256,
        canRestore: inspection.canRestore,
        compatibility: inspection.compatibility,
        dryRunStatus: inspection.dryRun?.status,
        blockers: inspection.dryRun?.stats.blockers ?? inspection.risks.length,
      },
      inputHash: upload.archiveSha256 ?? null,
    });
    return NextResponse.json({ success: true, upload, inspection });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to inspect migration upload.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
