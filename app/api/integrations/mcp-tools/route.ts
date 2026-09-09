import { NextRequest, NextResponse } from 'next/server';

import { assertMcpConnectionAccess, McpAccessError, mcpErrorStatus } from '@/app/lib/mcp/access';
import { requireMcpRequestActor } from '@/app/lib/mcp/request-access';
import { hashMcpServerConfig, readCachedTools } from '@/app/lib/mcp/manager';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(request: NextRequest) {
  const actor = await requireMcpRequestActor(request);
  if (actor instanceof NextResponse) return actor;

  try {
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'integrations-mcp-tools',
    });
    if (!limited.ok) return limited.response;

    const serverName = request.nextUrl.searchParams.get('server')?.trim() || '';
    if (!serverName) {
      return NextResponse.json({ success: false, error: 'MCP server is required' }, { status: 400 });
    }

    const scope = { userId: actor.userId };
    const { serverName: resolvedServerName, connection: serverConfig } = await assertMcpConnectionAccess(serverName, scope, { actor });

    const configHash = hashMcpServerConfig(serverConfig);
    const tools = await readCachedTools(resolvedServerName, configHash, scope);

    return NextResponse.json({
      success: true,
      data: {
        server: resolvedServerName,
        cached: Boolean(tools),
        tools: tools || [],
      },
    });
  } catch (error) {
    if (error instanceof McpAccessError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: mcpErrorStatus(error) });
    console.error('[API] integrations/mcp-tools GET error:', error);
    const message = error instanceof Error ? error.message : 'Failed to read MCP tools';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
