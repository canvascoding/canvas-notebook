import { NextRequest, NextResponse } from 'next/server';

import { sendMobileEmailReview } from '@/app/lib/mobile/email';
import { mobileEmailErrorResponse, mobileEmailResponseHeaders } from '@/app/lib/mobile/email-route';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ draftId: string }> }) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 10, windowMs: 60_000, keyPrefix: 'mobile-email-review-send' });
  if (!limited.ok) return limited.response;
  try {
    const { draftId } = await context.params;
    const body = await request.json().catch(() => ({})) as { expectedVersion?: unknown };
    const data = await sendMobileEmailReview({
      userId: workspaceResult.session.user.id,
      workspace: workspaceResult.workspace,
      draftId,
      expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : Number.NaN,
    });
    return NextResponse.json({ success: true, data }, { headers: mobileEmailResponseHeaders });
  } catch (error) {
    return mobileEmailErrorResponse(error, '[API] Mobile email review send failed:');
  }
}
