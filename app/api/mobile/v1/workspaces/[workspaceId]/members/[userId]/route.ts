import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
} from '@/app/lib/license/entitlements';
import { removeMobileWorkspaceMember } from '@/app/lib/mobile/workspaces';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { WorkspaceOperationError } from '@/app/lib/workspaces/contracts';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string; userId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' }, { status: 401, headers: responseHeaders });
  }
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'mobile-workspace-member-remove' });
  if (!limited.ok) return limited.response;
  try {
    const { workspaceId, userId } = await context.params;
    const selectedWorkspaceId = request.headers.get('x-canvas-workspace-id')?.trim() || '';
    if (!workspaceId.trim() || selectedWorkspaceId !== workspaceId.trim()) {
      return NextResponse.json({ success: false, code: 'WORKSPACE_CONTEXT_MISMATCH', error: 'Select this workspace to manage its members.' }, { status: 409, headers: responseHeaders });
    }
    await removeMobileWorkspaceMember({
      actor: resolveWorkspaceActor({ id: session.user.id, email: session.user.email, role: session.user.role }),
      workspaceId: workspaceId.trim(),
      userId: userId.trim(),
    });
    return NextResponse.json({ success: true }, { headers: responseHeaders });
  } catch (error) {
    if (error instanceof WorkspaceOperationError) {
      return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status, headers: responseHeaders });
    }
    if (error instanceof LicenseEntitlementError) {
      return NextResponse.json(licenseEntitlementErrorPayload(error), { status: error.statusCode, headers: responseHeaders });
    }
    console.error('[API] Mobile workspace member remove failed:', error);
    return NextResponse.json({ success: false, code: 'INTERNAL_ERROR', error: 'Workspace member could not be removed.' }, { status: 500, headers: responseHeaders });
  }
}
