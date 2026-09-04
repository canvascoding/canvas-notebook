import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { resolveSystemUpdateBackend } from '@/app/lib/system-updates/backend';
import { rateLimit } from '@/app/lib/utils/rate-limit';

import { parseEventCursor, parseSystemUpdateOperationId, systemUpdateErrorResponse } from '../../helpers';

type RouteContext = { params: Promise<{ operationId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, {
    limit: 180,
    windowMs: 60_000,
    keyPrefix: `system-update-events:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const operationId = parseSystemUpdateOperationId((await context.params).operationId);
    const after = parseEventCursor(request.nextUrl.searchParams.get('after'));
    const snapshot = await resolveSystemUpdateBackend().getEvents(operationId, after);
    return NextResponse.json({ success: true, ...snapshot }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return systemUpdateErrorResponse(error);
  }
}
