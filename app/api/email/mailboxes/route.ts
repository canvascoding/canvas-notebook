import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { EmailMailboxAccessError, listEmailMailboxes } from '@/app/lib/email/mailbox-access';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'email-mailboxes' });
  if (!limited.ok) return limited.response;
  try {
    return NextResponse.json({ success: true, data: await listEmailMailboxes(session.user.id) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unable to load mailboxes.' }, { status: error instanceof EmailMailboxAccessError ? error.status : 500 });
  }
}
