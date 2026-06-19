import { NextRequest, NextResponse } from 'next/server';
import { cleanupOrphanedStudioAssets } from '@/app/lib/cleanup/orphaned-assets';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';

export async function POST(request: NextRequest) {
  const studioPermission = await requireOrganizationPermission(request, 'canManageBackups', {
    errorMessage: 'Forbidden: admin cleanup permission required',
  });
  if (!studioPermission.ok) return studioPermission.response;

  try {
    const result = await cleanupOrphanedStudioAssets();
    return NextResponse.json({ success: true, deleted: result.deleted, errors: result.errors });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Admin Cleanup] Orphaned-assets cleanup failed:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
