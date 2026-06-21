/**
 * POST /api/terminal/create
 * Erstellt eine neue Terminal-Session
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getTerminalClient } from '@/app/lib/terminal-client';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';

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
    const { sessionId, workspaceId } = body;

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Missing sessionId' },
        { status: 400 }
      );
    }

    let workspaceRoot: string;
    try {
      const workspace = await resolveAgentSessionWorkspaceForUser({
        userId: session.user.id,
        workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
        permissions: ['canRead', 'canWrite'],
      });
      workspaceRoot = workspace.rootPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Workspace not found or inaccessible';
      return NextResponse.json(
        { error: message },
        { status: message.includes('not found') || message.includes('inaccessible') ? 404 : 403 }
      );
    }

    const ownerId = String(session.user.id || session.user.email || 'anonymous');

    const client = getTerminalClient();
    const result = await client.createSession(sessionId, ownerId, workspaceRoot);

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
