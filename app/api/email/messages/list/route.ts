import { EmailMailboxAccessError, resolveEmailMailboxAccess } from '@/app/lib/email/mailbox-access';
import { EmailSearchQueryError } from '@/app/lib/email/search-query';
import { after, NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { listEmailMessages } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 80, windowMs: 60_000, keyPrefix: 'email-messages-list-post' });
  if (!limited.ok) return limited.response;

  try {
    const body = await request.json().catch(() => ({}));
    const access = await resolveEmailMailboxAccess({ userId: session.user.id, accountId: body.accountId, mailboxWorkspaceId: body.mailboxWorkspaceId, operation: 'read' });
    const data = await listEmailMessages(access.accountOwnerId, { ...body, accountId: access.accountId }, {
      ...access.readOptions,
      prefetchDetails: true,
      scheduleBackgroundTask: after,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof EmailMailboxAccessError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Failed to list email messages';
    return NextResponse.json({ success: false, error: message, ...(error instanceof EmailSearchQueryError ? { code: error.code } : {}) }, { status: error instanceof EmailSearchQueryError ? 400 : 500 });
  }
}
