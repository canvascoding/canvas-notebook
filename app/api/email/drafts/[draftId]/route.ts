import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { managedEmailRequest } from '@/app/lib/email/managed-client';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return null;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'email-draft-patch' });
  if (!limited.ok) return limited.response;
  try {
    const { draftId } = await params;
    const body = await request.json().catch(() => ({}));
    const data = await managedEmailRequest(`/v1/managed/email/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update email draft';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

