import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { McpAccessError, mcpErrorStatus, requireMcpUserAccess } from '@/app/lib/mcp/access';
import { isMcpAppsEnabled, mcpAppOrigins } from '@/app/lib/mcp/apps-config';
import { issueMcpAppTicket, parseMcpAppDescriptor, requireMcpAppChatAccess, requireSharedMcpAppCallTicket } from '@/app/lib/mcp/apps-host';
import { callMcpAppTool } from '@/app/lib/mcp/manager';
import { mcpReconnectDetails } from '@/app/lib/mcp/connection-health';
import { readBoundedWidgetJson } from '@/app/lib/tool-apps/request';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  return readBoundedWidgetJson(request);
}

export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!isMcpAppsEnabled()) return NextResponse.json({ success: false, error: 'MCP apps are disabled.' }, { status: 404, headers });
  let connectionId: string | undefined;
  let userId: string | undefined;
  try {
    if (request.headers.get('origin') !== mcpAppOrigins().appOrigin) throw new McpAccessError('Cross-origin app access is not allowed.', 403);
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new McpAccessError('Sign in to use MCP apps.', 401);
    userId = session.user.id;
    await requireMcpUserAccess({ userId });
    const body = await boundedJson(request);
    const app = parseMcpAppDescriptor(body.app);
    connectionId = app.version === 1 ? app.connectionId : undefined;
    const chat = { userId, sessionId: typeof body.sessionId === 'string' ? body.sessionId : '', agentId: typeof body.agentId === 'string' ? body.agentId : '' };
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    if (body.action === 'render') {
      const data = await issueMcpAppTicket({ ...chat, app, authSessionId: session.session.id, authSessionExpiresAt: session.session.expiresAt, signal });
      return NextResponse.json({ success: true, data }, { headers });
    }
    if (body.action !== 'call' || typeof body.tool !== 'string' || !body.tool || body.tool.length > 256
      || (body.arguments !== undefined && (!body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments)))) {
      throw new McpAccessError('Invalid MCP app action.', 400);
    }
    if (app.version === 2) {
      const input = { ...chat, app, ticket: body.ticket, authSessionId: session.session.id };
      const access = await requireSharedMcpAppCallTicket(input, body.tool, signal);
      const result = await callMcpAppTool(access.connectionId, app.toolName, app.resourceUri, body.tool,
        (body.arguments ?? {}) as Record<string, unknown>, signal, access.scope,
        { expectedEnvironmentRevision: access.environmentRevision,
          beforeDispatch: async () => { await requireSharedMcpAppCallTicket(input, body.tool as string, signal); } });
      await recordAuditEvent({ userId, sessionId: chat.sessionId, agentId: chat.agentId, workspaceId: access.workspaceId,
        organizationId: access.scope.shared!.ownership.organizationId, source: 'mcp_app', eventType: 'integration',
        entityType: 'integration_connection', entityId: app.connectionRef, action: 'mcp_app.call',
        status: result.isError ? 'error' : 'completed', summary: 'User-approved shared MCP app action returned.',
        metadata: { connectionRef: app.connectionRef, sourceTool: app.toolName, tool: body.tool, toolCallId: app.toolCallId } }).catch(() => null);
      try { await requireSharedMcpAppCallTicket(input, body.tool, signal); }
      catch { throw new McpAccessError('The app session changed after dispatch. The action may have executed; do not repeat it automatically.', 409); }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 2 * 1024 * 1024) {
        throw new McpAccessError('The app result is too large. The action may have executed; do not repeat it automatically.', 422);
      }
      return NextResponse.json({ success: true, data: result }, { headers });
    }
    await requireMcpAppChatAccess(chat);
    const result = await callMcpAppTool(app.connectionId, app.toolName, app.resourceUri, body.tool,
      (body.arguments ?? {}) as Record<string, unknown>, signal, { userId });
    return NextResponse.json({ success: true, data: result }, { headers });
  } catch (error) {
    const reconnect = connectionId && userId
      ? await mcpReconnectDetails(connectionId, { userId }, error).catch(() => ({})) : {};
    return NextResponse.json({ success: false, error: error instanceof McpAccessError ? error.message : 'MCP app is unavailable.', ...reconnect }, {
      status: (error as { code?: unknown } | null)?.code === 'invalid_arguments' ? 400 : mcpErrorStatus(error), headers,
    });
  }
}
