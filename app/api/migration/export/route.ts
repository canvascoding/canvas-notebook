import { NextRequest, NextResponse } from 'next/server';

import { requireMigrationExportPermission } from '@/app/lib/migration/auth';
import { createMigrationExportJob, normalizeMigrationExportOptions } from '@/app/lib/migration/export-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const admin = await requireMigrationExportPermission(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 5,
    windowMs: 60_000,
    keyPrefix: 'migration-export',
  });
  if (!limited.ok) return limited.response;

  try {
    const payload = await request.json().catch(() => ({}));
    const options = normalizeMigrationExportOptions(payload);
    const job = await createMigrationExportJob({
      ...options,
      source: {
        organizationId: admin.state.organizationId,
        databaseProvider: admin.state.databaseProvider,
        teamFeaturesEnabled: admin.state.teamFeaturesEnabled,
        createdByUserId: admin.session.user.id,
        createdByEmail: admin.session.user.email,
        createdByRole: admin.permission.role,
      },
    });
    return NextResponse.json({ success: true, job });
  } catch (error) {
    console.error('[Migration Export] Failed to create export job:', error);
    const message = error instanceof Error ? error.message : 'Failed to create migration export.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
