import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { createEmailAiReplyDraft } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ accountId: string; messageId: string }> }) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 15, windowMs: 60_000, keyPrefix: 'email-message-ai-reply-post' });
  if (!limited.ok) return limited.response;

  try {
    const { accountId, messageId } = await params;
    const body = await request.json().catch(() => ({}));
    const folder = stringValue((body as { folder?: unknown }).folder);
    const data = await createEmailAiReplyDraft(session.user.id, accountId, messageId, folder);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create AI reply draft';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
