import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
} from '@/app/lib/license/entitlements';
import { createMobileWorkspace } from '@/app/lib/mobile/workspaces';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { WorkspaceOperationError } from '@/app/lib/workspaces/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie',
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
  console.error('[API] Mobile workspace create failed:', error);
  return NextResponse.json(
    { success: false, code: 'INTERNAL_ERROR', error: 'The workspace could not be created.' },
    { status: 500, headers: responseHeaders },
  );
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' },
      { status: 401, headers: responseHeaders },
    );
  }
  const limited = rateLimit(request, { limit: 10, windowMs: 60_000, keyPrefix: 'mobile-workspace-create' });
  if (!limited.ok) return limited.response;
  try {
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const workspace = await createMobileWorkspace({
      actor: resolveWorkspaceActor({
        id: session.user.id,
        email: session.user.email,
        role: session.user.role,
      }),
      type: payload.type,
      name: payload.name,
      description: payload.description,
      icon: payload.icon,
      color: payload.color,
      projectId: payload.projectId,
    });
    return NextResponse.json({ success: true, workspace }, { status: 201, headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
