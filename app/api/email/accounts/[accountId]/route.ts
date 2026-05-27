import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { managedEmailRequest } from '@/app/lib/email/managed-client';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return null;
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ accountId: string }> }) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'email-account-delete' });
  if (!limited.ok) return limited.response;
  try {
    const { accountId } = await params;
    const data = await managedEmailRequest(`/v1/managed/email/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to disconnect email account';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

