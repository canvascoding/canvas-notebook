import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { rejectPersonalOutboxDraft } from '@/app/lib/email/workspace-inbox-outbox';

export async function POST(request: NextRequest, context: { params: Promise<{ draftId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  try {
    const { draftId } = await context.params;
    const body = await request.json() as { expectedVersion?: unknown };
    const expectedVersion = Number(body?.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error('A current outbox draft version is required.');
    const data = await rejectPersonalOutboxDraft({ userId: session.user.id, draftId, expectedVersion });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unable to reject outbox draft.' }, { status: 409 });
  }
}
