import { EmailMailboxAccessError, resolveEmailMailboxAccess } from '@/app/lib/email/mailbox-access';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { isImapMailboxChangedError } from '@/app/lib/email/imap-service';
import {
  archiveEmailMessage,
  deleteEmailMessagePermanently,
  moveEmailMessage,
  readEmailMessage,
  setEmailMessageAnswered,
  setEmailMessageRead,
  trashEmailMessage,
} from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

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

export async function POST(request: NextRequest, { params }: { params: Promise<{ accountId: string; messageId: string }> }) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'email-message-actions-post' });
  if (!limited.ok) return limited.response;

  try {
    const { accountId, messageId } = await params;
    const body = await request.json().catch(() => ({}));
    const action = actionValue((body as { action?: unknown }).action);
    const access = await resolveEmailMailboxAccess({ userId: session.user.id, accountId, mailboxWorkspaceId: body.mailboxWorkspaceId, operation: action === 'trash' || action === 'permanent-delete' ? 'delete' : 'write' });
    const folder = stringValue((body as { folder?: unknown }).folder);
    const destination = stringValue((body as { destination?: unknown }).destination);
    // A shared mailbox's read policy also gates mutations of known message IDs.
    if (access.workspaceId) {
      await readEmailMessage(access.accountOwnerId, access.accountId, messageId, folder, access.readOptions);
    }
    let data: unknown;

    if (action === 'archive') data = await archiveEmailMessage(access.accountOwnerId, access.accountId, messageId, folder);
    if (action === 'trash') data = await trashEmailMessage(access.accountOwnerId, access.accountId, messageId, folder);
    if (action === 'permanent-delete') data = await deleteEmailMessagePermanently(access.accountOwnerId, access.accountId, messageId, folder);
    if (action === 'mark-read') data = await setEmailMessageRead(access.accountOwnerId, access.accountId, messageId, folder, true);
    if (action === 'mark-unread') data = await setEmailMessageRead(access.accountOwnerId, access.accountId, messageId, folder, false);
    if (action === 'mark-answered') data = await setEmailMessageAnswered(access.accountOwnerId, access.accountId, messageId, folder, true);
    if (action === 'clear-answered') data = await setEmailMessageAnswered(access.accountOwnerId, access.accountId, messageId, folder, false);
    if (action === 'move') {
      if (!destination) throw new Error('A destination folder is required.');
      data = await moveEmailMessage(access.accountOwnerId, access.accountId, messageId, folder, destination);
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof EmailMailboxAccessError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    if (isImapMailboxChangedError(error)) {
      return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Failed to update email message';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
