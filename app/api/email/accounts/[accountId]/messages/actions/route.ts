import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  archiveEmailMessage,
  createEmailAiReplyDraft,
  createEmailDerivedDraft,
  deleteEmailMessagePermanently,
  moveEmailMessage,
  setEmailMessageAnswered,
  setEmailMessageRead,
  summarizeEmailMessage,
  trashEmailMessage,
} from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type DraftMode = 'forward' | 'reply' | 'reply-all';
type MessageOperation = 'action' | 'ai-reply' | 'draft' | 'summary';
type EmailMessageAction =
  | 'archive'
  | 'clear-answered'
  | 'mark-answered'
  | 'mark-read'
  | 'mark-unread'
  | 'move'
  | 'permanent-delete'
  | 'trash';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string): string {
  const normalized = stringValue(value);
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function operationValue(value: unknown): MessageOperation {
  const normalized = stringValue(value);
  if (normalized === 'action' || normalized === 'ai-reply' || normalized === 'draft' || normalized === 'summary') {
    return normalized;
  }
  throw new Error('Unsupported email message operation.');
}

function draftMode(value: unknown): DraftMode {
  const normalized = stringValue(value);
  if (normalized === 'forward' || normalized === 'reply' || normalized === 'reply-all') return normalized;
  throw new Error('Unsupported email draft mode.');
}

function actionValue(value: unknown): EmailMessageAction {
  const normalized = stringValue(value);
  if (
    normalized === 'archive'
    || normalized === 'clear-answered'
    || normalized === 'mark-answered'
    || normalized === 'mark-read'
    || normalized === 'mark-unread'
    || normalized === 'move'
    || normalized === 'permanent-delete'
    || normalized === 'trash'
  ) {
    return normalized;
  }
  throw new Error('Unsupported email message action.');
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ accountId: string }> }) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'email-message-actions-body-post' });
  if (!limited.ok) return limited.response;

  try {
    const { accountId } = await params;
    const body = await request.json().catch(() => ({}));
    const messageId = requiredString((body as { messageId?: unknown }).messageId, 'messageId');
    const folder = stringValue((body as { folder?: unknown }).folder);
    const operation = operationValue((body as { operation?: unknown }).operation);
    let data: unknown;

    if (operation === 'summary') {
      data = await summarizeEmailMessage(session.user.id, accountId, messageId, folder);
    }

    if (operation === 'ai-reply') {
      data = await createEmailAiReplyDraft(session.user.id, accountId, messageId, folder);
    }

    if (operation === 'draft') {
      const mode = draftMode((body as { mode?: unknown }).mode);
      data = await createEmailDerivedDraft(session.user.id, accountId, messageId, folder, mode);
    }

    if (operation === 'action') {
      const action = actionValue((body as { action?: unknown }).action);
      const destination = stringValue((body as { destination?: unknown }).destination);

      if (action === 'archive') data = await archiveEmailMessage(session.user.id, accountId, messageId, folder);
      if (action === 'trash') data = await trashEmailMessage(session.user.id, accountId, messageId, folder);
      if (action === 'permanent-delete') data = await deleteEmailMessagePermanently(session.user.id, accountId, messageId, folder);
      if (action === 'mark-read') data = await setEmailMessageRead(session.user.id, accountId, messageId, folder, true);
      if (action === 'mark-unread') data = await setEmailMessageRead(session.user.id, accountId, messageId, folder, false);
      if (action === 'mark-answered') data = await setEmailMessageAnswered(session.user.id, accountId, messageId, folder, true);
      if (action === 'clear-answered') data = await setEmailMessageAnswered(session.user.id, accountId, messageId, folder, false);
      if (action === 'move') {
        if (!destination) throw new Error('A destination folder is required.');
        data = await moveEmailMessage(session.user.id, accountId, messageId, folder, destination);
      }
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update email message';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
