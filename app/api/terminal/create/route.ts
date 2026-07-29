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
    const dataDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.DATA || 'data');
    const workspaceDir = path.join(dataDir, 'workspace');
    const requestedCwd = typeof cwd === 'string' ? cwd.trim() : '';
    const resolvedCwd = requestedCwd
      ? (path.isAbsolute(requestedCwd)
        ? path.resolve(requestedCwd)
        : path.resolve(workspaceDir, requestedCwd))
      : workspaceDir;

    if (resolvedCwd !== workspaceDir && !resolvedCwd.startsWith(`${workspaceDir}${path.sep}`)) {
      return NextResponse.json(
        { error: 'Invalid cwd: outside workspace' },
        { status: 400 }
      );
    }

    const client = getTerminalClient();
    const result = await client.createSession(sessionId, ownerId, resolvedCwd);

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
