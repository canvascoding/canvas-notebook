import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { listEmailAccounts } from '@/app/lib/email/service';
import { listInactivePersonalEmailAccounts } from '@/app/lib/email/account-store';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'email-accounts-get' });
  if (!limited.ok) return limited.response;
  try {
    const data = await listEmailAccounts(session.user.id);
    if (request.nextUrl.searchParams.get('includeInactive') === '1') {
      const inactive = await listInactivePersonalEmailAccounts(session.user.id);
      const listed = new Set(data.accounts.map(account => (account as { id?: string } | null)?.id));
      data.accounts.push(...inactive.filter(account => !listed.has(account.id)));
    }
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load email accounts';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
