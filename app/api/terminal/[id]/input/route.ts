/**
 * POST /api/terminal/[id]/input
 * Sendet Input an eine Terminal-Session
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
    const { data } = body;

    if (!data) {
      return NextResponse.json(
        { error: 'Missing data' },
        { status: 400 }
      );
    }

    const client = getTerminalClient();
    await client.sendInput(sessionId, data);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('[Terminal API] Input error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
