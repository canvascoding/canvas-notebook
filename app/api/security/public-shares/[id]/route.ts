import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { isAdminUser } from '@/app/lib/admin-auth';
import { revokePublicFileShare } from '@/app/lib/public-sharing/public-file-shares';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getPublicRequestOrigin } from '@/app/lib/utils/request-origin';

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'public-shares-revoke',
  });
  if (!limited.ok) return limited.response;

  const { id } = await context.params;
  const isAdmin = isAdminUser(session.user);

  try {
    const share = await revokePublicFileShare({
      id,
      userId: session.user.id,
      isAdmin,
      baseUrl: getPublicRequestOrigin(request),
    });

    if (!share) {
      return NextResponse.json({ success: false, error: 'Public share not found.' }, { status: 404 });
    }

    clearFileTreeCache();

    return NextResponse.json({ success: true, share });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to revoke public share.';
    return NextResponse.json(
      { success: false, error: message },
      { status: message === 'Forbidden' ? 403 : 400 }
    );
  }
}
