import { NextRequest, NextResponse } from 'next/server';

import { getMobileEmailReview, updateMobileEmailReview } from '@/app/lib/mobile/email';
import { mobileEmailErrorResponse, mobileEmailResponseHeaders } from '@/app/lib/mobile/email-route';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ draftId: string }> }) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-email-review-get' });
  if (!limited.ok) return limited.response;
  try {
    const { draftId } = await context.params;
    const data = await getMobileEmailReview({
      userId: workspaceResult.session.user.id,
      workspace: workspaceResult.workspace,
      draftId,
    });
    return NextResponse.json({ success: true, data }, { headers: mobileEmailResponseHeaders });
  } catch (error) {
    return mobileEmailErrorResponse(error, '[API] Mobile email review GET failed:');
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ draftId: string }> }) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'mobile-email-review-patch' });
  if (!limited.ok) return limited.response;
  try {
    const { draftId } = await context.params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const data = await updateMobileEmailReview({
      userId: workspaceResult.session.user.id,
      workspace: workspaceResult.workspace,
      draftId,
      expectedVersion: typeof body?.expectedVersion === 'number' ? body.expectedVersion : Number.NaN,
      changes: body && typeof body === 'object' && !Array.isArray(body) ? body : {},
    });
    return NextResponse.json({ success: true, data }, { headers: mobileEmailResponseHeaders });
  } catch (error) {
    return mobileEmailErrorResponse(error, '[API] Mobile email review PATCH failed:');
  }
}
