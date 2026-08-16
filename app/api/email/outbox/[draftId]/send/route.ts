import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { sendPersonalOutboxDraft } from '@/app/lib/email/workspace-inbox-outbox';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest, context: { params: Promise<{ draftId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 10, windowMs: 60_000, keyPrefix: 'personal-outbox-send' });
  if (!limited.ok) return limited.response;
  try {
    const { draftId } = await context.params;
    const body = await request.json().catch(() => ({})) as { expectedVersion?: unknown };
    const expectedVersion = Number(body.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error('A current outbox draft version is required.');
    return NextResponse.json({ success: true, data: await sendPersonalOutboxDraft({ userId: session.user.id, draftId, expectedVersion }) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Failed to send outbox draft.' }, { status: 409 });
  }
}
