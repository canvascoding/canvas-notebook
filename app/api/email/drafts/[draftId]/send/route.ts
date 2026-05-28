import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { sendEmailDraft } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return null;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'email-draft-send' });
  if (!limited.ok) return limited.response;
  try {
    const { draftId } = await params;
    const body = await request.json().catch(() => ({})) as { accountId?: string };
    if (!body.accountId) throw new Error('accountId is required to send an email draft.');
    const data = await sendEmailDraft(body.accountId, draftId);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send email draft';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
