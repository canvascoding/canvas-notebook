import { NextRequest, NextResponse } from 'next/server';

import { getMobileEmailCase } from '@/app/lib/mobile/email';
import { mobileEmailErrorResponse, mobileEmailResponseHeaders } from '@/app/lib/mobile/email-route';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ caseId: string }> }) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-email-case-get' });
  if (!limited.ok) return limited.response;
  try {
    const { caseId } = await context.params;
    const data = await getMobileEmailCase({
      userId: workspaceResult.session.user.id,
      workspace: workspaceResult.workspace,
      caseId,
    });
    return NextResponse.json({ success: true, data }, { headers: mobileEmailResponseHeaders });
  } catch (error) {
    return mobileEmailErrorResponse(error, '[API] Mobile email case GET failed:');
  }
}
