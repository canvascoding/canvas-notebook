import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { assertUserOrganizationAdmin } from '@/app/lib/organization/permissions';
import { readMcpConfig } from '@/app/lib/mcp/config';
import { hashMcpServerConfig, readCachedTools } from '@/app/lib/mcp/manager';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireMcpAdmin(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    await assertUserOrganizationAdmin(session.user.id, 'Only organization admins can inspect MCP servers.');
    return session;
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Forbidden' }, { status: 403 });
  }
}

export async function GET(request: NextRequest) {
  const session = await requireMcpAdmin(request);
  if (session instanceof NextResponse) return session;

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

    const scope = { userId: session.user.id };
    const config = await readMcpConfig(scope);
    const serverConfig = config.mcpServers[serverName];
    if (!serverConfig) {
      return NextResponse.json({ success: false, error: `Unknown MCP server "${serverName}".` }, { status: 404 });
    }

    const configHash = hashMcpServerConfig(serverConfig);
    const tools = await readCachedTools(serverName, configHash, scope);

    return NextResponse.json({
      success: true,
      data: {
        server: serverName,
        cached: Boolean(tools),
        tools: tools || [],
      },
    });
  } catch (error) {
    console.error('[API] integrations/mcp-tools GET error:', error);
    const message = error instanceof Error ? error.message : 'Failed to read MCP tools';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
