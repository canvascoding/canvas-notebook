import { NextRequest, NextResponse } from 'next/server';

import { requireMigrationAdmin } from '@/app/lib/migration/auth';
import { createMigrationExportJob, normalizeMigrationComponents } from '@/app/lib/migration/export-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const admin = await requireMigrationAdmin(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 5,
    windowMs: 60_000,
    keyPrefix: 'migration-export',
  });
  if (!limited.ok) return limited.response;

  try {
    const payload = await request.json().catch(() => ({})) as { components?: unknown };
    const components = normalizeMigrationComponents(payload.components);
    const job = await createMigrationExportJob({ components });
    return NextResponse.json({ success: true, job });
  } catch (error) {
    console.error('[Migration Export] Failed to create export job:', error);
    const message = error instanceof Error ? error.message : 'Failed to create migration export.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
