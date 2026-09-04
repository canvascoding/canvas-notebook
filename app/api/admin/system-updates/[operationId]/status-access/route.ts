import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { resolveSystemUpdateBackend } from '@/app/lib/system-updates/backend';
import { rateLimit } from '@/app/lib/utils/rate-limit';

import { parseSystemUpdateOperationId, systemUpdateErrorResponse } from '../../helpers';

type RouteContext = { params: Promise<{ operationId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, {
    limit: 12,
    windowMs: 60_000,
    keyPrefix: `system-update-status-access:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const operationId = parseSystemUpdateOperationId((await context.params).operationId);
    const access = await resolveSystemUpdateBackend().createStatusAccess(operationId);
    return NextResponse.json({ success: true, access }, {
      status: access ? 201 : 200,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return systemUpdateErrorResponse(error);
  }
}
