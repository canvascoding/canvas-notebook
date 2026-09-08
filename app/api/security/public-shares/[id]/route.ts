import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { isAdminUser } from '@/app/lib/admin-auth';
import { revokePublicFileShare, updatePublicFileShare, PublicSharePolicyError } from '@/app/lib/public-sharing/public-file-shares';
import { parsePublicSharePolicy, requirePublicShareBody } from '@/app/lib/public-sharing/share-policy-input';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getPublicRequestOrigin } from '@/app/lib/utils/request-origin';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canCreatePublicLinks' });
  if (workspaceResult.response) return workspaceResult.response;
  const { session, workspace } = workspaceResult;
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'public-shares-update' });
  if (!limited.ok) return limited.response;
  try {
    const body = requirePublicShareBody(await request.json());
    if (typeof body.policyRevision !== 'number') {
      return NextResponse.json({ success: false, error: 'Policy revision is required.' }, { status: 400 });
    }
    const { id } = await context.params;
    const share = await updatePublicFileShare({
      id, userId: session.user.id, workspace, expectedPolicyRevision: body.policyRevision,
      ...parsePublicSharePolicy(body), baseUrl: getPublicRequestOrigin(request),
    });
    if (!share) return NextResponse.json({ success: false, error: 'Public share not found.' }, { status: 404 });
    clearFileTreeCache(workspace.workspaceId);
    await recordAuditEvent({
      organizationId: workspace.organizationId, workspaceId: workspace.workspaceId,
      userId: session.user.id, source: 'public_shares', eventType: 'file',
      entityType: 'public_file_share', entityId: id, action: 'public_share.update',
      status: 'success', summary: `Public file share ${id} updated.`,
      metadata: { policyRevision: share.policyRevision, expiresAt: share.expiresAt, securityMode: share.securityMode },
    });
    return NextResponse.json({ success: true, share });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to update public share.' },
      { status: error instanceof PublicSharePolicyError ? error.status : 400 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
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
