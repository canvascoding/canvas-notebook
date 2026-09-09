import { NextRequest, NextResponse } from 'next/server';

import { assertMcpConnectionAccess, McpAccessError, mcpErrorStatus } from '@/app/lib/mcp/access';
import { requireMcpRequestActor } from '@/app/lib/mcp/request-access';
import { McpConfigValidationError, setMcpServerEnabled } from '@/app/lib/mcp/config';
import { buildDirectMcpTools } from '@/app/lib/mcp/direct-tools';
import { readCachedMcpServerIcons } from '@/app/lib/mcp/icons';
import { closeMcpServer, getMcpRuntimeStatus, listMcpTools } from '@/app/lib/mcp/manager';
import { clearMcpOAuth, getMcpOAuthStatus, startMcpOAuth, McpOAuthError } from '@/app/lib/mcp/oauth';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type McpStatusAction = 'enable' | 'disable' | 'test' | 'authorize' | 'clear_auth';

type McpStatusPostPayload = {
  action?: McpStatusAction;
  server?: string;
};

function getRequestOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const proto = (forwardedProto || request.nextUrl.protocol.replace(/:$/u, '') || 'http').split(',')[0];
  const host = forwardedHost || request.headers.get('host');
  if (host) return `${proto}://${host.split(',')[0]}`;
  return request.nextUrl.origin;
}

export async function GET(request: NextRequest) {
  const actor = await requireMcpRequestActor(request);
  if (actor instanceof NextResponse) return actor;

  try {
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'integrations-mcp-status',
    });
    if (!limited.ok) return limited.response;

    const summaryOnly = request.nextUrl.searchParams.get('summary') === '1';
    const scope = { userId: actor.userId };
    const runtime = await getMcpRuntimeStatus(undefined, scope);
    if (summaryOnly) {
      return NextResponse.json({
        success: true,
        data: { ...runtime, canManageDefinitions: actor.canManageDefinitions },
      });
    }

    const availableServers = runtime.servers.filter((server) => server.accessAllowed !== false);
    const [oauth, direct, icons] = await Promise.all([
      Promise.all(availableServers.map((server) => getMcpOAuthStatus(server.name, getRequestOrigin(request), scope))),
      buildDirectMcpTools(scope, { cacheOnly: true }),
      readCachedMcpServerIcons(scope),
    ]);
    return NextResponse.json({
      success: true,
      data: {
        ...runtime,
        canManageDefinitions: actor.canManageDefinitions,
        servers: runtime.servers.map((server) => ({
          ...server,
          iconUrl: server.accessAllowed !== false && icons[server.name]?.fileName ? `/api/integrations/mcp-icon/${encodeURIComponent(server.name)}` : null,
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
    if (error instanceof McpAccessError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: mcpErrorStatus(error) });
    console.error('[API] integrations/mcp-status GET error:', error);
    const message = error instanceof Error ? error.message : 'Failed to read MCP status';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const actor = await requireMcpRequestActor(request);
  if (actor instanceof NextResponse) return actor;

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

    const scope = { userId: actor.userId };
    const isManagementAction = payload.action === 'disable' || payload.action === 'clear_auth';
    const { serverName } = await assertMcpConnectionAccess(server, scope, {
      allowDisabled: payload.action === 'enable' || isManagementAction,
      management: isManagementAction,
      actor,
    });

    if (payload.action === 'enable') {
      await setMcpServerEnabled(serverName, true, scope);
      return NextResponse.json({ success: true, data: { server: serverName, enabled: true } });
    }

    if (payload.action === 'disable') {
      await setMcpServerEnabled(serverName, false, scope);
      await closeMcpServer(serverName, scope);
      return NextResponse.json({ success: true, data: { server: serverName, enabled: false } });
    }

    if (payload.action === 'test') {
      const tools = await listMcpTools(serverName, { scope });
      return NextResponse.json({ success: true, data: { server: serverName, toolCount: tools.length } });
    }

    if (payload.action === 'authorize') {
      const started = await startMcpOAuth(serverName, request.headers.get('origin'), scope);
      return NextResponse.json({ success: true, data: { server: serverName, ...started } });
    }

    if (payload.action === 'clear_auth') {
      await clearMcpOAuth(serverName, scope);
      await closeMcpServer(serverName, scope);
      return NextResponse.json({ success: true, data: { server: serverName, authorized: false } });
    }

    return NextResponse.json({ success: false, error: 'Unsupported MCP status action' }, { status: 400 });
  } catch (error) {
    if (error instanceof McpAccessError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: mcpErrorStatus(error) });
    if (error instanceof McpConfigValidationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    if (error instanceof McpOAuthError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status || 400 });
    }

    console.error('[API] integrations/mcp-status POST error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update MCP status';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
