import { NextRequest, NextResponse } from 'next/server';

import { assertMcpConnectionAccess, McpAccessError, mcpErrorStatus } from '@/app/lib/mcp/access';
import { requireMcpRequestActor } from '@/app/lib/mcp/request-access';
import { readMcpServerIconFile } from '@/app/lib/mcp/icons';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ server: string }> },
) {
  const actor = await requireMcpRequestActor(request);
  if (actor instanceof NextResponse) return actor;

  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: 'integrations-mcp-icon',
  });
  if (!limited.ok) return limited.response;

  const { server } = await context.params;
  const serverName = decodeURIComponent(server || '').trim();
  if (!serverName) {
    return NextResponse.json({ success: false, error: 'MCP server is required' }, { status: 400 });
  }

  try {
    const scope = { userId: actor.userId };
    const { serverName: resolvedServerName } = await assertMcpConnectionAccess(serverName, scope, { actor });
    const icon = await readMcpServerIconFile(resolvedServerName, scope);
    if (!icon) {
      return NextResponse.json({ success: false, error: 'MCP icon not found' }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(icon.buffer), {
      headers: {
        'Content-Type': icon.contentType,
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch (error) {
    if (error instanceof McpAccessError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: mcpErrorStatus(error) });
    console.error('[API] integrations/mcp-icon GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to read MCP icon' }, { status: 500 });
  }
}
