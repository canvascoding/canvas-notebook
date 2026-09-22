import { createMailboxAiReplyDraft } from '@/app/lib/email/mailbox-ai';
import { resolveEmailMailboxAccess, EmailMailboxAccessError } from '@/app/lib/email/mailbox-access';
import { NextRequest, NextResponse } from 'next/server';

import { emailAiRequestBodyErrorStatus, readEmailAiJsonObject } from '@/app/lib/email/ai-request-body';
import { requireEmailAiRouteSession } from '@/app/lib/email/ai-route-guard';
import { isImapMailboxChangedError } from '@/app/lib/email/imap-service';
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
    const access = await resolveEmailMailboxAccess({ userId: session.user.id, accountId, mailboxWorkspaceId: body.mailboxWorkspaceId, operation: 'ai' });
    const workspaceId = access.workspaceId || stringValue(body.workspaceId);
    const data = await createMailboxAiReplyDraft({ userId: session.user.id, access, messageId, folder, instruction: undefined, workspaceId });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isImapMailboxChangedError(error)) {
      return NextResponse.json(
        { success: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : 'Failed to create AI reply draft';
    return NextResponse.json(
      { success: false, error: message },
      { status: error instanceof EmailMailboxAccessError ? error.status : emailAiRequestBodyErrorStatus(error) ?? 500 },
    );
  }
}
