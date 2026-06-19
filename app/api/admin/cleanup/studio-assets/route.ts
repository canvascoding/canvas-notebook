import { NextRequest, NextResponse } from 'next/server';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { cleanupOrphanedStudioAssets } from '@/app/lib/cleanup/orphaned-assets';

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  try {
    const result = await cleanupOrphanedStudioAssets();
    return NextResponse.json({ success: true, deleted: result.deleted, errors: result.errors });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Admin Cleanup] Orphaned-assets cleanup failed:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
