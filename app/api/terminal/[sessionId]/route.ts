import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getTerminalClient } from '@/app/lib/terminal-client';

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

  try {
    const client = getTerminalClient();
    await client.terminate(sessionId);
    return NextResponse.json({ success: true, closed: true });
  } catch (error: any) {
    console.error('[Terminal API] Delete error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
