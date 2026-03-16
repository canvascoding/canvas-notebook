/**
 * POST /api/terminal/create
 * Erstellt eine neue Terminal-Session
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getTerminalClient } from '@/app/lib/terminal-client';
import path from 'path';

export async function POST(request: NextRequest) {
  try {
    // Auth check
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { sessionId, cwd } = body;

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Missing sessionId' },
        { status: 400 }
      );
    }

    const ownerId = String(session.user.id || session.user.email || 'anonymous');
    const workspaceDir = process.env.WORKSPACE_DIR || path.resolve(process.cwd(), 'data', 'workspace');
    const finalCwd = cwd && path.isAbsolute(cwd) ? cwd : workspaceDir;

    const client = getTerminalClient();
    const result = await client.createSession(sessionId, ownerId, finalCwd);

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error('[Terminal API] Create error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
