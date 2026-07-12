import { NextRequest, NextResponse } from 'next/server';

import { emailAiRequestBodyErrorStatus, readEmailAiJsonObject } from '@/app/lib/email/ai-request-body';
import { requireEmailAiRouteSession } from '@/app/lib/email/ai-route-guard';
import { createEmailAiReplyDraft } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ accountId: string; messageId: string }> }) {
  const session = await requireEmailAiRouteSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 15, windowMs: 60_000, keyPrefix: 'email-message-ai-reply-post' });
  if (!limited.ok) return limited.response;

  try {
    const { accountId, messageId } = await params;
    const body = await readEmailAiJsonObject(request);
    const folder = stringValue(body.folder);
    const workspaceId = stringValue(body.workspaceId);
    const data = await createEmailAiReplyDraft(
      session.user.id,
      accountId,
      messageId,
      folder,
      undefined,
      { enforceReadPolicy: false, workspaceId },
    );
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create AI reply draft';
    return NextResponse.json(
      { success: false, error: message },
      { status: emailAiRequestBodyErrorStatus(error) ?? 500 },
    );
  }
}
