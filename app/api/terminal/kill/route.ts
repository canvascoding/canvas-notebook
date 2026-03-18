import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getTerminalClient } from '@/app/lib/terminal-client';

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const ownerId = String(session.user.id || session.user.email || 'anonymous');
    const client = getTerminalClient();
    const result = await client.terminateAll(ownerId) as { success: boolean; closed?: number };

    return NextResponse.json({
      success: Boolean(result?.success),
      closed: typeof result?.closed === 'number' ? result.closed : 0,
    });
  } catch (error: unknown) {
    console.error('[Terminal API] Kill all error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}
