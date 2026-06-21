import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { isAdminUser } from '@/app/lib/admin-auth';
import { revokePublicFileShare } from '@/app/lib/public-sharing/public-file-shares';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getPublicRequestOrigin } from '@/app/lib/utils/request-origin';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canCreatePublicLinks' });
  if (workspaceResult.response) return workspaceResult.response;
  const { session, workspace } = workspaceResult;

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
      workspace,
      isAdmin,
      baseUrl: getPublicRequestOrigin(request),
    });

    if (!share) {
      return NextResponse.json({ success: false, error: 'Public share not found.' }, { status: 404 });
    }

    clearFileTreeCache(workspace.workspaceId);
    await recordAuditEvent({
      organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
      userId: session.user.id,
      source: 'public_shares',
      eventType: 'file',
      entityType: 'public_file_share',
      entityId: share.id,
      action: 'public_share.revoke',
      status: 'success',
      summary: `Public file share ${share.id} revoked.`,
      metadata: {
        workspaceType: workspace.workspaceType,
        workspacePath: share.workspacePath,
        status: share.status,
        revokedAt: share.revokedAt,
        isAdmin,
      },
    });

    return NextResponse.json({ success: true, share });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to revoke public share.';
    return NextResponse.json(
      { success: false, error: message },
      { status: message === 'Forbidden' ? 403 : 400 }
    );
  }
}
