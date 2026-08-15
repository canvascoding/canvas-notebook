import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { listWorkspaceOutboxDrafts } from '@/app/lib/email/workspace-inbox-outbox';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  try {
    const { id } = await context.params;
    return NextResponse.json({ success: true, data: await listWorkspaceOutboxDrafts(session.user.id, id) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Failed to load workspace outbox.' }, { status: 403 });
  }
}
