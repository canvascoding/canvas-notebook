/**
 * POST /api/terminal/[id]/resize
 * Ändert die Größe einer Terminal-Session
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getTerminalClient } from '@/app/lib/terminal-client';

export async function POST(
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
    const body = await request.json();
    const { cols, rows } = body;

    if (typeof cols !== 'number' || typeof rows !== 'number') {
      return NextResponse.json(
        { error: 'Missing cols or rows' },
        { status: 400 }
      );
    }

    const ownerId = String(session.user.id || session.user.email || 'anonymous');
    const client = getTerminalClient();
    await client.resize(sessionId, ownerId, cols, rows);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('[Terminal API] Resize error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
