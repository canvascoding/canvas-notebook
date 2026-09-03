import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
} from '@/app/lib/license/entitlements';
import { updateMobileWorkspace } from '@/app/lib/mobile/workspaces';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { WorkspaceOperationError } from '@/app/lib/workspaces/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

function errorResponse(error: unknown): NextResponse {
  if (error instanceof WorkspaceOperationError) {
    return NextResponse.json(
      { success: false, code: error.code, error: error.message },
      { status: error.status, headers: responseHeaders },
    );
  }
  if (error instanceof LicenseEntitlementError) {
    return NextResponse.json(
      licenseEntitlementErrorPayload(error),
      { status: error.statusCode, headers: responseHeaders },
    );
  }
  console.error('[API] Mobile workspace update failed:', error);
  return NextResponse.json(
    { success: false, code: 'INTERNAL_ERROR', error: 'The workspace could not be updated.' },
    { status: 500, headers: responseHeaders },
  );
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' },
      { status: 401, headers: responseHeaders },
    );
  }
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'mobile-workspace-update' });
  if (!limited.ok) return limited.response;
  try {
    const { workspaceId } = await context.params;
    const selectedWorkspaceId = request.headers.get('x-canvas-workspace-id')?.trim() || '';
    if (!workspaceId.trim() || selectedWorkspaceId !== workspaceId.trim()) {
      return NextResponse.json(
        { success: false, code: 'WORKSPACE_CONTEXT_MISMATCH', error: 'Select this workspace before editing it.' },
        { status: 409, headers: responseHeaders },
      );
    }
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const workspace = await updateMobileWorkspace({
      actor: resolveWorkspaceActor({
        id: session.user.id,
        email: session.user.email,
        role: session.user.role,
      }),
      workspaceId: workspaceId.trim(),
      name: payload.name,
      description: payload.description,
      color: payload.color,
    });
    return NextResponse.json({ success: true, workspace }, { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
