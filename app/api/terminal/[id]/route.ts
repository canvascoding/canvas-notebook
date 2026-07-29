/**
 * DELETE /api/terminal/[id]
 * Beendet eine Terminal-Session
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getTerminalClient } from '@/app/lib/terminal-client';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Auth check
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const { id: sessionId } = await params;
    const ownerId = String(session.user.id || session.user.email || 'anonymous');

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Missing sessionId' },
        { status: 400 }
      );
    }

    const client = getTerminalClient();
    await client.terminate(sessionId, ownerId);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('[Terminal API] Delete error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
