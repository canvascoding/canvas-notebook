import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { McpConfigValidationError, setMcpServerEnabled } from '@/app/lib/mcp/config';
import { buildDirectMcpTools } from '@/app/lib/mcp/direct-tools';
import { refreshMcpServerIcons } from '@/app/lib/mcp/icons';
import { closeMcpServer, getMcpRuntimeStatus, listMcpTools } from '@/app/lib/mcp/manager';
import { clearMcpOAuth, getMcpOAuthStatus, startMcpOAuth } from '@/app/lib/mcp/oauth';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type McpStatusAction = 'enable' | 'disable' | 'test' | 'authorize' | 'clear_auth';

type McpStatusPostPayload = {
  action?: McpStatusAction;
  server?: string;
};

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  try {
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'integrations-mcp-status',
    });
    if (!limited.ok) return limited.response;

    const runtime = await getMcpRuntimeStatus();
    const [oauth, direct, icons] = await Promise.all([
      Promise.all(runtime.servers.map((server) => getMcpOAuthStatus(server.name))),
      buildDirectMcpTools(),
      refreshMcpServerIcons(),
    ]);
    return NextResponse.json({
      success: true,
      data: {
        ...runtime,
        servers: runtime.servers.map((server) => ({
          ...server,
          iconUrl: icons[server.name]?.fileName ? `/api/integrations/mcp-icon/${encodeURIComponent(server.name)}` : null,
        })),
        oauth,
        directTools: direct.tools.map((tool) => ({
          name: tool.name,
          label: tool.label,
          description: tool.description,
        })),
        warnings: direct.warnings,
      },
    });
  } catch (error) {
    console.error('[API] integrations/mcp-status GET error:', error);
    const message = error instanceof Error ? error.message : 'Failed to read MCP status';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  try {
    const limited = rateLimit(request, {
      limit: 30,
      windowMs: 60_000,
      keyPrefix: 'integrations-mcp-status-post',
    });
    if (!limited.ok) return limited.response;

    const payload = (await request.json().catch(() => ({}))) as McpStatusPostPayload;
    const server = typeof payload.server === 'string' ? payload.server.trim() : '';
    if (!server) {
      return NextResponse.json({ success: false, error: 'MCP server is required' }, { status: 400 });
    }

    if (payload.action === 'enable') {
      await setMcpServerEnabled(server, true);
      return NextResponse.json({ success: true, data: { server, enabled: true } });
    }

    if (payload.action === 'disable') {
      await setMcpServerEnabled(server, false);
      await closeMcpServer(server);
      return NextResponse.json({ success: true, data: { server, enabled: false } });
    }

    if (payload.action === 'test') {
      const tools = await listMcpTools(server);
      return NextResponse.json({ success: true, data: { server, toolCount: tools.length } });
    }

    if (payload.action === 'authorize') {
      const started = await startMcpOAuth(server, request.headers.get('origin'));
      return NextResponse.json({ success: true, data: { server, ...started } });
    }

    if (payload.action === 'clear_auth') {
      await clearMcpOAuth(server);
      await closeMcpServer(server);
      return NextResponse.json({ success: true, data: { server, authorized: false } });
    }

    return NextResponse.json({ success: false, error: 'Unsupported MCP status action' }, { status: 400 });
  } catch (error) {
    if (error instanceof McpConfigValidationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    console.error('[API] integrations/mcp-status POST error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update MCP status';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
