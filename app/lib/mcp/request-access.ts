import 'server-only';

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { McpAccessError, mcpErrorStatus, requireMcpUserAccess, type McpActor } from './access';

/** Resolves an authenticated, active MCP actor with one consistent API error shape. */
export async function requireMcpRequestActor(request: NextRequest): Promise<McpActor | NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  try {
    const actor = await requireMcpUserAccess({ userId: session.user.id });
    if (!actor) throw new McpAccessError('Sign in to use MCP connections.', 401);
    return actor;
  } catch (error) {
    if (error instanceof McpAccessError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: mcpErrorStatus(error, 403) });
    }
    console.error('[MCP request access] failed:', error);
    return NextResponse.json({ success: false, error: 'Unable to verify MCP access' }, { status: mcpErrorStatus(error, 500) });
  }
}
