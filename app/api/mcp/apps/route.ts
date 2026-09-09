import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { McpAccessError, mcpErrorStatus, requireMcpUserAccess } from '@/app/lib/mcp/access';
import { isMcpAppsEnabled, mcpAppOrigins } from '@/app/lib/mcp/apps-config';
import { issueMcpAppTicket, parseMcpAppDescriptor, requireMcpAppChatAccess } from '@/app/lib/mcp/apps-host';
import { callMcpAppTool } from '@/app/lib/mcp/manager';
import { mcpReconnectDetails } from '@/app/lib/mcp/connection-health';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new McpAccessError('Expected JSON.', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new McpAccessError('Expected a request body.', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new McpAccessError('MCP app request is too large.', 413); }
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof McpAccessError) throw error;
    throw new McpAccessError('Invalid JSON.', 400);
  } finally { reader.releaseLock(); }
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
    connectionId = app.connectionId;
    const chat = { userId, sessionId: typeof body.sessionId === 'string' ? body.sessionId : '', agentId: typeof body.agentId === 'string' ? body.agentId : '' };
    if (body.action === 'render') {
      const data = await issueMcpAppTicket({ ...chat, app, authSessionId: session.session.id, authSessionExpiresAt: session.session.expiresAt });
      return NextResponse.json({ success: true, data }, { headers });
    }
    if (body.action !== 'call' || typeof body.tool !== 'string' || !body.tool || body.tool.length > 256
      || (body.arguments !== undefined && (!body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments)))) {
      throw new McpAccessError('Invalid MCP app action.', 400);
    }
    await requireMcpAppChatAccess(chat);
    const result = await callMcpAppTool(app.connectionId, app.toolName, app.resourceUri, body.tool,
      (body.arguments ?? {}) as Record<string, unknown>, AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]), { userId });
    return NextResponse.json({ success: true, data: result }, { headers });
  } catch (error) {
    const reconnect = connectionId && userId
      ? await mcpReconnectDetails(connectionId, { userId }, error).catch(() => ({})) : {};
    return NextResponse.json({ success: false, error: error instanceof McpAccessError ? error.message : 'MCP app is unavailable.', ...reconnect }, {
      status: mcpErrorStatus(error), headers,
    });
  }
}
