import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { isBootstrapAdminEmail } from '@/app/lib/bootstrap-admin';
import { cleanupOrphanedStudioAssets } from '@/app/lib/cleanup/orphaned-assets';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  if (!isBootstrapAdminEmail(session.user.email)) {
    return NextResponse.json({ success: false, error: 'Forbidden: admin only' }, { status: 403 });
  }

  try {
    const result = await cleanupOrphanedStudioAssets();
    return NextResponse.json({ success: true, deleted: result.deleted, errors: result.errors });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Admin Cleanup] Orphaned-assets cleanup failed:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}