import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { updateEmailDraft } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'email-draft-patch' });
  if (!limited.ok) return limited.response;
  try {
    const { draftId } = await params;
    const body = await request.json().catch(() => ({}));
    const data = await updateEmailDraft(session.user.id, draftId, body);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update email draft';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
