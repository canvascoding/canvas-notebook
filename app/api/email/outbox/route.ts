import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { listPersonalOutboxDrafts } from '@/app/lib/email/workspace-inbox-outbox';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ success: true, data: await listPersonalOutboxDrafts(session.user.id) });
}
