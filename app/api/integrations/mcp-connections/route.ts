import { NextRequest, NextResponse } from 'next/server';

import { McpAccessError, mcpErrorStatus } from '@/app/lib/mcp/access';
import { requireMcpRequestActor } from '@/app/lib/mcp/request-access';
import { createPersonalMcpConnection, removePersonalMcpConnection, renamePersonalMcpConnection } from '@/app/lib/mcp/personal-connections';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type ConnectionAction = 'connect' | 'rename' | 'remove';

type ConnectionPayload = {
  action?: ConnectionAction;
  definitionId?: string;
  connectionId?: string;
  displayName?: string;
};

export async function POST(request: NextRequest) {
  const actor = await requireMcpRequestActor(request);
  if (actor instanceof NextResponse) return actor;
  try {
    const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'integrations-mcp-connections-post' });
    if (!limited.ok) return limited.response;
    const payload = await request.json().catch(() => ({})) as ConnectionPayload;
    if (payload.action === 'connect') {
      if (typeof payload.definitionId !== 'string' || typeof payload.displayName !== 'string') return NextResponse.json({ success: false, error: 'Definition ID and account label are required' }, { status: 400 });
      const data = await createPersonalMcpConnection(actor.userId, payload.definitionId, payload.displayName);
      return NextResponse.json({ success: true, data });
    }
    if (payload.action === 'rename') {
      if (typeof payload.connectionId !== 'string' || typeof payload.displayName !== 'string') return NextResponse.json({ success: false, error: 'Connection ID and account label are required' }, { status: 400 });
      const data = await renamePersonalMcpConnection(actor.userId, payload.connectionId, payload.displayName);
      return NextResponse.json({ success: true, data });
    }
    if (payload.action === 'remove') {
      if (typeof payload.connectionId !== 'string') return NextResponse.json({ success: false, error: 'Connection ID is required' }, { status: 400 });
      const data = await removePersonalMcpConnection(actor.userId, payload.connectionId);
      return NextResponse.json({ success: true, data });
    }
    return NextResponse.json({ success: false, error: 'Unsupported MCP connection action' }, { status: 400 });
  } catch (error) {
    if (error instanceof McpAccessError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: mcpErrorStatus(error) });
    console.error('[API] integrations/mcp-connections POST error:', error);
    return NextResponse.json({ success: false, error: 'Failed to update MCP connection', ...(typeof (error as { code?: unknown })?.code === 'string' ? { code: (error as { code: string }).code } : {}) }, { status: mcpErrorStatus(error, 500) });
  }
}
