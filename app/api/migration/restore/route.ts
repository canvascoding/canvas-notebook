import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireMigrationRestorePermission } from '@/app/lib/migration/auth';
import {
  scheduleMigrationRestartIfSupported,
  writePendingMigrationRestore,
} from '@/app/lib/migration/restore-service';
import { readMigrationUpload } from '@/app/lib/migration/upload-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const admin = await requireMigrationRestorePermission(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 3,
    windowMs: 60_000,
    keyPrefix: 'migration-restore',
  });
  if (!limited.ok) return limited.response;

  try {
    const payload = await request.json() as {
      uploadId?: unknown;
      confirmation?: unknown;
    };
    if (payload.confirmation !== 'FULL_RESTORE') {
      return NextResponse.json(
        { success: false, error: 'Restore requires explicit FULL_RESTORE confirmation.' },
        { status: 400 },
      );
    }
    if (typeof payload.uploadId !== 'string') {
      return NextResponse.json({ success: false, error: 'uploadId is required.' }, { status: 400 });
    }

    const upload = await readMigrationUpload(payload.uploadId);
    if (!upload || !upload.inspection) {
      return NextResponse.json({ success: false, error: 'Migration upload has not been inspected.' }, { status: 404 });
    }

    const pending = await writePendingMigrationRestore({
      upload,
      inspection: upload.inspection,
      requestedBy: {
        userId: admin.session.user.id,
        email: admin.session.user.email,
      },
    });
    const restartScheduled = scheduleMigrationRestartIfSupported();
    await recordAuditEvent({
      organizationId: admin.state.organizationId,
      userId: admin.session.user.id,
      source: 'migration',
      eventType: 'admin',
      entityType: 'migration_restore',
      entityId: pending.id,
      action: 'migration_restore.stage',
      status: restartScheduled ? 'queued' : 'success',
      summary: `Migration restore ${pending.id} staged.`,
      metadata: {
        uploadId: upload.id,
        components: pending.components,
        invalidateSessions: pending.invalidateSessions,
        pauseAutomations: pending.pauseAutomations,
        clearOAuthTokens: pending.clearOAuthTokens,
        preserveTargetInstanceAndLicense: pending.preserveTargetInstanceAndLicense,
        restartScheduled,
      },
      artifactRef: pending.archivePath,
      inputHash: upload.archiveSha256 ?? null,
    });
    return NextResponse.json({ success: true, pending, restartScheduled });
  } catch (error) {
    console.error('[Migration Restore] Failed to stage restore:', error);
    const message = error instanceof Error ? error.message : 'Failed to stage migration restore.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
