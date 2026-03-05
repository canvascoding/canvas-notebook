import { NextRequest, NextResponse } from 'next/server';
import { terminateSession } from '@/server/terminal-manager';
import { auth } from '@/app/lib/auth';

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { sessionId } = await context.params;
  if (!sessionId) {
    return NextResponse.json({ success: false, error: 'Session id is required' }, { status: 400 });
  }

  const result = terminateSession(sessionId);
  return NextResponse.json({ success: true, closed: result.closed });
}
