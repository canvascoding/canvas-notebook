import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import {
  disconnectDirectMcpConnection,
  listDirectMcpConnections,
} from '@/app/lib/mcp/server/connection-management';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'cache-control': 'no-store' };

function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { success: false, code: 'MCP_CONNECTIONS_UNAVAILABLE', error: 'MCP connections are temporarily unavailable.' },
    { status: 503, headers: NO_STORE_HEADERS },
  );
}

async function requireUser(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401, headers: NO_STORE_HEADERS },
      ),
    };
  }
  return { ok: true as const, userId: session.user.id };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await requireUser(request);
  if (!user.ok) return user.response;

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'integrations-mcp-server-connections-list',
  });
  if (!limited.ok) return limited.response;

  try {
    const connections = await listDirectMcpConnections(user.userId);
    return NextResponse.json({ success: true, data: { connections } }, { headers: NO_STORE_HEADERS });
  } catch {
    return unavailableResponse();
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const user = await requireUser(request);
  if (!user.ok) return user.response;

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'integrations-mcp-server-connections-disconnect',
  });
  if (!limited.ok) return limited.response;

  let connectionId: string | null = null;
  try {
    const payload = await request.json() as { connectionId?: unknown };
    connectionId = typeof payload.connectionId === 'string' ? payload.connectionId : null;
  } catch {
    // A malformed body is not a service outage and can be reported precisely.
  }
  if (!connectionId || connectionId.length > 2048) {
    return NextResponse.json(
      { success: false, error: 'A valid MCP connection is required.' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const result = await disconnectDirectMcpConnection(user.userId, connectionId);
    if (result.status === 'not_found') {
      return NextResponse.json(
        { success: false, error: 'MCP connection not found.' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    await recordAuditEvent({
      userId: user.userId,
      source: 'direct_mcp',
      eventType: 'oauth_grant',
      entityType: 'mcp_connection',
      entityId: 'direct',
      action: 'direct_mcp.connection.disconnect',
      status: 'success',
      summary: 'Direct MCP connection disconnected by the signed-in user.',
      metadata: { origin: 'user_settings' },
    });
    return NextResponse.json({ success: true }, { headers: NO_STORE_HEADERS });
  } catch {
    return unavailableResponse();
  }
}
